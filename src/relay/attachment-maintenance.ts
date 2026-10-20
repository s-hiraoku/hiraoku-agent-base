/** Host-only finite server maintenance. No scheduling, network, credential issuance or application execution. */
import { RelayError } from "./service.ts";
import type {
  Authorization,
  MaintenanceResult,
  MaintenanceStore,
} from "./service.ts";
import type { AttachmentUploadStore } from "./attachments.ts";
import { uploadIdentifier } from "./attachments.ts";
import type {
  AttachmentDeletionQueue,
  AttachmentDeletionPolicy,
  BoundAttachmentDeletion,
} from "./attachment-deletion.ts";
import { AttachmentDeletionWorker } from "./attachment-deletion-worker.ts";
export interface AttachmentMaintenancePolicy {
  relay_limit: number;
  upload_limit: number;
  deletion: AttachmentDeletionPolicy;
}
export interface AttachmentMaintenanceResult {
  state: "done" | "partial";
  completed_stages: number;
  failed_stage: "relay" | "deletion" | "uploads" | null;
  reason: "forbidden" | "unavailable" | "deletion_deferred" | null;
  relay: MaintenanceResult | null;
  deletion: "idle" | "done" | "deferred" | null;
  uploads: { expired: number; purged: number } | null;
}
function synchronous<T>(value: T): T {
  if (value && typeof value === "object" && "then" in value) {
    void Promise.resolve(value).catch(() => {});
    throw new RelayError("maintenance_cycle_unavailable");
  }
  return value;
}
const count = (n: unknown): n is number =>
  typeof n === "number" && Number.isSafeInteger(n) && n >= 0;
export class AttachmentMaintenanceCycle {
  readonly #relay: MaintenanceStore & AttachmentDeletionQueue;
  readonly #uploads: Pick<AttachmentUploadStore, "maintain"> &
    BoundAttachmentDeletion;
  readonly #policy: AttachmentMaintenancePolicy;
  readonly #authorization?: Authorization;
  #running = false;
  constructor(
    relay: MaintenanceStore & AttachmentDeletionQueue,
    uploads: Pick<AttachmentUploadStore, "maintain"> & BoundAttachmentDeletion,
    policy: AttachmentMaintenancePolicy,
    authorization?: Authorization,
  ) {
    for (const [port, methods] of [
      [
        relay,
        [
          "maintain",
          "claimAttachmentDeletion",
          "withAttachmentDeletion",
          "completeAttachmentDeletion",
          "failAttachmentDeletion",
        ],
      ],
      [uploads, ["maintain", "deleteBound"]],
    ] as const)
      if (
        !port ||
        methods.some(
          (k) =>
            typeof (port as unknown as Record<string, unknown>)[k] !==
            "function",
        )
      )
        throw new RelayError("invalid_maintenance_cycle_options");
    if (
      !policy ||
      !Number.isSafeInteger(policy.relay_limit) ||
      policy.relay_limit < 1 ||
      policy.relay_limit > 1000 ||
      !Number.isSafeInteger(policy.upload_limit) ||
      policy.upload_limit < 1 ||
      policy.upload_limit > 100 ||
      !policy.deletion
    )
      throw new RelayError("invalid_maintenance_cycle_options");
    const p = policy.deletion;
    for (const key of [
      "lease_ms",
      "max_attempts",
      "retry_base_ms",
      "retry_cap_ms",
    ] as const)
      if (!Number.isSafeInteger(p[key]) || p[key] < 1)
        throw new RelayError("invalid_maintenance_cycle_options");
    if (
      p.lease_ms > 3600000 ||
      p.max_attempts > 1000 ||
      p.retry_cap_ms < p.retry_base_ms ||
      p.retry_cap_ms > 3600000
    )
      throw new RelayError("invalid_maintenance_cycle_options");
    this.#relay = relay;
    this.#uploads = uploads;
    this.#policy = Object.freeze({
      ...policy,
      deletion: Object.freeze({ ...p }),
    });
    this.#authorization = authorization;
  }
  workOnce(context: unknown): AttachmentMaintenanceResult {
    if (this.#running) throw new RelayError("maintenance_cycle_busy");
    this.#running = true;
    let live = true,
      owner: string | undefined;
    const authorize = () => {
      try {
        if (!live) throw Error();
        const decision = synchronous(
          this.#authorization?.authorize(context, "maintenance"),
        );
        if (!decision) throw Error();
        const id = uploadIdentifier(decision.agent_id);
        if (owner !== undefined && owner !== id) throw Error();
        owner = id;
      } catch {
        throw new RelayError("forbidden");
      }
    };
    const result: AttachmentMaintenanceResult = {
      state: "partial",
      completed_stages: 0,
      failed_stage: null,
      reason: null,
      relay: null,
      deletion: null,
      uploads: null,
    };
    let stage: "relay" | "deletion" | "uploads" = "relay";
    try {
      // Missing initial authority refuses before invoking even a harmless-looking store.
      authorize();
      try {
        const relay = synchronous(
          this.#relay.maintain(authorize, this.#policy.relay_limit),
        );
        if (
          !relay ||
          ![
            relay.expired,
            relay.purged,
            relay.threads,
            relay.safety_held,
          ].every(count) ||
          relay.expired + relay.purged + relay.threads >
            this.#policy.relay_limit
        )
          throw Error();
        result.relay = {
          expired: relay.expired,
          purged: relay.purged,
          threads: relay.threads,
          safety_held: relay.safety_held,
        };
        result.completed_stages = 1;
        authorize();
        stage = "deletion";
        const worker = new AttachmentDeletionWorker(
          this.#relay,
          this.#uploads,
          this.#policy.deletion,
          {
            authorize: () => {
              authorize();
              return { agent_id: owner! };
            },
          },
        );
        const deletion = synchronous(worker.workOnce(context));
        result.deletion = deletion.state;
        if (deletion.state === "deferred") {
          result.failed_stage = stage;
          result.reason = "deletion_deferred";
          return result;
        }
        result.completed_stages = 2;
        authorize();
        stage = "uploads";
        const uploads = synchronous(
          this.#uploads.maintain(authorize, this.#policy.upload_limit),
        );
        if (
          !uploads ||
          ![uploads.expired, uploads.purged].every(count) ||
          uploads.expired + uploads.purged > this.#policy.upload_limit
        )
          throw Error();
        result.uploads = { expired: uploads.expired, purged: uploads.purged };
        result.completed_stages = 3;
        authorize();
        result.state = "done";
        return result;
      } catch (error) {
        result.failed_stage = stage;
        result.reason =
          error instanceof RelayError && error.code === "forbidden"
            ? "forbidden"
            : "unavailable";
        return result;
      }
    } finally {
      live = false;
      this.#running = false;
    }
  }
}
