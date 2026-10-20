/** Trusted host message-capacity policy. Identity is the verified Acceptance.sender_id, never wire arguments. */
import { RelayError } from "./service.ts";
export interface AgentCapacityPolicy {
  max_pending_per_sender: number;
  max_body_bytes_per_sender: number;
  max_records_per_sender: number;
  max_body_bytes_per_recipient: number;
  max_records_per_recipient: number;
  reservations: Array<{
    sender_id: string;
    pending: number;
    body_bytes: number;
    records: number;
  }>;
}
export interface CapacityTotals {
  max_pending: number;
  max_body_bytes: number;
  max_records: number;
}
export interface SenderCapacityUsage {
  sender_id: string;
  pending: number;
  body_bytes: number;
  records: number;
}
const count = (v: unknown): v is number =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
export function agentCapacityPolicy(
  input: AgentCapacityPolicy,
  total: CapacityTotals,
): AgentCapacityPolicy {
  const invalid = () => {
    throw new RelayError("invalid_agent_capacity_policy");
  };
  if (!input || typeof input !== "object") return invalid();
  for (const key of [
    "max_pending_per_sender",
    "max_body_bytes_per_sender",
    "max_records_per_sender",
    "max_body_bytes_per_recipient",
    "max_records_per_recipient",
  ] as const)
    if (!count(input[key]) || input[key] < 1) invalid();
  if (
    input.max_pending_per_sender > total.max_pending ||
    input.max_body_bytes_per_sender > total.max_body_bytes ||
    input.max_body_bytes_per_recipient > total.max_body_bytes ||
    input.max_records_per_sender > total.max_records ||
    input.max_records_per_recipient > total.max_records ||
    input.max_pending_per_sender > input.max_records_per_sender ||
    !Array.isArray(input.reservations) ||
    input.reservations.length > 256
  )
    invalid();
  const ids = new Set<string>(),
    floors = { pending: 0, body_bytes: 0, records: 0 };
  const reservations = input.reservations.map((r) => {
    if (
      !r ||
      typeof r.sender_id !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(r.sender_id) ||
      ids.has(r.sender_id)
    )
      return invalid();
    ids.add(r.sender_id);
    for (const k of ["pending", "body_bytes", "records"] as const) {
      if (!count(r[k]) || r[k] < 1) invalid();
      floors[k] += r[k];
    }
    if (
      r.pending > input.max_pending_per_sender ||
      r.body_bytes > input.max_body_bytes_per_sender ||
      r.records > input.max_records_per_sender ||
      r.records < r.pending
    )
      invalid();
    return Object.freeze({
      sender_id: r.sender_id,
      pending: r.pending,
      body_bytes: r.body_bytes,
      records: r.records,
    });
  });
  if (
    floors.pending > total.max_pending ||
    floors.body_bytes > total.max_body_bytes ||
    floors.records > total.max_records
  )
    invalid();
  return Object.freeze({
    ...input,
    reservations: Object.freeze(
      reservations,
    ) as unknown as AgentCapacityPolicy["reservations"],
  });
}
/** All usage is read inside the acceptance write transaction, after expiry and exact replay lookup. */
export function assertAgentCapacity(
  policy: AgentCapacityPolicy,
  total: CapacityTotals,
  sender: string,
  bytes: number,
  senders: SenderCapacityUsage[],
  recipient: { records: number; body_bytes: number },
): void {
  const usage = new Map<string, SenderCapacityUsage>(),
    combined = { pending: 1, body_bytes: bytes, records: 1 };
  if (
    !count(bytes) ||
    !count(recipient.records) ||
    !count(recipient.body_bytes)
  )
    throw new RelayError("capacity_state_invalid");
  for (const row of senders) {
    if (
      typeof row.sender_id !== "string" ||
      usage.has(row.sender_id) ||
      ![row.pending, row.body_bytes, row.records].every(count) ||
      row.pending > row.records
    )
      throw new RelayError("capacity_state_invalid");
    usage.set(row.sender_id, { ...row });
    for (const k of ["pending", "body_bytes", "records"] as const) {
      combined[k] += row[k];
      if (!count(combined[k])) throw new RelayError("capacity_state_invalid");
    }
  }
  const own = usage.get(sender) ?? {
    sender_id: sender,
    pending: 0,
    body_bytes: 0,
    records: 0,
  };
  own.pending++;
  own.body_bytes += bytes;
  own.records++;
  usage.set(sender, own);
  if (
    own.pending > policy.max_pending_per_sender ||
    own.body_bytes > policy.max_body_bytes_per_sender ||
    own.records > policy.max_records_per_sender ||
    recipient.records + 1 > policy.max_records_per_recipient ||
    recipient.body_bytes + bytes > policy.max_body_bytes_per_recipient
  )
    throw new RelayError("capacity_exceeded");
  const unused = { pending: 0, body_bytes: 0, records: 0 };
  for (const floor of policy.reservations) {
    const current = usage.get(floor.sender_id);
    for (const k of ["pending", "body_bytes", "records"] as const)
      unused[k] += Math.max(0, floor[k] - (current?.[k] ?? 0));
  }
  if (
    combined.pending + unused.pending > total.max_pending ||
    combined.body_bytes + unused.body_bytes > total.max_body_bytes ||
    combined.records + unused.records > total.max_records
  )
    throw new RelayError("capacity_exceeded");
}
