import { lstatSync, writeFileSync, renameSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { isAbsolute, join, dirname } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { readRuntimeConfig } from "../runtime-config.ts";
import type { DeliveryFactory, DeliveryDependencies } from "./server.ts";
import { MessagingError } from "../messaging/delivery-service.ts";
import { JetStreamRelay } from "../../packages/relay-nats/src/backend.ts";
import { HabJetStreamService } from "./hab-delivery-service.ts";

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
/** The host config's `delivery` section. JetStream is the only delivery backend. */
export const deliverySchema = z.strictObject({
  broker: z.strictObject({
    server: z.string(),
    user: z.string().min(1),
    password: z.string().min(1),
    stream: z.string(),
    subject_prefix: z.string(),
    max_consumers: positive,
    max_bytes: positive,
    max_message_bytes: positive,
    request_timeout_ms: positive.max(30000),
  }),
  pump: z.strictObject({
    interval_ms: positive.max(60000),
    max_records_per_cycle: positive.max(1000),
  }),
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
  migrate_journal: z.boolean().optional(),
});
export type DeliveryConfig = z.infer<typeof deliverySchema>;
function read(path: string) {
  if (!isAbsolute(path) || lstatSync(path).nlink !== 1)
    throw Error("jetstream_private_config_required");
  return readRuntimeConfig(path);
}
export function createJetStreamDelivery(
  config: DeliveryConfig,
  fingerprintKey: Uint8Array,
): DeliveryFactory {
  const policy = deliverySchema.parse(config);
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
      throw new MessagingError("local_relay_extension_storage_unavailable");
    }
    return undefined;
  };
  const factory = async (dependencies: DeliveryDependencies) => {
    const assertCurrent = () => {
      dependencies.assertOwner();
      assertVolume(dependencies.directory);
    };
    assertCurrent();
    const maintenanceContext = Symbol("jetstream-host-maintenance");
    const backend = await JetStreamRelay.open({
      ...policy.queue,
      fingerprint_key: key,
      journal_path: dependencies.privateFile("jetstream-journal.sqlite"),
      server: policy.broker.server,
      user: policy.broker.user,
      password: policy.broker.password,
      stream: policy.broker.stream,
      subject_prefix: policy.broker.subject_prefix,
      max_consumers: policy.broker.max_consumers,
      broker_max_bytes: policy.broker.max_bytes,
      broker_max_message_bytes: policy.broker.max_message_bytes,
      request_timeout_ms: policy.broker.request_timeout_ms,
      limits: dependencies.limits,
      migrate_journal: policy.migrate_journal,
      prefetch_per_recipient: Math.min(
        policy.queue.max_pending_per_recipient,
        policy.queue.max_pending,
      ),
      reconnect: true,
      authorization: {
        authorize: (context, operation) =>
          context === maintenanceContext && operation === "maintenance"
            ? { agent_id: "jetstream-host-maintenance" }
            : undefined,
      },
    });
    let service: HabJetStreamService;
    try {
      service = new HabJetStreamService(
        dependencies.registry,
        backend,
        policy.queue,
        assertCurrent,
      );
    } catch (error) {
      await backend.close();
      throw error;
    }
    const abort = new AbortController();
    let stopped = false;
    let lastHealth: string | null | undefined;
    const recordHealth = (reason: string | null) => {
      if (lastHealth === reason) return;
      assertCurrent();
      const path = join(dependencies.directory, "jetstream-health.local.json");
      try {
        lstatSync(path);
        read(path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      const temporary = join(
        dependencies.directory,
        `.jetstream-health-${randomUUID()}.tmp`,
      );
      try {
        writeFileSync(
          temporary,
          JSON.stringify({
            version: 1,
            changed_at: new Date().toISOString(),
            state: reason === null ? "ready" : "degraded",
            reason,
          }),
          { flag: "wx", mode: 0o600 },
        );
        renameSync(temporary, path);
        lastHealth = reason;
      } finally {
        rmSync(temporary, { force: true });
      }
    };
    const safeReasons = new Set([
      "broker_unavailable",
      "capacity_exceeded",
      "broker_store_missing",
      "broker_integrity_failed",
      "journal_integrity_failed",
      "broker_configuration_mismatch",
      "consumer_configuration_mismatch",
      "maintenance_state_unavailable",
      "local_relay_extension_storage_unavailable",
    ]);
    const loop = (async () => {
      while (!stopped) {
        try {
          assertCurrent();
          await backend.pumpOnce(policy.pump.max_records_per_cycle);
          recordHealth(null);
        } catch (error) {
          const reason =
            error instanceof MessagingError && safeReasons.has(error.code)
              ? error.code
              : "pump_failed";
          try {
            recordHealth(reason);
          } catch {
            /* A missing data volume must not receive diagnostic files on its fallback path. */
          }
        }
        if (stopped) break;
        try {
          await delay(policy.pump.interval_ms, undefined, {
            signal: abort.signal,
          });
        } catch (error) {
          if (!abort.signal.aborted) throw error;
        }
      }
    })();
    let closing: Promise<void> | undefined;
    return {
      service,
      close() {
        if (closing) return closing;
        stopped = true;
        abort.abort();
        closing = (async () => {
          try {
            await loop;
          } finally {
            await backend.close();
          }
        })();
        return closing;
      },
    };
  };
  return Object.assign(factory, { preflight: assertVolume });
}
