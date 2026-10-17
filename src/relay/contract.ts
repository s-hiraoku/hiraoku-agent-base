/** Transport-neutral Relay wire contract. No IO, identity lookup or task execution. */
export const RELAY_VERSION = 1 as const;
export const DELIVERY_TTL_MS = 3_600_000;
export const RECORD_RETENTION_MS = 30 * 86_400_000;
/** Upper bound shared with client ACK retry policy, not an automatic scheduler. */
export const MAX_ACK_RETRY_MS = 30 * 86_400_000;
/** Host supplies 128 bits of fresh random entropy; the contract module performs no IO. */
export function makeReplayBoundMessageId(
  firstSentAt: string,
  entropyHex: string,
): string {
  const at = timestamp(firstSentAt);
  if (
    at < 0 ||
    typeof entropyHex !== "string" ||
    !/^[a-f0-9]{32}$/.test(entropyHex)
  )
    return fail();
  return `rm1.${at}.${entropyHex}`;
}
export function isReplayBoundMessageId(
  value: unknown,
  expiresAt: unknown,
): boolean {
  if (
    typeof value !== "string" ||
    typeof expiresAt !== "number" ||
    !Number.isSafeInteger(expiresAt)
  )
    return false;
  const match = /^rm1\.(0|[1-9][0-9]{0,15})\.([a-f0-9]{32})$/.exec(value);
  return (
    !!match &&
    Number.isSafeInteger(Number(match[1])) &&
    Number(match[1]) === expiresAt - DELIVERY_TTL_MS
  );
}
export type Json =
  null | boolean | number | string | Json[] | { [key: string]: Json };
export type Part =
  | { type: "text"; text: string }
  | {
      type: "attachment";
      attachment_id: string;
      media_type: string;
      size_bytes: number;
      sha256: string;
      filename?: string;
    }
  | { type: "data"; schema_id: string; schema_version: number; value: Json };
export interface Submission {
  version: 1;
  message_id: string;
  recipient_id: string;
  kind: string;
  body: { parts: Part[] };
  thread_id: string;
  in_reply_to: null | { sender_id: string; message_id: string };
  first_sent_at: string;
  expires_at: string;
}
/** Required deployment policy: these values are not implicit product defaults. */
export interface ContractLimits {
  envelope_bytes: number;
  text_bytes: number;
  data_bytes: number;
  attachment_bytes: number;
  total_attachment_bytes: number;
  parts: number;
  attachments: number;
  json_depth: number;
  json_nodes: number;
}
type ErrorCode =
  | "invalid_contract"
  | "unsupported_version"
  | "capacity_exceeded"
  | "invalid_limits";
export class ContractError extends Error {
  readonly code: ErrorCode;
  constructor(
    code:
      | "invalid_contract"
      | "unsupported_version"
      | "capacity_exceeded"
      | "invalid_limits",
  ) {
    super(code);
    this.name = "ContractError";
    this.code = code;
  }
}
const fail = (): never => {
  throw new ContractError("invalid_contract");
};
const encoder = new TextEncoder();
const bytes = (s: string) => encoder.encode(s).byteLength;
function record(v: unknown): Record<string, unknown> {
  if (!v || typeof v !== "object" || Array.isArray(v)) return fail();
  const proto = Object.getPrototypeOf(v);
  if (proto !== Object.prototype && proto !== null) return fail();
  for (const key of Reflect.ownKeys(v)) {
    if (typeof key !== "string") return fail();
    const d = Object.getOwnPropertyDescriptor(v, key);
    if (!d || !("value" in d) || !d.enumerable) return fail();
  }
  return v as Record<string, unknown>;
}
function fields(
  v: Record<string, unknown>,
  required: string[],
  optional: string[] = [],
) {
  if (
    required.some((k) => !Object.hasOwn(v, k)) ||
    Object.keys(v).some((k) => !required.includes(k) && !optional.includes(k))
  )
    fail();
}
function id(v: unknown): string {
  if (typeof v !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(v))
    return fail();
  return v;
}
function integer(v: unknown, min: number): number {
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < min)
    return fail();
  return v;
}
function cap(n: number, max: number) {
  if (n > max) throw new ContractError("capacity_exceeded");
}
function timestamp(v: unknown): number {
  if (
    typeof v !== "string" ||
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(v)
  )
    return fail();
  const n = Date.parse(v);
  if (!Number.isFinite(n) || new Date(n).toISOString() !== v) return fail();
  return n;
}
const limitKeys = [
  "envelope_bytes",
  "text_bytes",
  "data_bytes",
  "attachment_bytes",
  "total_attachment_bytes",
  "parts",
  "attachments",
  "json_depth",
  "json_nodes",
] as const;
export function validateLimits(limits: ContractLimits): void {
  const v = record(limits);
  if (
    Object.keys(v).length !== limitKeys.length ||
    limitKeys.some(
      (k) =>
        typeof v[k] !== "number" ||
        !Number.isSafeInteger(v[k]) ||
        (v[k] as number) < 1,
    )
  )
    throw new ContractError("invalid_limits");
}
/** Validate bounded JSON without invoking getters, toJSON or arbitrary serialization. */
function json(
  v: unknown,
  limits: ContractLimits,
  depth = 0,
  budget = { nodes: 0 },
  ancestors = new Set<object>(),
): Json {
  cap(++budget.nodes, limits.json_nodes);
  cap(depth, limits.json_depth);
  if (v === null || typeof v === "boolean" || typeof v === "string") return v;
  if (typeof v === "number") {
    if (!Number.isFinite(v)) return fail();
    return v;
  }
  if (typeof v !== "object" || ancestors.has(v)) return fail();
  ancestors.add(v);
  try {
    if (Array.isArray(v)) {
      // Reject holes, accessors and additional array properties.
      if (
        Object.keys(v).length !== v.length ||
        Reflect.ownKeys(v).length !== v.length + 1
      )
        return fail();
      const result: Json[] = [];
      for (let i = 0; i < v.length; i++) {
        const d = Object.getOwnPropertyDescriptor(v, String(i));
        if (!d || !("value" in d) || !d.enumerable) return fail();
        result.push(json(d.value, limits, depth + 1, budget, ancestors));
      }
      return result;
    }
    const obj = record(v);
    // Null prototype preserves keys such as __proto__ without prototype mutation.
    const out: Record<string, Json> = Object.create(null);
    for (const [k, value] of Object.entries(obj))
      out[k] = json(value, limits, depth + 1, budget, ancestors);
    return out;
  } finally {
    ancestors.delete(v);
  }
}
/** Parses a caller submission only. Caller-supplied sender_id is always rejected.
 * Authentication, authorization, attachment finalize/ownership and DB-time checks
 * belong to the service boundary and are mandatory before acceptance.
 */
export function parseSubmission(
  input: unknown,
  limits: ContractLimits,
): Submission {
  validateLimits(limits);
  const v = record(json(input, limits));
  if (v.version !== RELAY_VERSION)
    throw new ContractError("unsupported_version");
  fields(v, [
    "version",
    "message_id",
    "recipient_id",
    "kind",
    "body",
    "thread_id",
    "in_reply_to",
    "first_sent_at",
    "expires_at",
  ]);
  const sent = timestamp(v.first_sent_at);
  const expiry = timestamp(v.expires_at);
  if (expiry - sent !== DELIVERY_TTL_MS) fail();
  if (
    typeof v.message_id === "string" &&
    v.message_id.startsWith("rm1.") &&
    !isReplayBoundMessageId(v.message_id, expiry)
  )
    fail();
  const body = record(v.body);
  fields(body, ["parts"]);
  if (!Array.isArray(body.parts) || !body.parts.length) return fail();
  cap(body.parts.length, limits.parts);
  let attachmentCount = 0,
    attachmentBytes = 0,
    textBytes = 0,
    dataBytes = 0;
  const parts = body.parts.map((raw): Part => {
    const p = record(raw);
    if (p.type === "text") {
      fields(p, ["type", "text"]);
      if (typeof p.text !== "string") return fail();
      textBytes += bytes(p.text);
      cap(textBytes, limits.text_bytes);
      return { type: "text", text: p.text };
    }
    if (p.type === "attachment") {
      fields(
        p,
        ["type", "attachment_id", "media_type", "size_bytes", "sha256"],
        ["filename"],
      );
      if (
        typeof p.media_type !== "string" ||
        p.media_type.length > 255 ||
        !/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(p.media_type)
      )
        return fail();
      if (typeof p.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(p.sha256))
        return fail();
      if (
        p.filename !== undefined &&
        (typeof p.filename !== "string" ||
          !p.filename.length ||
          bytes(p.filename) > 255 ||
          /[\x00-\x1f\x7f/\\]/.test(p.filename) ||
          p.filename === "." ||
          p.filename === "..")
      )
        return fail();
      const size = integer(p.size_bytes, 0);
      cap(size, limits.attachment_bytes);
      cap(++attachmentCount, limits.attachments);
      attachmentBytes += size;
      cap(attachmentBytes, limits.total_attachment_bytes);
      return {
        type: "attachment",
        attachment_id: id(p.attachment_id),
        media_type: p.media_type,
        size_bytes: size,
        sha256: p.sha256,
        ...(p.filename === undefined ? {} : { filename: p.filename as string }),
      };
    }
    if (p.type === "data") {
      fields(p, ["type", "schema_id", "schema_version", "value"]);
      const value = p.value as Json;
      dataBytes += bytes(JSON.stringify(value));
      cap(dataBytes, limits.data_bytes);
      return {
        type: "data",
        schema_id: id(p.schema_id),
        schema_version: integer(p.schema_version, 1),
        value,
      };
    }
    return fail();
  });
  let reply: Submission["in_reply_to"] = null;
  if (v.in_reply_to !== null) {
    const r = record(v.in_reply_to);
    fields(r, ["sender_id", "message_id"]);
    reply = { sender_id: id(r.sender_id), message_id: id(r.message_id) };
  }
  const result: Submission = {
    version: 1,
    message_id: id(v.message_id),
    recipient_id: id(v.recipient_id),
    kind: id(v.kind),
    body: { parts },
    thread_id: id(v.thread_id),
    in_reply_to: reply,
    first_sent_at: v.first_sent_at as string,
    expires_at: v.expires_at as string,
  };
  cap(bytes(JSON.stringify(result)), limits.envelope_bytes);
  return result;
}
/** Stable comparison material; caller must add the verified sender before hashing.
 * Preserves part order and all JSON string contents; sorts only object keys.
 * This is not a public/loggable fingerprint and performs no authentication.
 */
export function comparisonMaterial(
  senderId: string,
  input: unknown,
  limits: ContractLimits,
): string {
  const submission = parseSubmission(input, limits);
  const sort = (value: Json): Json => {
    if (Array.isArray(value)) return value.map(sort);
    if (value !== null && typeof value === "object") {
      const out: Record<string, Json> = Object.create(null);
      for (const k of Object.keys(value).sort()) out[k] = sort(value[k]);
      return out;
    }
    return value;
  };
  return JSON.stringify(
    sort({ sender_id: id(senderId), ...submission } as unknown as Json),
  );
}

export interface AckRequest {
  sender_id: string;
  message_id: string;
  generation: number;
  lease_token: string;
  request_id: string;
}
export function parseAck(input: unknown, limits: ContractLimits): AckRequest {
  validateLimits(limits);
  const v = record(json(input, limits));
  fields(v, [
    "sender_id",
    "message_id",
    "generation",
    "lease_token",
    "request_id",
  ]);
  if (
    typeof v.lease_token !== "string" ||
    !/^[A-Za-z0-9_-]{43}$/.test(v.lease_token)
  )
    return fail();
  const result = {
    sender_id: id(v.sender_id),
    message_id: id(v.message_id),
    generation: integer(v.generation, 1),
    lease_token: v.lease_token,
    request_id: id(v.request_id),
  };
  cap(bytes(JSON.stringify(result)), limits.envelope_bytes);
  return result;
}
