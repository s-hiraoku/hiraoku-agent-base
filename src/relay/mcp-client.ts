/** Fixed Relay MCP profile; no discovery, credential issuance, retries or scheduler. */
import { z } from "zod";
import { parseSubmission, parseAck, validateLimits } from "./contract.ts";
import type { Submission, AckRequest, ContractLimits } from "./contract.ts";
import { RelayError } from "./service.ts";
import type { Receipt, Delivery, AckReceipt } from "./service.ts";
import type { SenderTransport } from "./sender.ts";
import type { ReceiverTransport } from "./receiver.ts";
import { isRelayMcpError } from "./mcp-errors.ts";

export interface RelayMcpClientPolicy {
  resource_url: string;
  /** Expected immutable local owner; checked on results, never sent as authority. */
  agent_id: string;
  max_request_bytes: number;
  max_response_bytes: number;
  timeout_ms: number;
  max_active_requests: number;
  max_sse_events: number;
  max_sse_lines: number;
  max_json_depth: number;
  max_json_nodes: number;
}
export type RelayCredentialProvider = (input: {
  resource: string;
  signal: AbortSignal;
}) => string | Promise<string>;
export interface RelayMcpClientOptions {
  policy: RelayMcpClientPolicy;
  limits: ContractLimits;
  authorization?: RelayCredentialProvider;
  /** Trusted transport port, also used by fixtures. It must honor redirect/error and abort. */
  fetch?: typeof globalThis.fetch;
}
class ClientFailure extends Error {
  readonly code: string;
  constructor(code = "relay_transport_failed") {
    super(code);
    this.code = code;
  }
}
const fail = (): never => {
  throw new ClientFailure();
};
const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/);
const timestamp = z.string().refine((s) => {
  const n = Date.parse(s);
  return (
    /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(s) &&
    Number.isFinite(n) &&
    new Date(n).toISOString() === s
  );
});
const receiptSchema = z.strictObject({
  sender_id: id,
  message_id: id,
  recipient_id: id,
  receipt_id: id,
  accepted_at: timestamp,
  expires_at: timestamp,
  state: z.enum(["pending", "leased", "acked", "expired", "quarantined"]),
});
const ackReceiptSchema = z.strictObject({
  recipient_id: id,
  sender_id: id,
  message_id: id,
  request_id: id,
  receipt_id: id,
  acked_at: timestamp,
  state: z.literal("acked"),
});
const deliverySchema = z.strictObject({
  message: z.unknown(),
  generation: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  lease_token: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  lease_until: timestamp,
});
const pollSchema = z.strictObject({ delivery: z.unknown() });
const resultSchema = z.strictObject({
  resultType: z.literal("complete"),
  // Bounded protocol metadata is inert; never use it as identity or instructions.
  _meta: z.record(z.string(), z.unknown()).optional(),
  content: z
    .array(z.strictObject({ type: z.literal("text"), text: z.string() }))
    .length(1),
  structuredContent: z.record(z.string(), z.unknown()),
  isError: z.boolean().optional(),
});
type Tool = "relay_submit" | "relay_status" | "relay_poll" | "relay_ack";

/** All parsed trees are bounded before schema validation, equality or body processing. */
function boundedJson(
  text: string,
  policy: Readonly<RelayMcpClientPolicy>,
): unknown {
  const value: unknown = JSON.parse(text);
  const pending: { value: unknown; depth: number }[] = [{ value, depth: 1 }];
  let nodes = 0;
  while (pending.length) {
    const item = pending.pop()!;
    if (++nodes > policy.max_json_nodes || item.depth > policy.max_json_depth)
      fail();
    if (typeof item.value === "number" && !Number.isFinite(item.value)) fail();
    if (item.value && typeof item.value === "object") {
      const values = Object.values(item.value);
      if (nodes + pending.length + values.length > policy.max_json_nodes)
        fail();
      for (const child of values)
        pending.push({ value: child, depth: item.depth + 1 });
    }
  }
  return value;
}
function sameJson(left: unknown, right: unknown): boolean {
  const pending: [unknown, unknown][] = [[left, right]];
  while (pending.length) {
    const [a, b] = pending.pop()!;
    if (a === b) continue;
    if (
      !a ||
      !b ||
      typeof a !== "object" ||
      typeof b !== "object" ||
      Array.isArray(a) !== Array.isArray(b)
    )
      return false;
    const av = a as Record<string, unknown>,
      bv = b as Record<string, unknown>,
      keys = Object.keys(av);
    if (keys.length !== Object.keys(bv).length) return false;
    for (const key of keys) {
      if (!Object.hasOwn(bv, key)) return false;
      pending.push([av[key], bv[key]]);
    }
  }
  return true;
}
/** This profile requests no progress/logging/sampling. Only one final response is accepted. */
function sseResult(
  text: string,
  policy: Readonly<RelayMcpClientPolicy>,
): unknown {
  let start = 0,
    lines = 0,
    events = 0,
    found = false,
    result: unknown;
  let data: string[] = [],
    event = "";
  const line = (value: string) => {
    if (++lines > policy.max_sse_lines) fail();
    if (value === "") {
      if (++events > policy.max_sse_events) fail();
      if (data.length) {
        if (found || (event !== "" && event !== "message")) fail();
        result = boundedJson(data.join("\n"), policy);
        found = true;
      }
      data = [];
      event = "";
      return;
    }
    if (value.startsWith(":")) return;
    const colon = value.indexOf(":"),
      field = colon < 0 ? value : value.slice(0, colon);
    let v = colon < 0 ? "" : value.slice(colon + 1);
    if (v.startsWith(" ")) v = v.slice(1);
    if (field === "data") data.push(v);
    else if (field === "event") event = v;
    // SSE id/retry/unknown fields are ignored: never reconnect or resume a stream.
  };
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== "\r" && text[i] !== "\n") continue;
    line(text.slice(start, i));
    if (text[i] === "\r" && text[i + 1] === "\n") i++;
    start = i + 1;
  }
  if (start < text.length) line(text.slice(start));
  if (!found || data.length || event) fail();
  return result;
}
async function readResponse(
  response: Response,
  limit: number,
  signal: AbortSignal,
  check: () => void,
): Promise<{ text: string; bytes: number }> {
  if (!response.body) return fail();
  const reader = response.body.getReader();
  const cancel = () => {
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener("abort", cancel, { once: true });
  let storage = new Uint8Array(Math.min(limit, 4096)),
    length = 0;
  try {
    check();
    for (;;) {
      const { done, value } = await reader.read();
      check();
      if (done) break;
      if (!(value instanceof Uint8Array) || value.byteLength > limit - length)
        fail();
      const size = length + value.byteLength;
      if (size > storage.byteLength) {
        const next = new Uint8Array(
          Math.min(limit, Math.max(size, storage.byteLength * 2)),
        );
        next.set(storage.subarray(0, length));
        storage = next;
      }
      storage.set(value, length);
      length = size;
    }
    return {
      text: new TextDecoder("utf-8", { fatal: true }).decode(
        storage.subarray(0, length),
      ),
      bytes: length,
    };
  } finally {
    signal.removeEventListener("abort", cancel);
    // Cleanup is part of admission: a broken provider cannot release the slot early.
    await reader.cancel().catch(() => {});
  }
}

export class RelayMcpClient implements SenderTransport, ReceiverTransport {
  readonly #policy: Readonly<RelayMcpClientPolicy>;
  readonly #limits: Readonly<ContractLimits>;
  readonly #authorization: RelayCredentialProvider;
  readonly #fetch: typeof globalThis.fetch;
  #active = 0;
  #sequence = 0;
  constructor(options: RelayMcpClientOptions) {
    try {
      const p = options.policy,
        u = new URL(p.resource_url);
      id.parse(p.agent_id);
      if (
        u.href !== p.resource_url ||
        u.username ||
        u.password ||
        u.search ||
        u.hash ||
        !/^\/[A-Za-z0-9/_-]+$/.test(u.pathname) ||
        u.pathname.includes("//") ||
        (u.protocol !== "https:" &&
          !(
            u.protocol === "http:" &&
            ["127.0.0.1", "[::1]", "localhost"].includes(u.hostname)
          ))
      )
        throw Error();
      const caps = {
        max_request_bytes: 16 * 1024 * 1024,
        max_response_bytes: 32 * 1024 * 1024,
        timeout_ms: 30000,
        max_active_requests: 1000,
        max_sse_events: 1000,
        max_sse_lines: 10000,
        max_json_depth: 128,
        max_json_nodes: 1000000,
      };
      for (const key of Object.keys(caps) as (keyof typeof caps)[]) {
        if (!Number.isSafeInteger(p[key]) || p[key] < 1 || p[key] > caps[key])
          throw Error();
      }
      validateLimits(options.limits);
      if (
        (options.authorization !== undefined &&
          typeof options.authorization !== "function") ||
        (options.fetch !== undefined && typeof options.fetch !== "function")
      )
        throw Error();
    } catch {
      throw new RelayError("invalid_relay_client_policy");
    }
    this.#policy = Object.freeze({ ...options.policy });
    this.#limits = Object.freeze({ ...options.limits });
    this.#authorization = options.authorization ?? (() => "");
    this.#fetch = options.fetch ?? globalThis.fetch;
  }
  async #call(tool: Tool, args: unknown): Promise<unknown> {
    if (this.#active >= this.#policy.max_active_requests)
      throw new RelayError("relay_client_busy");
    if (this.#sequence === Number.MAX_SAFE_INTEGER)
      throw new RelayError("relay_transport_failed");
    const rpcId = ++this.#sequence;
    const body = JSON.stringify({
      jsonrpc: "2.0",
      id: rpcId,
      method: "tools/call",
      params: {
        name: tool,
        arguments: args,
        _meta: {
          "io.modelcontextprotocol/protocolVersion": "2026-07-28",
          "io.modelcontextprotocol/clientCapabilities": {},
        },
      },
    });
    if (
      new TextEncoder().encode(body).byteLength > this.#policy.max_request_bytes
    )
      throw new RelayError("capacity_exceeded");
    const controller = new AbortController(),
      deadline = Date.now() + this.#policy.timeout_ms;
    const check = () => {
      if (controller.signal.aborted || Date.now() >= deadline) fail();
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    this.#active++;
    const work = this.#perform(
      tool,
      rpcId,
      body,
      controller.signal,
      check,
    ).finally(() => {
      this.#active--;
    });
    try {
      return await Promise.race([
        work,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(new ClientFailure());
          }, this.#policy.timeout_ms);
        }),
      ]);
    } catch (error) {
      // Only errors constructed inside this boundary can carry semantic server codes.
      throw new RelayError(
        error instanceof ClientFailure ? error.code : "relay_transport_failed",
      );
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
  }
  async #perform(
    tool: Tool,
    rpcId: number,
    body: string,
    signal: AbortSignal,
    check: () => void,
  ): Promise<unknown> {
    const authorization = await this.#authorization({
      resource: this.#policy.resource_url,
      signal,
    });
    check();
    if (
      typeof authorization !== "string" ||
      authorization.length > 8192 ||
      !/^Bearer [A-Za-z0-9._~+/-]+=*$/.test(authorization)
    ) {
      throw new ClientFailure("forbidden");
    }
    const response = await this.#fetch(this.#policy.resource_url, {
      method: "POST",
      redirect: "error",
      credentials: "omit",
      cache: "no-store",
      signal,
      headers: {
        Authorization: authorization,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        "Accept-Encoding": "identity",
        "MCP-Protocol-Version": "2026-07-28",
        "Mcp-Method": "tools/call",
        "Mcp-Name": tool,
      },
      body,
    });
    let reading = false;
    try {
      check();
      if (
        response.redirected ||
        (response.url && response.url !== this.#policy.resource_url)
      )
        fail();
      if (
        response.status !== 200 ||
        (response.headers.has("content-encoding") &&
          response.headers.get("content-encoding") !== "identity")
      )
        fail();
      const type = response.headers.get("content-type") ?? "";
      if (
        !/^(application\/json|text\/event-stream)(?:\s*;\s*charset=utf-8)?$/i.test(
          type,
        )
      )
        fail();
      const length = response.headers.get("content-length");
      if (
        length !== null &&
        (!/^(0|[1-9][0-9]*)$/.test(length) ||
          !Number.isSafeInteger(Number(length)) ||
          Number(length) > this.#policy.max_response_bytes)
      )
        fail();
      reading = true;
      const { text, bytes } = await readResponse(
        response,
        this.#policy.max_response_bytes,
        signal,
        check,
      );
      check();
      if (length !== null && bytes !== Number(length)) fail();
      const value = type.toLowerCase().startsWith("application/json")
        ? boundedJson(text, this.#policy)
        : sseResult(text, this.#policy);
      const envelope = z
        .strictObject({
          jsonrpc: z.literal("2.0"),
          id: z.literal(rpcId),
          result: resultSchema,
        })
        .parse(value);
      const result = envelope.result,
        content = boundedJson(result.content[0].text, this.#policy);
      if (!sameJson(content, result.structuredContent)) fail();
      check();
      if (result.isError === true) {
        const error = z
          .strictObject({ error: z.string() })
          .parse(content).error;
        throw new ClientFailure(
          isRelayMcpError(error) ? error : "relay_transport_failed",
        );
      }
      return content;
    } finally {
      if (!reading) await response.body?.cancel().catch(() => {});
    }
  }
  async submit(message: Submission): Promise<Receipt> {
    const input = parseSubmission(message, this.#limits);
    const value = await this.#call("relay_submit", input);
    return this.#receipt(value, input.message_id, input);
  }
  async status(messageId: string): Promise<Receipt> {
    if (!id.safeParse(messageId).success)
      throw new RelayError("invalid_request");
    return this.#receipt(
      await this.#call("relay_status", { message_id: messageId }),
      messageId,
    );
  }
  #receipt(value: unknown, messageId: string, input?: Submission): Receipt {
    const parsed = receiptSchema.safeParse(value);
    if (!parsed.success) throw new RelayError("relay_transport_failed");
    const r = parsed.data;
    if (r.sender_id !== this.#policy.agent_id)
      throw new RelayError("forbidden");
    if (
      r.message_id !== messageId ||
      Date.parse(r.accepted_at) >= Date.parse(r.expires_at) ||
      (input &&
        (r.recipient_id !== input.recipient_id ||
          r.expires_at !== input.expires_at))
    )
      throw new RelayError("relay_transport_failed");
    return r;
  }
  async poll(): Promise<Delivery | null> {
    const value = await this.#call("relay_poll", {});
    try {
      const d = pollSchema.parse(value).delivery;
      if (d === null) return null;
      const delivery = deliverySchema.parse(d);
      if (
        !delivery.message ||
        typeof delivery.message !== "object" ||
        Array.isArray(delivery.message)
      )
        fail();
      const { sender_id: senderId, ...body } = delivery.message as Record<
        string,
        unknown
      >;
      const message = parseSubmission(body, this.#limits);
      id.parse(senderId);
      if (message.recipient_id !== this.#policy.agent_id)
        throw new ClientFailure("forbidden");
      if (
        Date.parse(delivery.lease_until) > Date.parse(message.expires_at) ||
        Date.parse(delivery.lease_until) <= Date.parse(message.first_sent_at)
      )
        fail();
      return {
        ...delivery,
        message: { ...message, sender_id: senderId as string },
      };
    } catch (error) {
      throw new RelayError(
        error instanceof ClientFailure ? error.code : "relay_transport_failed",
      );
    }
  }
  async ack(request: AckRequest): Promise<AckReceipt> {
    const input = parseAck(request, this.#limits);
    const value = await this.#call("relay_ack", input);
    const parsed = ackReceiptSchema.safeParse(value);
    if (parsed.success && parsed.data.recipient_id !== this.#policy.agent_id)
      throw new RelayError("forbidden");
    if (
      !parsed.success ||
      parsed.data.sender_id !== input.sender_id ||
      parsed.data.message_id !== input.message_id ||
      parsed.data.request_id !== input.request_id
    )
      throw new RelayError("relay_transport_failed");
    return parsed.data;
  }
}
