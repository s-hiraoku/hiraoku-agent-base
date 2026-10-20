/** Optional trusted-host blob policy. No identities, registrations or permissions are granted here. */
import { RelayError } from "./service.ts";
export interface AttachmentCapacityPolicy {
  max_records_per_owner: number;
  max_bindings_per_owner: number;
  reservations: Array<{
    owner_id: string;
    open_uploads: number;
    live_bytes: number;
    records: number;
    bindings: number;
  }>;
}
export interface AttachmentCapacityLimits {
  max_records: number;
  max_open_uploads: number;
  max_open_per_owner: number;
  max_live_bytes: number;
  max_live_bytes_per_owner: number;
}
export interface UploadCapacityUsage {
  owner_id: string;
  open_uploads: number;
  live_bytes: number;
  records: number;
}
export interface BindingCapacityUsage {
  owner_id: string;
  bindings: number;
}
const count = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
export function attachmentCapacityPolicy(
  input: AttachmentCapacityPolicy,
  limits: AttachmentCapacityLimits,
): AttachmentCapacityPolicy {
  const invalid = () => {
    throw new RelayError("invalid_attachment_capacity_policy");
  };
  if (
    !input ||
    typeof input !== "object" ||
    !count(input.max_records_per_owner) ||
    input.max_records_per_owner < 1 ||
    input.max_records_per_owner > limits.max_records ||
    !count(input.max_bindings_per_owner) ||
    input.max_bindings_per_owner < 1 ||
    input.max_bindings_per_owner > limits.max_records ||
    !Array.isArray(input.reservations) ||
    input.reservations.length > 256
  )
    return invalid();
  const ids = new Set<string>(),
    sums = { open_uploads: 0, live_bytes: 0, records: 0, bindings: 0 };
  const reservations = input.reservations.map((r) => {
    if (
      !r ||
      typeof r.owner_id !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$(?![\s\S])/.test(r.owner_id) ||
      ids.has(r.owner_id)
    )
      return invalid();
    ids.add(r.owner_id);
    for (const k of [
      "open_uploads",
      "live_bytes",
      "records",
      "bindings",
    ] as const) {
      if (!count(r[k])) invalid();
      sums[k] += r[k];
      if (!count(sums[k])) invalid();
    }
    if (
      r.open_uploads > limits.max_open_per_owner ||
      r.live_bytes > limits.max_live_bytes_per_owner ||
      r.records > input.max_records_per_owner ||
      r.bindings > input.max_bindings_per_owner ||
      r.open_uploads > r.records
    )
      invalid();
    return Object.freeze({
      owner_id: r.owner_id,
      open_uploads: r.open_uploads,
      live_bytes: r.live_bytes,
      records: r.records,
      bindings: r.bindings,
    });
  });
  if (
    sums.open_uploads > limits.max_open_uploads ||
    sums.live_bytes > limits.max_live_bytes ||
    sums.records > limits.max_records ||
    sums.bindings > limits.max_records
  )
    invalid();
  return Object.freeze({
    max_records_per_owner: input.max_records_per_owner,
    max_bindings_per_owner: input.max_bindings_per_owner,
    reservations: Object.freeze(
      reservations,
    ) as unknown as AttachmentCapacityPolicy["reservations"],
  });
}
/** Derived rows, candidate, and insert must share the same write transaction. */
export function assertUploadCapacity(
  policy: AttachmentCapacityPolicy,
  limits: AttachmentCapacityLimits,
  owner: string,
  size: number,
  rows: UploadCapacityUsage[],
): void {
  const usage = new Map<string, UploadCapacityUsage>(),
    totals = { open_uploads: 1, live_bytes: size, records: 1 };
  if (!count(size)) throw new RelayError("attachment_store_unavailable");
  for (const row of rows) {
    if (
      typeof row.owner_id !== "string" ||
      usage.has(row.owner_id) ||
      ![row.open_uploads, row.live_bytes, row.records].every(count) ||
      row.open_uploads > row.records
    )
      throw new RelayError("attachment_store_unavailable");
    usage.set(row.owner_id, { ...row });
    for (const k of ["open_uploads", "live_bytes", "records"] as const) {
      totals[k] += row[k];
      if (!count(totals[k]))
        throw new RelayError("attachment_store_unavailable");
    }
  }
  const own = usage.get(owner) ?? {
    owner_id: owner,
    open_uploads: 0,
    live_bytes: 0,
    records: 0,
  };
  own.open_uploads++;
  own.live_bytes += size;
  own.records++;
  usage.set(owner, own);
  if (
    own.open_uploads > limits.max_open_per_owner ||
    own.live_bytes > limits.max_live_bytes_per_owner ||
    own.records > policy.max_records_per_owner
  )
    throw new RelayError("upload_capacity_exceeded");
  const unused = { open_uploads: 0, live_bytes: 0, records: 0 };
  for (const floor of policy.reservations) {
    const used = usage.get(floor.owner_id);
    for (const k of ["open_uploads", "live_bytes", "records"] as const)
      unused[k] += Math.max(0, floor[k] - (used?.[k] ?? 0));
  }
  if (
    totals.open_uploads + unused.open_uploads > limits.max_open_uploads ||
    totals.live_bytes + unused.live_bytes > limits.max_live_bytes ||
    totals.records + unused.records > limits.max_records
  )
    throw new RelayError("upload_capacity_exceeded");
}
/** Binding records have their own retained-table cap; chunks are not charged a second time. */
export function assertBindingCapacity(
  policy: AttachmentCapacityPolicy,
  limits: AttachmentCapacityLimits,
  owner: string,
  rows: BindingCapacityUsage[],
): void {
  const usage = new Map<string, number>();
  let total = 1;
  for (const row of rows) {
    if (
      typeof row.owner_id !== "string" ||
      usage.has(row.owner_id) ||
      !count(row.bindings)
    )
      throw new RelayError("attachment_store_unavailable");
    usage.set(row.owner_id, row.bindings);
    total += row.bindings;
    if (!count(total)) throw new RelayError("attachment_store_unavailable");
  }
  const own = (usage.get(owner) ?? 0) + 1;
  usage.set(owner, own);
  if (own > policy.max_bindings_per_owner)
    throw new RelayError("upload_capacity_exceeded");
  let unused = 0;
  for (const floor of policy.reservations)
    unused += Math.max(0, floor.bindings - (usage.get(floor.owner_id) ?? 0));
  if (total + unused > limits.max_records)
    throw new RelayError("upload_capacity_exceeded");
}
