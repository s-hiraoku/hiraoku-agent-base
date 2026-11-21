/**
 * Trusted host message-capacity policy. Identity is the verified Acceptance.sender_id, never wire arguments.
 *
 * Per-agent budgets charge only unread mail (`pending / leased / quarantined`) and its body:
 * once the recipient has read a message, or it has expired, it no longer counts against its
 * sender or recipient. Retained receipts and read bodies are bounded only by the store-wide
 * `max_records` / `max_body_bytes` disk ceilings ([details](../../docs/delivery/agent-capacity.md)).
 */
import { MessagingError } from "../messaging/delivery-service.ts";
export interface AgentCapacityPolicy {
  max_pending_per_sender: number;
  max_body_bytes_per_sender: number;
  max_body_bytes_per_recipient: number;
  reservations: Array<{
    sender_id: string;
    pending: number;
    body_bytes: number;
  }>;
}
export interface CapacityTotals {
  max_pending: number;
  max_body_bytes: number;
}
/** One sender's unread mail: its count and the bytes of its bodies. */
export interface SenderCapacityUsage {
  sender_id: string;
  pending: number;
  body_bytes: number;
}
/** What the store holds besides the per-sender unread rows. */
export interface StoreCapacityUsage {
  /** Unread body bytes addressed to the new message's recipient. */
  recipient_body_bytes: number;
  /** Every body the store still holds, read ones included (the disk ceiling's measure). */
  held_body_bytes: number;
}
const count = (v: unknown): v is number =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const KINDS = ["pending", "body_bytes"] as const;
export function agentCapacityPolicy(
  input: AgentCapacityPolicy,
  total: CapacityTotals,
): AgentCapacityPolicy {
  const invalid = () => {
    throw new MessagingError("invalid_agent_capacity_policy");
  };
  if (!input || typeof input !== "object") return invalid();
  for (const key of [
    "max_pending_per_sender",
    "max_body_bytes_per_sender",
    "max_body_bytes_per_recipient",
  ] as const)
    if (!count(input[key]) || input[key] < 1) invalid();
  if (
    input.max_pending_per_sender > total.max_pending ||
    input.max_body_bytes_per_sender > total.max_body_bytes ||
    input.max_body_bytes_per_recipient > total.max_body_bytes ||
    !Array.isArray(input.reservations) ||
    input.reservations.length > 256
  )
    invalid();
  const ids = new Set<string>(),
    floors = { pending: 0, body_bytes: 0 };
  const reservations = input.reservations.map((r) => {
    if (
      !r ||
      typeof r.sender_id !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(r.sender_id) ||
      ids.has(r.sender_id)
    )
      return invalid();
    ids.add(r.sender_id);
    for (const k of KINDS) {
      if (!count(r[k]) || r[k] < 1) invalid();
      floors[k] += r[k];
    }
    if (
      r.pending > input.max_pending_per_sender ||
      r.body_bytes > input.max_body_bytes_per_sender
    )
      invalid();
    return Object.freeze({
      sender_id: r.sender_id,
      pending: r.pending,
      body_bytes: r.body_bytes,
    });
  });
  if (
    floors.pending > total.max_pending ||
    floors.body_bytes > total.max_body_bytes
  )
    invalid();
  return Object.freeze({
    max_pending_per_sender: input.max_pending_per_sender,
    max_body_bytes_per_sender: input.max_body_bytes_per_sender,
    max_body_bytes_per_recipient: input.max_body_bytes_per_recipient,
    reservations: Object.freeze(
      reservations,
    ) as unknown as AgentCapacityPolicy["reservations"],
  });
}
/**
 * All usage is read inside the acceptance write transaction, after expiry and exact replay
 * lookup. `senders` holds unread mail only; read and expired rows are not the sender's load.
 */
export function assertAgentCapacity(
  policy: AgentCapacityPolicy,
  total: CapacityTotals,
  sender: string,
  bytes: number,
  senders: SenderCapacityUsage[],
  store: StoreCapacityUsage,
): void {
  const usage = new Map<string, SenderCapacityUsage>();
  let unread = 1;
  if (
    !count(bytes) ||
    !count(store.recipient_body_bytes) ||
    !count(store.held_body_bytes)
  )
    throw new MessagingError("capacity_state_invalid");
  for (const row of senders) {
    if (
      typeof row.sender_id !== "string" ||
      usage.has(row.sender_id) ||
      !KINDS.every((k) => count(row[k]))
    )
      throw new MessagingError("capacity_state_invalid");
    usage.set(row.sender_id, { ...row });
    unread += row.pending;
    if (!count(unread)) throw new MessagingError("capacity_state_invalid");
  }
  const own = usage.get(sender) ?? {
    sender_id: sender,
    pending: 0,
    body_bytes: 0,
  };
  own.pending++;
  own.body_bytes += bytes;
  usage.set(sender, own);
  if (
    own.pending > policy.max_pending_per_sender ||
    own.body_bytes > policy.max_body_bytes_per_sender ||
    store.recipient_body_bytes + bytes > policy.max_body_bytes_per_recipient
  )
    throw new MessagingError("capacity_exceeded");
  // A protected sender's unused floor stays free in the store-wide pools; the byte pool is
  // the disk ceiling, so read bodies still kept for re-reading take space from it too.
  const unused = { pending: 0, body_bytes: 0 };
  for (const floor of policy.reservations) {
    const current = usage.get(floor.sender_id);
    for (const k of KINDS)
      unused[k] += Math.max(0, floor[k] - (current?.[k] ?? 0));
  }
  if (
    unread + unused.pending > total.max_pending ||
    store.held_body_bytes + bytes + unused.body_bytes > total.max_body_bytes
  )
    throw new MessagingError("capacity_exceeded");
}
