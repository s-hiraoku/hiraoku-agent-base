/** Owner-composed private HTTP MCP. No listener, credential issuance or native authentication. */
import { timingSafeEqual, randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createRecipientHostMcpServer } from "./mcp.ts";
import { createSingleSourceHost } from "./single-source-authority.ts";
import type { SQLiteAnswerJournal } from "../answer-intents/sqlite-journal.ts";

type Binding = Parameters<typeof createSingleSourceHost>[0] & {
  hostOptions: Parameters<typeof createSingleSourceHost>[0]["hostOptions"] & {
    answer_intents: SQLiteAnswerJournal;
  };
};
export type PrivateRecipientHttpOptions = {
  /** Independently authorized, exclusive launch credential. Never a native identity assertion. */
  bearerToken: string;
  /** Exact loopback HTTP authority, including port. Caller owns the loopback-only listener. */
  authority: string;
  lifetimeMs: number;
  shutdownTimeoutMs: number;
  /** Must abort when the authenticated launch owner is lost. Not a recipient-controlled signal. */
  ownerSignal: AbortSignal;
  maxInboxReadResultBytes?: number;
};

/**
 * Metadata-only discovery before bindVerified; no synthetic verified context or host exists then.
 * The owner MUST verify committed native session, exclusive launch credential/connection scope,
 * current generation and all participants before bindVerified. This API does not attest them.
 * Every instance is one finite launch generation; its credential must never be reused elsewhere.
 */
export function createPrivateRecipientHttp(options: PrivateRecipientHttpOptions) {
  if (!/^[A-Za-z0-9_-]{32,256}$/.test(options.bearerToken) ||
      !/^127\.0\.0\.1:[1-9][0-9]{0,4}$/.test(options.authority) ||
      Number(options.authority.split(":")[1]) > 65535 ||
      !Number.isSafeInteger(options.lifetimeMs) || options.lifetimeMs < 1 || options.lifetimeMs > 900000 ||
      !Number.isSafeInteger(options.shutdownTimeoutMs) || options.shutdownTimeoutMs < 1 || options.shutdownTimeoutMs > 60000 ||
      !options.ownerSignal || options.ownerSignal.aborted ||
      (options.maxInboxReadResultBytes !== undefined &&
       (!Number.isSafeInteger(options.maxInboxReadResultBytes) || options.maxInboxReadResultBytes < 1024)))
    throw Error("invalid_private_http_composition");
  const credential = Buffer.from(`Bearer ${options.bearerToken}`);
  const authority = options.authority, shutdownTimeoutMs = options.shutdownTimeoutMs;
  const ownerSignal = options.ownerSignal;
  let binding: Binding | undefined;
  let composition: ReturnType<typeof createSingleSourceHost> | undefined;
  let stopping = false, stopped = false;
  let discoveryReceipt: Readonly<{ sessionId: string }> | undefined;
  let stopAttempt: Promise<void> | undefined;
  let resolveCompletion!: () => void, rejectCompletion!: (reason: unknown) => void;
  const completion = new Promise<void>((resolve, reject) => { resolveCompletion = resolve; rejectCompletion = reject; });
  void completion.catch(() => {});
  type Slot = { server: ReturnType<typeof createRecipientHostMcpServer>; transport: StreamableHTTPServerTransport };
  let slot: Slot | undefined;
  let opening: Promise<Slot> | undefined;
  let pendingWrites = 0;
  const requireOpen = () => { if (stopping || stopped) throw Error("private_http_stopping"); };
  const requireBound = () => {
    requireOpen();
    if (!composition || !binding) throw Error("private_http_unverified");
    return { composition, binding };
  };
  // The schema stays identical across discovery and activation. Only this local dispatch changes.
  const open = async (): Promise<Slot> => {
    requireOpen();
    if (opening) return opening;
    if (slot) return slot;
    discoveryReceipt = undefined;
    opening = (async () => {
      const server = createRecipientHostMcpServer({
        context: undefined,
        host: { stepOnce: async (_context, command) => {
          const current = requireBound();
          return current.composition.host.stepOnce(current.binding.verifiedRecipientContext, command);
        } },
        allowedOperations: ["receive", "send", "inbox_read", "answer_prepare", "answer_inspect", "answer_enqueue"],
        maxInboxReadResultBytes: options.maxInboxReadResultBytes,
      });
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(), enableJsonResponse: true,
        onsessioninitialized: (sessionId) => { discoveryReceipt = Object.freeze({ sessionId }); },
      });
      const current = { server, transport };
      server.server.onclose = () => {
        if (slot === current) slot = undefined;
        // Eager discovery can close before native create commits. It grants nothing.
        // Once bound, losing the transport terminates this generation, never auto-adopts.
        if (composition && !stopping) void stop().catch(() => {});
      };
      // Retain the handle before asynchronous connect: even a failed startup must be closed.
      slot = current;
      await server.connect(transport);
      if (stopping) throw Error("private_http_stopping");
      return current;
    })().catch((error: unknown) => {
      // stop awaits this settled opening, then closes the retained handle itself.
      void stop().catch(() => {});
      throw error;
    }).finally(() => { opening = undefined; });
    return opening;
  };
  const stop = (): Promise<void> => {
    if (stopped) return Promise.resolve();
    if (stopAttempt) return stopAttempt;
    stopping = true;
    if (composition && binding) composition.revokePermanently(binding.verifiedOperatorContext);
    clearTimeout(lifetime);
    stopAttempt = (async () => {
      const deadline = performance.now() + shutdownTimeoutMs;
      if (composition && binding) {
        const host = composition.host, operator = binding.verifiedOperatorContext;
        host.setPaused(operator, true, host.status(operator).epoch);
        while (host.status(operator).running || host.status(operator).draining) {
          if (performance.now() >= deadline) throw Error("private_http_drain_timeout");
          await delay(Math.min(10, Math.max(1, deadline - performance.now())));
        }
      }
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          (async () => { if (opening) await opening.catch(() => {}); if (slot) await slot.server.close(); })(),
          new Promise<never>((_, reject) => { timer = setTimeout(() => reject(Error("private_http_close_timeout")), Math.max(1, deadline - performance.now())); }),
        ]);
      } finally { if (timer) clearTimeout(timer); }
      if (composition && binding) composition.host.releaseOwner(binding.verifiedOperatorContext);
      stopped = true;
      ownerSignal.removeEventListener("abort", ownerLost);
      resolveCompletion();
    })().catch((error: unknown) => { rejectCompletion(error); throw error; })
      .finally(() => { stopAttempt = undefined; });
    return stopAttempt;
  };
  const ownerLost = () => { void stop().catch(() => {}); };
  const lifetime = setTimeout(ownerLost, options.lifetimeMs);
  ownerSignal.addEventListener("abort", ownerLost, { once: true });
  const refuse = (response: ServerResponse, status: number) => {
    response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
    response.end('{"error":"private_recipient_request_denied"}');
  };
  return Object.freeze({
    completion,
    /** No identity is inferred from Host, loopback or MCP session IDs. Authenticate EVERY request. */
    async handleRequest(request: IncomingMessage, response: ServerResponse) {
      const header = request.headers.authorization;
      const candidate = Buffer.from(typeof header === "string" && header.length <= 263 ? header : "");
      if (candidate.length !== credential.length || !timingSafeEqual(candidate, credential)) { refuse(response, 401); return; }
      if (request.headers.host !== authority || request.headers.origin !== undefined || request.url !== "/mcp" ||
          !["POST", "GET", "DELETE"].includes(request.method ?? "")) { refuse(response, 403); return; }
      if (stopping) { refuse(response, 410); return; }
      // Old session IDs cannot create a new transport following a discovery disconnect.
      if (!slot && request.headers["mcp-session-id"] !== undefined) { refuse(response, 404); return; }
      const writing = request.method !== "GET";
      if (writing) pendingWrites++;
      try {
        const current = await open();
        if (stopping) { refuse(response, 410); return; }
        await current.transport.handleRequest(request, response);
      } catch {
        if (!response.headersSent) refuse(response, 500);
        else response.end();
      } finally { if (writing) pendingWrites--; }
    },
    /** Local owner only. Response loss/ambiguous create is NOT evidence permitting this call. */
    discoveryReceipt: () => discoveryReceipt,
    bindVerified(receipt: unknown, verified: Binding) {
      requireOpen();
      if (composition || pendingWrites || !discoveryReceipt || receipt !== discoveryReceipt || !verified.hostOptions?.answer_intents)
        throw Error("private_http_binding_rejected");
      const created = createSingleSourceHost(verified);
      // Snapshot contexts: a caller mutating its options cannot redirect a granted host.
      binding = { ...verified };
      composition = created;
    },
    status() {
      if (!composition || !binding) throw Error("private_http_unverified");
      return composition.host.status(binding.verifiedOperatorContext);
    },
    updatePermission(expectedEpoch: number, allow: boolean) {
      const current = requireBound();
      current.composition.updateWhilePaused(current.binding.verifiedOperatorContext, expectedEpoch, allow);
      return current.composition.host.status(current.binding.verifiedOperatorContext);
    },
    pause(expectedEpoch: number) { const c = requireBound(); return c.composition.host.setPaused(c.binding.verifiedOperatorContext, true, expectedEpoch); },
    resume(expectedEpoch: number) { const c = requireBound(); return c.composition.host.setPaused(c.binding.verifiedOperatorContext, false, expectedEpoch); },
    stop,
  });
}
