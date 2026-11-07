/** Explicit private file composition. No configuration discovery or credential generation. */
import { lstatSync } from "node:fs";
import { isAbsolute } from "node:path";
import { z } from "zod";
import { registryOptionsSchema } from "../hab/sqlite-registry.ts";
import { readRuntimeConfig } from "../runtime-config.ts";
import { deliverySchema } from "./delivery.ts";
import { HAB_ADDRESS_PATTERN } from "../hab/registry.ts";
const positive = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const absolute = z.string().refine(isAbsolute);
const address = z.string().max(101).regex(new RegExp(HAB_ADDRESS_PATTERN));
/** The optional host A2A entry (src/host/a2a.ts). */
const a2aConfigSchema = z
  .strictObject({
    /** Separate loopback listener; 0 selects an ephemeral port. */
    port: z.number().int().min(0).max(65535),
    /** The host-owned address. No operator credential may be bound to it. */
    identity: address,
    /** The one recipient every A2A Task is sent to. */
    recipient: address,
    poll_interval_ms: z.number().int().min(10).max(60000),
    max_active_requests: z.number().int().min(1).max(64),
    /** Outbox and inbox record cap; accepted records are retained for 30 days. */
    max_records: z.number().int().min(1).max(10000),
  })
  .refine((value) => value.identity !== value.recipient, {
    path: ["recipient"],
  });
export type HostA2aConfig = z.infer<typeof a2aConfigSchema>;
const keys = z.strictObject({
  version: z.literal(1),
  registry_fingerprint_key: z.string().regex(/^[a-f0-9]{64}$(?![\s\S])/),
  relay_fingerprint_key: z.string().regex(/^[a-f0-9]{64}$(?![\s\S])/),
});
const schema = z.strictObject({
  version: z.literal(1),
  directory: absolute,
  port: z.number().int().min(0).max(65535),
  ingress: z
    .strictObject({
      port: z.number().int().min(0).max(65535),
      resource_url: z.string(),
      oauth_file: absolute,
      allowed_origins: z.array(z.string()).max(8),
    })
    .optional(),
  keys_file: absolute,
  credentials_file: absolute,
  audit_directory: absolute,
  audit_max_bytes: positive,
  limits: z.strictObject({
    envelope_bytes: positive,
    text_bytes: positive,
    data_bytes: positive,
    parts: positive,
    json_depth: positive,
    json_nodes: positive,
  }),
  registry: registryOptionsSchema,
  delivery: deliverySchema,
  /** Absent means A2A is off: no listener, mailbox or host identity. */
  a2a: a2aConfigSchema.optional(),
  http: z.strictObject({
    max_request_bytes: positive,
    max_response_bytes: positive,
    timeout_ms: positive,
    max_active_requests: positive,
    requests_per_window: positive,
    window_ms: positive,
  }),
});
function read(path: string) {
  // Preserve the existing bounded/canonical/private file reader and additionally reject hardlinks.
  if (!isAbsolute(path) || lstatSync(path).nlink !== 1)
    throw Error("local_relay_config_rejected");
  return readRuntimeConfig(path);
}
/**
 * Startup refusal with a fixed reason code and, for schema failures, the offending
 * config field paths. Never carries file contents, paths, secrets or values.
 */
export class HostStartError extends Error {
  readonly reason: string;
  readonly fields: readonly string[];
  constructor(reason: string, fields: readonly string[] = []) {
    super("local_relay_start_rejected");
    this.name = "HostStartError";
    this.reason = reason;
    this.fields = Object.freeze([...fields]);
  }
}
export function stage<T>(reason: string, action: () => T): T {
  try {
    return action();
  } catch (error) {
    if (error instanceof HostStartError) throw error;
    if (error instanceof z.ZodError)
      throw new HostStartError(
        reason,
        [
          ...new Set(
            error.issues.flatMap((issue) =>
              // Name a retired or misspelled section (such as `store`) instead of only its parent.
              issue.code === "unrecognized_keys"
                ? issue.keys.map((key) => [...issue.path, key].join("."))
                : [issue.path.join(".") || "(root)"],
            ),
          ),
        ]
          .sort()
          .slice(0, 16),
      );
    throw new HostStartError(reason);
  }
}
/** Validates the operator config and returns it with decoded keys; throws HostStartError. */
export function readHostConfig(configPath: string) {
  const config = stage("config_invalid", () =>
    schema.parse(stage("config_file_rejected", () => read(configPath))),
  );
  const secrets = stage("keys_invalid", () =>
    keys.parse(stage("keys_file_rejected", () => read(config.keys_file))),
  );
  return {
    config,
    registry_fingerprint_key: Buffer.from(
      secrets.registry_fingerprint_key,
      "hex",
    ),
    relay_fingerprint_key: Buffer.from(secrets.relay_fingerprint_key, "hex"),
    readCredentials: () => read(config.credentials_file),
    readOAuth: () =>
      config.ingress ? read(config.ingress.oauth_file) : undefined,
  };
}
