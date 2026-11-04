import { z } from "zod";
import { DurableReceiver, type InboxEntry } from "../relay/receiver.ts";
import type { SQLiteInbox } from "../relay/sqlite-inbox.ts";
import { DELIVERY_TTL_MS } from "../relay/contract.ts";
import { verifyTextRuntime } from "../text-task.ts";
import type { Run } from "../types.ts";
import { TextNatsJournal, type TextJournalEntry } from "./journal.ts";
import {
  TEXT_NATS_SCHEMA,
  assertWitness,
  canonical,
  commonPacket,
  defineRoute,
  digest,
  evidencePacket,
  evidenceSchema,
  executePacket,
  executeSchema,
  inspectSchema,
  keySchema,
  packetFrom,
  packetMessage,
  runSchema,
  safeRun,
  sameWitness,
  type ExecutePacket,
  type RequestPacket,
  type RecoverableTextRuntime,
  type TextRelayPort,
  type TextRoute,
  type TextTaskGate,
} from "./protocol.ts";

const timestamp = z.number().int().nonnegative().safe();
const recordSchema = z.strictObject({
  execute: executeSchema,
  state: z.enum(["ready", "prepared"]),
  run: runSchema.optional(),
  evidence: runSchema.optional(),
});
const querySchema = z.strictObject({ request: inspectSchema });
const replySchema = z.strictObject({
  execute: executeSchema,
  request: z.union([executeSchema, inspectSchema]),
  packet: evidenceSchema,
  firstAt: timestamp,
  state: z.enum(["pending", "sent", "expired"]),
});
type RecordData = z.infer<typeof recordSchema>;
type ReplyData = z.infer<typeof replySchema>;
const RUNS = "recipient_runs";
const QUERIES = "recipient_queries";
const REPLIES = "recipient_replies";
const REJECTED = "recipient_rejected";

export interface NatsTextRecipientOptions {
  route: TextRoute;
  transport: TextRelayPort;
  inbox: SQLiteInbox;
  journal: TextNatsJournal;
  gate: TextTaskGate;
  runtime: RecoverableTextRuntime;
  now?: () => number;
  runtimeTimeoutMs?: number;
}

export class NatsTextRecipient {
  readonly #route: TextRoute;
  readonly #transport: TextRelayPort;
  readonly #inbox: SQLiteInbox;
  readonly #receiver: DurableReceiver;
  readonly #journal: TextNatsJournal;
  readonly #gate: TextTaskGate;
  readonly #runtime: RecoverableTextRuntime;
  readonly #now: () => number;
  readonly #timeout: number;
  #closed = false;
  #inboxCursor = 0;
  readonly #active = new Set<Promise<unknown>>();
  readonly #cursors = new Map<string, string>();

  constructor(options: NatsTextRecipientOptions) {
    const { scope, ...input } = options.route;
    this.#route = defineRoute(input);
    this.#timeout = options.runtimeTimeoutMs ?? 1000;
    if (
      this.#route.scope !== scope ||
      options.transport.agentId !== this.#route.recipient ||
      !Number.isSafeInteger(this.#timeout) ||
      this.#timeout < 1 ||
      this.#timeout > 30000
    )
      throw Error("invalid_text_recipient_options");
    this.#transport = options.transport;
    this.#inbox = options.inbox;
    this.#receiver = new DurableReceiver(options.inbox, options.transport);
    this.#journal = options.journal;
    this.#gate = options.gate;
    this.#runtime = options.runtime;
    this.#now = options.now ?? Date.now;
  }

  #open(): void {
    if (this.#closed) throw Error("text_recipient_closed");
  }

  #operation<T>(work: () => Promise<T>): Promise<T> {
    if (this.#closed) return Promise.reject(Error("text_recipient_closed"));
    const result = Promise.resolve().then(() => {
      this.#open();
      return work();
    });
    this.#active.add(result);
    void result.finally(() => this.#active.delete(result)).catch(() => {});
    return result;
  }

  #time(): number {
    return timestamp.parse(this.#now());
  }

  #execute(value: unknown): ExecutePacket {
    const execute = executeSchema.parse(value);
    if (
      execute.route !== this.#route.id ||
      execute.scope !== this.#route.scope ||
      canonical(execute) !==
        canonical(executePacket(this.#route, execute.input, execute.acceptedAt))
    )
      throw Error("text_recipient_record_conflict");
    return execute;
  }

  #record(entry: TextJournalEntry): RecordData {
    const record = recordSchema.parse(entry.data);
    this.#execute(record.execute);
    if (
      entry.id !== record.execute.key ||
      (record.run &&
        canonical(record.run) !== canonical(safeRun(record.run))) ||
      (record.evidence &&
        canonical(record.evidence) !== canonical(safeRun(record.evidence))) ||
      (record.state === "ready" && (record.run || record.evidence)) ||
      (record.evidence &&
        (!record.run ||
          canonical(this.#merge(record.evidence, record.run)) !==
            canonical(record.run)))
    )
      throw Error("text_recipient_record_conflict");
    return record;
  }

  #matches(execute: ExecutePacket, request: RequestPacket): boolean {
    const expected = { ...commonPacket(execute), requestId: request.requestId };
    return (
      canonical(commonPacket(request)) === canonical(expected) &&
      (request.type !== "execute" || canonical(request) === canonical(execute))
    );
  }

  #reply(entry: TextJournalEntry): ReplyData {
    const reply = replySchema.parse(entry.data);
    this.#execute(reply.execute);
    if (!this.#matches(reply.execute, reply.request))
      throw Error("text_recipient_request_conflict");
    const packet = reply.packet;
    if (
      entry.id !== packet.requestId ||
      (reply.request.type === "inspect") !== (packet.phase === "inspection") ||
      (packet.phase === "admission" && packet.run?.state !== "running") ||
      (packet.phase === "outcome" &&
        (!packet.run || packet.run.state === "running")) ||
      canonical(packet) !==
        canonical(
          evidencePacket(
            reply.request,
            packet.phase,
            packet.outcome === "known"
              ? packet.run
              : packet.outcome === "not_found"
                ? null
                : undefined,
          ),
        )
    )
      throw Error("text_recipient_reply_conflict");
    const execution = this.#journal.entry(RUNS, reply.execute.key);
    if (!execution) throw Error("text_recipient_request_missing");
    const record = this.#record(execution);
    if (
      canonical(record.execute) !== canonical(reply.execute) ||
      (packet.run && (!record.evidence || record.evidence.id !== packet.run.id))
    )
      throw Error("text_recipient_reply_conflict");
    if (packet.run && record.evidence) this.#merge(record.evidence, packet.run);
    packetMessage(packet, this.#route, reply.firstAt);
    return reply;
  }

  #merge(previous: Run | undefined, value: Run): Run {
    const run = safeRun(value);
    if (!previous) return run;
    if (previous.id !== run.id) throw Error("text_runtime_identity_conflict");
    if (previous.state === "running") return run;
    if (run.state === "running") return previous;
    if (canonical(previous) !== canonical(run))
      throw Error("text_runtime_terminal_conflict");
    return previous;
  }

  #privateRun(key: string, run: Run): Run {
    return this.#journal.transaction(() => {
      const entry = this.#journal.entry(RUNS, key);
      if (!entry) throw Error("text_recipient_request_missing");
      const record = this.#record(entry);
      if (record.state !== "prepared") throw Error("text_runtime_not_prepared");
      const current = this.#merge(record.run, run);
      if (
        !this.#journal.set(
          RUNS,
          key,
          { ...record, run: current },
          entry.version,
        )
      )
        throw Error("text_recipient_write_conflict");
      return current;
    });
  }

  #queue(
    execute: ExecutePacket,
    request: RequestPacket,
    run: Run | null | undefined,
  ): void {
    this.#journal.transaction(() => {
      const entry = this.#journal.entry(RUNS, execute.key);
      if (!entry) throw Error("text_recipient_request_missing");
      const record = this.#record(entry);
      const current =
        record.run && record.run.state !== "running"
          ? record.run
          : run
            ? this.#merge(record.run, run)
            : run;
      const phase =
        request.type === "inspect"
          ? "inspection"
          : current?.state === "running"
            ? "admission"
            : "outcome";
      if (request.type === "execute" && !current) return;
      const packet = evidencePacket(request, phase, current);
      const old = this.#journal.entry(REPLIES, packet.requestId);
      if (old) {
        this.#reply(old);
        return;
      }
      const next = current
        ? {
            ...record,
            run: current,
            evidence: this.#merge(record.evidence, current),
          }
        : record;
      if (!this.#journal.set(RUNS, execute.key, next, entry.version))
        throw Error("text_recipient_write_conflict");
      this.#journal.insert(REPLIES, packet.requestId, {
        execute,
        request,
        packet,
        firstAt: this.#time(),
        state: "pending",
      } satisfies ReplyData);
    });
  }

  #verifyRuntime(): void {
    verifyTextRuntime(this.#runtime, this.#route.runtimeBoundaryId);
    if (this.#runtime.retentionMs < this.#route.retentionMs)
      throw Error("text_runtime_retention_insufficient");
  }

  async #bounded(
    work: (signal: AbortSignal) => Promise<Run | null>,
  ): Promise<Run | null> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        Promise.resolve().then(() => work(controller.signal)),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(Error("text_runtime_timeout"));
          }, this.#timeout);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  async #lookup(record: RecordData): Promise<Run | null | undefined> {
    if (record.run && record.run.state !== "running") return record.run;
    if (this.#time() >= record.execute.acceptedAt + this.#route.retentionMs)
      return undefined;
    this.#verifyRuntime();
    const run = record.run;
    if (run) {
      const result = await this.#bounded((signal) =>
        this.#runtime.get(run.id, signal),
      );
      if (result && result.id !== run.id)
        throw Error("text_runtime_identity_conflict");
      return result ? safeRun(result) : null;
    }
    const lookup = this.#runtime.lookupText;
    if (!lookup) return undefined;
    const result = await this.#bounded((signal) =>
      lookup.call(this.#runtime, record.execute.key, signal),
    );
    return result ? safeRun(result) : result;
  }

  #quarantine(entry: InboxEntry, reason: string): void {
    this.#journal.insert(
      REJECTED,
      digest([entry.sender_id, entry.message.message_id]),
      { entry, reason },
    );
    if (this.#inbox.releaseBody(entry.sender_id, entry.message.message_id))
      throw Error(reason);
  }

  #adopt(): { key: string; query?: string } | null {
    const entries = this.#receiver.inbox();
    for (let visited = 0; visited < Math.min(128, entries.length); visited++) {
      const index = this.#inboxCursor % entries.length;
      const entry = entries[index];
      this.#inboxCursor = (index + 1) % entries.length;
      if (!entry.receipt_confirmed) continue;
      const part = entry.message.body.parts[0];
      if (
        entry.message.kind !== "generic_text_request" &&
        !(part?.type === "data" && part.schema_id === TEXT_NATS_SCHEMA)
      )
        continue;
      let request: RequestPacket;
      try {
        const packet = packetFrom(entry, this.#route, "request");
        if (packet.type === "evidence") throw Error("foreign_text_packet");
        request = packet;
      } catch (error) {
        const reason =
          error instanceof z.ZodError
            ? "invalid_text_packet"
            : error instanceof Error &&
                [
                  "foreign_text_packet",
                  "text_packet_conflict",
                  "text_request_conflict",
                ].includes(error.message)
              ? error.message
              : undefined;
        if (!reason) throw error;
        this.#quarantine(entry, reason);
        continue;
      }
      const conflict = this.#journal.transaction(() => {
        const old = this.#journal.entry(RUNS, request.key);
        if (request.type === "inspect" && !old) return null;
        if (old && !this.#matches(this.#record(old).execute, request))
          return true;
        if (request.type === "execute") {
          if (!old)
            this.#journal.insert(RUNS, request.key, {
              execute: request,
              state: "ready",
            } satisfies RecordData);
        } else {
          const query = this.#journal.entry(QUERIES, request.requestId);
          if (query) {
            const saved = querySchema.parse(query.data);
            if (query.id !== saved.request.requestId)
              throw Error("text_recipient_query_conflict");
            if (canonical(saved.request) !== canonical(request)) return true;
          } else this.#journal.insert(QUERIES, request.requestId, { request });
        }
        return false;
      });
      if (conflict === null) continue;
      if (conflict) {
        this.#quarantine(entry, "text_recipient_request_conflict");
        continue;
      }
      this.#inbox.releaseBody(entry.sender_id, entry.message.message_id);
      return {
        key: request.key,
        ...(request.type === "inspect" ? { query: request.requestId } : {}),
      };
    }
    return null;
  }

  receiveOnce(): Promise<void> {
    return this.#operation(() => this.#receiver.receiveOnce());
  }

  async #executeOne(key: string): Promise<boolean> {
    const entry = this.#journal.entry(RUNS, key);
    if (!entry) return false;
    const record = this.#record(entry);
    const request = record.execute;
    const before = await this.#gate.inspect(this.#route, key);
    const mode = record.state === "ready" ? "execute" : "observe";
    assertWitness(this.#route, request, before, mode);
    let run: Run | null | undefined;
    if (record.state === "ready") {
      this.#verifyRuntime();
      if (
        this.#time() >= request.input.replay.deadline ||
        this.#time() >= request.acceptedAt + DELIVERY_TTL_MS
      )
        throw Error("text_admission_expired");
      if (
        !this.#journal.set(
          RUNS,
          key,
          { ...record, state: "prepared" },
          entry.version,
        )
      )
        return false;
      run = await this.#bounded((signal) =>
        this.#runtime.createText!({
          ...request.input,
          replay: {
            ...request.input.replay,
            contract: this.#runtime.admissionContract!,
          },
          signal,
        }),
      );
      if (!run) throw Error("invalid_text_runtime_result");
    } else run = await this.#lookup(record);
    if (run) run = this.#privateRun(key, run);
    const after = await this.#gate.inspect(this.#route, key);
    assertWitness(this.#route, request, after, mode);
    sameWitness(before, after);
    this.#open();
    if (!run) return false;
    this.#queue(request, request, run);
    return true;
  }

  async #queryOne(entry: TextJournalEntry): Promise<boolean> {
    const { request } = querySchema.parse(entry.data);
    if (entry.id !== request.requestId)
      throw Error("text_recipient_query_conflict");
    const old = this.#journal.entry(
      REPLIES,
      evidencePacket(request, "inspection", undefined).requestId,
    );
    if (old) {
      this.#reply(old);
      return false;
    }
    const execution = this.#journal.entry(RUNS, request.key);
    if (!execution) return false;
    const record = this.#record(execution);
    if (!this.#matches(record.execute, request))
      throw Error("text_recipient_request_conflict");
    const before = await this.#gate.inspect(this.#route, request.key);
    assertWitness(this.#route, record.execute, before, "observe");
    let run =
      record.state === "prepared" ? await this.#lookup(record) : undefined;
    if (run) run = this.#privateRun(request.key, run);
    const after = await this.#gate.inspect(this.#route, request.key);
    assertWitness(this.#route, record.execute, after, "observe");
    sameWitness(before, after);
    this.#open();
    this.#queue(record.execute, request, run);
    return true;
  }

  #page(bucket: string): TextJournalEntry[] {
    const after = this.#cursors.get(bucket);
    const entries = this.#journal.list(bucket, 128, after);
    if (entries.length || !after) return entries;
    this.#cursors.delete(bucket);
    return this.#journal.list(bucket, 128);
  }

  executeOnce(): Promise<boolean> {
    return this.#operation(() => this.#executeOnce());
  }

  async #executeOnce(): Promise<boolean> {
    this.#open();
    const adopted = this.#adopt();
    if (adopted?.query)
      return this.#queryOne(this.#journal.entry(QUERIES, adopted.query)!);
    if (adopted) return this.#executeOne(adopted.key);
    for (const query of this.#page(QUERIES)) {
      this.#cursors.set(QUERIES, query.id);
      if (await this.#queryOne(query)) return true;
    }
    for (const entry of this.#page(RUNS)) {
      this.#cursors.set(RUNS, entry.id);
      const record = this.#record(entry);
      if (
        record.run &&
        record.run.state !== "running" &&
        this.#journal.entry(
          REPLIES,
          evidencePacket(record.execute, "outcome", record.run).requestId,
        )
      )
        continue;
      if (await this.#executeOne(entry.id)) return true;
    }
    return false;
  }

  sendOnce(): Promise<boolean> {
    return this.#operation(() => this.#sendOnce());
  }

  async #sendOnce(): Promise<boolean> {
    this.#open();
    for (const entry of this.#page(REPLIES)) {
      this.#cursors.set(REPLIES, entry.id);
      const reply = this.#reply(entry);
      if (reply.state !== "pending") continue;
      if (this.#time() >= reply.firstAt + DELIVERY_TTL_MS) {
        this.#journal.set(
          REPLIES,
          entry.id,
          { ...reply, state: "expired" },
          entry.version,
        );
        continue;
      }
      const before = await this.#gate.inspect(this.#route, reply.execute.key);
      assertWitness(this.#route, reply.execute, before, "observe");
      await this.#transport.submit(
        packetMessage(reply.packet, this.#route, reply.firstAt),
      );
      const after = await this.#gate.inspect(this.#route, reply.execute.key);
      assertWitness(this.#route, reply.execute, after, "observe");
      sameWitness(before, after);
      this.#open();
      this.#journal.set(
        REPLIES,
        entry.id,
        { ...reply, state: "sent" },
        entry.version,
      );
      return true;
    }
    return false;
  }

  inspect(key: string): unknown {
    this.#open();
    keySchema.parse(key);
    const entry = this.#journal.entry(RUNS, key);
    return entry ? this.#record(entry) : null;
  }

  async close(): Promise<void> {
    this.#closed = true;
    await Promise.allSettled([...this.#active]);
  }
}
