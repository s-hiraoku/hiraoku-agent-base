import { existsSync, lstatSync } from "node:fs";
import { isAbsolute, join, dirname } from "node:path";
import { z } from "zod";
import { readRuntimeConfig } from "../runtime-config.ts";
import type { DeliveryFactory, DeliveryDependencies } from "./server.ts";
import { MessagingError } from "../messaging/delivery-service.ts";
import { SqliteDelivery } from "../delivery/sqlite-delivery.ts";
import { HabDeliveryService } from "./hab-delivery-service.ts";

const positive = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$(?![\s\S])/);
const absolute = z.string().refine(isAbsolute);
const queue = z
  .strictObject({
    max_pending: positive,
    max_records: positive,
    max_pending_per_recipient: positive,
    max_body_bytes: positive,
    max_clock_skew_ms: z.number().int().nonnegative(),
    lease_ms: positive,
    max_attempts: positive,
    retry_base_ms: positive,
    retry_cap_ms: positive,
    poll_scan_limit: positive,
    fair_poll: z.boolean().optional(),
    // Required: without a per-sender budget one enrolled sender can fill the retained-record pool for every agent.
    agent_capacity: z.strictObject({
      max_pending_per_sender: positive,
      max_body_bytes_per_sender: positive,
      max_records_per_sender: positive,
      max_body_bytes_per_recipient: positive,
      max_records_per_recipient: positive,
      reservations: z
        .array(
          z.strictObject({
            sender_id: z.string(),
            pending: positive,
            body_bytes: positive,
            records: positive,
          }),
        )
        .max(256),
    }),
  })
  .refine(
    (value) =>
      value.agent_capacity.max_records_per_sender < value.max_records &&
      value.agent_capacity.max_pending_per_sender < value.max_pending,
  );
/** The host config's `delivery` section. SQLite is the only delivery store (ADR-018). */
export const deliverySchema = z.strictObject({
  volume: z.strictObject({
    identity_file: absolute,
    expected_id: id,
    expected_device: z
      .number()
      .int()
      .nonnegative()
      .max(Number.MAX_SAFE_INTEGER),
  }),
  queue,
  maintenance: z
    .strictObject({
      interval_ms: positive.max(3_600_000),
      max_records_per_cycle: positive.max(1000),
    })
    .optional(),
});
export type DeliveryConfig = z.infer<typeof deliverySchema>;
/** The retired JetStream journal. Its messages are not migrated, so it must be drained and removed first. */
export const LEGACY_JETSTREAM_JOURNAL = "jetstream-journal.sqlite";
function read(path: string) {
  if (!isAbsolute(path) || lstatSync(path).nlink !== 1)
    throw Error("delivery_private_config_required");
  return readRuntimeConfig(path);
}
export function createSqliteDelivery(
  config: DeliveryConfig,
  fingerprintKey: Uint8Array,
): DeliveryFactory {
  const policy = deliverySchema.parse(config);
  const maintenance = policy.maintenance ?? {
    interval_ms: 60_000,
    max_records_per_cycle: 100,
  };
  const key = Uint8Array.from(fingerprintKey);
  const assertVolume = (directory: string): undefined => {
    try {
      const marker = z
        .strictObject({ version: z.literal(1), volume_id: id })
        .parse(read(policy.volume.identity_file));
      const data = lstatSync(directory),
        identity = lstatSync(policy.volume.identity_file);
      if (
        dirname(policy.volume.identity_file) !== directory ||
        data.dev !== identity.dev ||
        data.dev !== policy.volume.expected_device ||
        marker.volume_id !== policy.volume.expected_id
      )
        throw Error("volume_identity_mismatch");
    } catch {
      throw new MessagingError("host_extension_storage_unavailable");
    }
    return undefined;
  };
  const preflight = (directory: string): undefined => {
    assertVolume(directory);
    if (existsSync(join(directory, LEGACY_JETSTREAM_JOURNAL)))
      throw new MessagingError("legacy_jetstream_journal_present");
    return undefined;
  };
  const factory = async (dependencies: DeliveryDependencies) => {
    const assertCurrent = () => {
      dependencies.assertOwner();
      assertVolume(dependencies.directory);
    };
    preflight(dependencies.directory);
    assertCurrent();
    const maintenanceContext = Symbol("delivery-host-maintenance");
    const store = SqliteDelivery.open({
      ...policy.queue,
      fingerprint_key: key,
      path: dependencies.privateFile("delivery.sqlite"),
      limits: dependencies.limits,
      authorization: {
        authorize: (context, operation) =>
          context === maintenanceContext && operation === "maintenance"
            ? { agent_id: "delivery-host-maintenance" }
            : undefined,
      },
    });
    let service: HabDeliveryService;
    try {
      store.maintain(maintenanceContext, maintenance.max_records_per_cycle);
      service = new HabDeliveryService(
        dependencies.registry,
        store,
        assertCurrent,
      );
    } catch (error) {
      store.close();
      throw error;
    }
    const timer = setInterval(() => {
      try {
        assertCurrent();
        store.maintain(maintenanceContext, maintenance.max_records_per_cycle);
      } catch {
        /* Each operation also expires overdue records; a failed purge retries next cycle. */
      }
    }, maintenance.interval_ms);
    timer.unref();
    let closing: Promise<void> | undefined;
    return {
      service,
      close() {
        if (closing) return closing;
        clearInterval(timer);
        store.close();
        closing = Promise.resolve();
        return closing;
      },
    };
  };
  return Object.assign(factory, { preflight });
}
