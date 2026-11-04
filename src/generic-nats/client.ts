import { z } from "zod";
import { DELIVERY_TTL_MS } from "../relay/contract.ts";
import type { Run, Runs } from "../types.ts";
import { DurableReceiver, type InboxEntry } from "../relay/receiver.ts";
import type { SQLiteInbox } from "../relay/sqlite-inbox.ts";
import { TextNatsJournal } from "./journal.ts";
import {
  TEXT_NATS_CONTRACT,
  TEXT_NATS_SCHEMA,
  assertWitness,
  canonical,
  defineRoute,
  evidencePacket,
  evidenceSchema,
  executePacket,
  executeSchema,
  handleFor,
  inspectPacket,
  inspectSchema,
  keySchema,
  packetFrom,
  packetMessage,
  sameWitness,
  type CreateTextInput,
  type EvidencePacket,
  type RequestPacket,
  type TextRelayPort,
  type TextRoute,
  type TextTaskGate,
} from "./protocol.ts";

const MAX_JOBS = 128;
const MAX_QUERIES = 32;
const querySchema = z.strictObject({
  packet: inspectSchema,
  firstAt: z.number().int().nonnegative().safe(),
  state: z.enum(["pending", "accepted", "answered", "expired"]),
});
const jobSchema = z.strictObject({
  request: executeSchema,
  delivery: z.enum(["pending", "accepted"]),
  queries: z.array(querySchema).max(MAX_QUERIES),
  evidence: evidenceSchema.optional(),
});
type Job = z.infer<typeof jobSchema>;
interface Options {
  routes: readonly TextRoute[];
  transport: TextRelayPort;
  inbox: SQLiteInbox;
  journal: TextNatsJournal;
  gate: TextTaskGate;
  now?: () => number;
}

export class NatsTextClient {
  readonly #routes = new Map<string, TextRoute>();
  readonly #transport: TextRelayPort;
  readonly #inbox: SQLiteInbox;
  readonly #receiver: DurableReceiver;
  readonly #journal: TextNatsJournal;
  readonly #gate: TextTaskGate;
  readonly #now: () => number;
  readonly #active = new Set<Promise<unknown>>();
  #closed = false;

  constructor(options: Options) {
    const peers = new Set<string>();
    const scopes = new Set<string>();
    if (
      !options.routes.length ||
      options.routes.length > MAX_JOBS ||
      options.inbox.agentId !== options.transport.agentId
    )
      throw Error("invalid_text_routes");
    for (const supplied of options.routes) {
      const { scope, ...input } = supplied;
      const route = defineRoute(input);
      if (
        scope !== route.scope ||
        route.coordinator !== options.transport.agentId ||
        this.#routes.has(route.id) ||
        peers.has(route.recipient) ||
        scopes.has(route.scope)
      )
        throw Error("invalid_text_routes");
      this.#routes.set(route.id, route);
      peers.add(route.recipient);
      scopes.add(route.scope);
    }
    this.#transport = options.transport;
    this.#inbox = options.inbox;
    this.#receiver = new DurableReceiver(options.inbox, options.transport);
    this.#journal = options.journal;
    this.#gate = options.gate;
    this.#now = options.now ?? Date.now;
  }

  #route(id: string): TextRoute {
    const route = this.#routes.get(id);
    if (!route) throw Error("unknown_text_route");
    return route;
  }

  #operation<T>(work: () => Promise<T>): Promise<T> {
    if (this.#closed) return Promise.reject(Error("text_client_closed"));
    const result = work();
    this.#active.add(result);
    void result.finally(() => this.#active.delete(result)).catch(() => {});
    return result;
  }

  #job(handle: string): { version: number; job: Job } {
    const row = this.#journal.entry("client_jobs", handle);
    if (!row) throw Error("unknown_text_handle");
    const job = jobSchema.parse(row.data);
    const route = this.#route(job.request.route);
    if (
      handle !== handleFor(route, job.request.key) ||
      canonical(job.request) !==
        canonical(
          executePacket(route, job.request.input, job.request.acceptedAt),
        )
    )
      throw Error("text_client_record_conflict");
    for (const [index, query] of job.queries.entries())
      if (
        canonical(query.packet) !==
        canonical(inspectPacket(job.request, index + 1))
      )
        throw Error("text_client_query_conflict");
    if (job.evidence) this.#correlate(job, job.evidence);
    return { version: row.version, job };
  }

  #run(job: Job): Run {
    const known = job.evidence?.run;
    return known
      ? {
          id: job.request.handle,
          state: known.state,
          ...(known.state === "succeeded" ? { text: known.text } : {}),
        }
      : { id: job.request.handle, state: "running" };
  }

  runs(routeId: string): Runs {
    if (this.#closed) throw Error("text_client_closed");
    const route = this.#route(routeId);
    return Object.freeze({
      boundaryId: route.boundaryId,
      supportedTaskTypes: ["generic_text"] as const,
      textBoundary: Object.freeze({
        version: 1 as const,
        inputAuthority: "external_agent" as const,
        effects: "none" as const,
        automaticReply: false as const,
      }),
      retentionMs: route.retentionMs,
      admissionContract: TEXT_NATS_CONTRACT,
      toolIsolationVerified: true,
      durableIdempotency: true,
      create: async () => {
        throw Error("text_fixed_execution_forbidden");
      },
      createText: (input: CreateTextInput) =>
        this.#operation(async () => {
          input.signal?.throwIfAborted();
          const before = await this.#gate.inspect(route, input.idempotencyKey);
          const request = executePacket(
            route,
            input,
            before.task.text_request?.acceptedAt ?? -1,
          );
          assertWitness(route, request, before, "prepare");
          const after = await this.#gate.inspect(route, request.key);
          assertWitness(route, request, after, "prepare");
          sameWitness(before, after);
          input.signal?.throwIfAborted();
          return this.#journal.transaction(() => {
            const old = this.#journal.entry("client_jobs", request.handle);
            if (old) {
              const { job } = this.#job(request.handle);
              if (canonical(job.request) !== canonical(request))
                throw Error("text_client_input_conflict");
              return this.#run(job);
            }
            if (this.#journal.list("client_jobs", MAX_JOBS).length >= MAX_JOBS)
              throw Error("text_client_capacity");
            const job: Job = { request, delivery: "pending", queries: [] };
            this.#journal.insert("client_jobs", request.handle, job);
            return this.#run(job);
          });
        }),
      get: (handle: string, signal?: AbortSignal) =>
        this.#operation(async () => {
          signal?.throwIfAborted();
          const { job } = this.#job(handle);
          if (job.request.route !== route.id)
            throw Error("foreign_text_handle");
          const before = await this.#gate.inspect(route, job.request.key);
          assertWitness(route, job.request, before, "observe");
          const after = await this.#gate.inspect(route, job.request.key);
          assertWitness(route, job.request, after, "observe");
          sameWitness(before, after);
          signal?.throwIfAborted();
          return this.#run(this.#job(handle).job);
        }),
    });
  }

  sendOnce(): Promise<boolean> {
    return this.#operation(async () => {
      let held: unknown;
      const records = this.#journal.list("client_jobs", MAX_JOBS);
      for (const type of ["inspect", "execute"] as const) {
        for (const row of records) {
          const { job } = this.#job(row.id);
          const query = job.queries.find(
            (item) =>
              item.state === "pending" &&
              this.#now() < item.firstAt + DELIVERY_TTL_MS,
          );
          if (
            (type === "inspect" && !query) ||
            (type === "execute" && job.delivery !== "pending")
          )
            continue;
          const route = this.#route(job.request.route);
          const packet = type === "inspect" ? query!.packet : job.request;
          const mode = type === "inspect" ? "observe" : "publish";
          let before;
          try {
            before = await this.#gate.inspect(route, job.request.key);
            assertWitness(route, job.request, before, mode);
          } catch (error) {
            held = error;
            continue;
          }
          await this.#transport.submit(
            packetMessage(
              packet,
              route,
              type === "inspect" ? query!.firstAt : job.request.acceptedAt,
            ),
          );
          const after = await this.#gate.inspect(route, job.request.key);
          assertWitness(route, job.request, after, mode);
          sameWitness(before, after);
          this.#journal.transaction(() => {
            const current = this.#job(row.id);
            if (type === "execute") current.job.delivery = "accepted";
            else {
              const pending = current.job.queries.find(
                (item) => item.packet.requestId === packet.requestId,
              );
              if (!pending) throw Error("text_client_query_conflict");
              if (pending.state === "pending") pending.state = "accepted";
            }
            if (
              !this.#journal.set(
                "client_jobs",
                row.id,
                current.job,
                current.version,
              )
            )
              throw Error("text_client_concurrent_update");
          });
          return true;
        }
      }
      if (held) throw held;
      return false;
    });
  }

  requestStatus(routeId: string, key: string): Promise<void> {
    return this.#operation(async () => {
      const route = this.#route(routeId);
      keySchema.parse(key);
      const handle = handleFor(route, key);
      const { job } = this.#job(handle);
      const before = await this.#gate.inspect(route, key);
      assertWitness(route, job.request, before, "observe");
      const after = await this.#gate.inspect(route, key);
      assertWitness(route, job.request, after, "observe");
      sameWitness(before, after);
      this.#journal.transaction(() => {
        const current = this.#job(handle);
        const pending = current.job.queries.find(
          (item) => item.state === "pending" || item.state === "accepted",
        );
        if (pending) {
          if (this.#now() < pending.firstAt + DELIVERY_TTL_MS) return;
          pending.state = "expired";
        }
        if (current.job.queries.length >= MAX_QUERIES)
          throw Error("text_client_query_capacity");
        const firstAt = this.#now();
        const packet = inspectPacket(
          current.job.request,
          current.job.queries.length + 1,
        );
        packetMessage(packet, route, firstAt);
        current.job.queries.push({ packet, firstAt, state: "pending" });
        if (
          !this.#journal.set(
            "client_jobs",
            handle,
            current.job,
            current.version,
          )
        )
          throw Error("text_client_concurrent_update");
      });
    });
  }

  #correlate(job: Job, packet: EvidencePacket): RequestPacket {
    const source =
      packet.replyTo === job.request.requestId
        ? job.request
        : job.queries.find((item) => item.packet.requestId === packet.replyTo)
            ?.packet;
    if (
      !source ||
      (source.type === "inspect") !== (packet.phase === "inspection") ||
      (packet.phase === "admission" && packet.run?.state !== "running") ||
      (packet.phase === "outcome" &&
        (!packet.run || packet.run.state === "running")) ||
      canonical(packet) !==
        canonical(
          evidencePacket(
            source,
            packet.phase,
            packet.outcome === "known"
              ? packet.run
              : packet.outcome === "not_found"
                ? null
                : undefined,
          ),
        )
    )
      throw Error("text_evidence_correlation_denied");
    return source;
  }

  async #adopt(entry: InboxEntry): Promise<void> {
    const part = entry.message.body.parts[0];
    if (part?.type !== "data" || part.schema_id !== TEXT_NATS_SCHEMA) return;
    const parsed = evidenceSchema.parse(part.value);
    const route = this.#route(parsed.route);
    const packet = packetFrom(entry, route, "evidence");
    if (packet.type !== "evidence") throw Error("foreign_text_packet");
    const { job } = this.#job(packet.handle);
    this.#correlate(job, packet);
    const before = await this.#gate.inspect(route, job.request.key);
    assertWitness(route, job.request, before, "observe");
    const after = await this.#gate.inspect(route, job.request.key);
    assertWitness(route, job.request, after, "observe");
    sameWitness(before, after);
    this.#journal.transaction(() => {
      const current = this.#job(packet.handle);
      this.#correlate(current.job, packet);
      const old = current.job.evidence?.run;
      if (old && packet.run && old.id !== packet.run.id)
        throw Error("text_runtime_identity_conflict");
      if (old && old.state !== "running") {
        if (
          packet.run &&
          packet.run.state !== "running" &&
          canonical(old) !== canonical(packet.run)
        )
          throw Error("text_terminal_evidence_conflict");
      } else if (packet.run) current.job.evidence = packet;
      const query = current.job.queries.find(
        (item) => item.packet.requestId === packet.replyTo,
      );
      if (query) query.state = "answered";
      if (
        !this.#journal.set(
          "client_jobs",
          packet.handle,
          current.job,
          current.version,
        )
      )
        throw Error("text_client_concurrent_update");
    });
    this.#inbox.releaseBody(entry.sender_id, entry.message.message_id);
  }

  receiveOnce(): Promise<void> {
    return this.#operation(async () => {
      await this.#receiver.receiveOnce();
      let count = 0;
      for (const entry of this.#inbox.inbox()) {
        if (!entry.receipt_confirmed) continue;
        const part = entry.message.body.parts[0];
        if (part?.type !== "data" || part.schema_id !== TEXT_NATS_SCHEMA)
          continue;
        await this.#adopt(entry);
        if (++count >= MAX_JOBS) break;
      }
    });
  }

  inspect(routeId: string, key: string): unknown {
    if (this.#closed) throw Error("text_client_closed");
    const route = this.#route(routeId);
    keySchema.parse(key);
    return structuredClone(this.#job(handleFor(route, key)).job);
  }

  async close(): Promise<void> {
    this.#closed = true;
    await Promise.allSettled([...this.#active]);
  }
}
