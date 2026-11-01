import { lstatSync, writeFileSync, renameSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { isAbsolute, join, dirname } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { readRuntimeConfig } from "../../../src/runtime-config.ts";
import {
  startConfiguredLocalRelay,
  LocalRelayStartError,
} from "../../../src/relay-host/configured.ts";
import type {
  LocalRelayServiceFactory,
  LocalRelayServiceDependencies,
} from "../../../src/relay-host/local.ts";
import { RelayError } from "../../../src/relay/service.ts";
import { JetStreamRelay } from "./backend.ts";
import { HabJetStreamService } from "./hab-service.ts";

const positive = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$(?![\s\S])/);
const absolute = z.string().refine(isAbsolute);
const schema = z.strictObject({
  version: z.literal(1),
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
  routing: z
    .strictObject({
      epoch: positive,
      enabled: z.boolean(),
      recipients: z.array(id).max(256),
      kinds: z.array(id).min(1).max(64),
    })
    .refine(
      (value) =>
        new Set(value.recipients).size === value.recipients.length &&
        new Set(value.kinds).size === value.kinds.length,
    ),
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
  migrate_journal: z.boolean().optional(),
});
export type JetStreamHostConfig = z.infer<typeof schema>;
function read(path: string) {
  if (!isAbsolute(path) || lstatSync(path).nlink !== 1)
    throw Error("jetstream_private_config_required");
  return readRuntimeConfig(path);
}
export function readJetStreamHostConfig(path: string): JetStreamHostConfig {
  try {
    return schema.parse(read(path));
  } catch {
    throw new LocalRelayStartError("jetstream_config_rejected");
  }
}
export function createJetStreamServiceFactory(
  config: JetStreamHostConfig,
): LocalRelayServiceFactory {
  const policy = schema.parse(config);
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
      throw new RelayError("local_relay_extension_storage_unavailable");
    }
    return undefined;
  };
  const factory = async (dependencies: LocalRelayServiceDependencies) => {
    const assertCurrent = () => {
      dependencies.assertOwner();
      assertVolume(dependencies.directory);
    };
    assertCurrent();
    const maintenanceContext = Symbol("jetstream-host-maintenance");
    const backend = await JetStreamRelay.open({
      ...dependencies.store_options,
      journal_path: join(dependencies.directory, "jetstream-journal.sqlite"),
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
      route_epoch: policy.routing.epoch,
      migrate_journal: policy.migrate_journal,
      prefetch_per_recipient: Math.min(
        dependencies.store_options.max_pending_per_recipient,
        dependencies.store_options.max_pending,
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
        dependencies.store,
        backend,
        dependencies.limits,
        policy.routing,
        dependencies.store_options,
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
      "routing_epoch_conflict",
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
            error instanceof RelayError && safeReasons.has(error.code)
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
  return Object.assign(factory, {
    extension_id: "hab-jetstream-v1",
    preflight: assertVolume,
  });
}
export function startConfiguredJetStreamRelay(
  configPath: string,
  jetstreamConfigPath: string,
) {
  const factory = createJetStreamServiceFactory(
    readJetStreamHostConfig(jetstreamConfigPath),
  );
  return startConfiguredLocalRelay(configPath, factory);
}
