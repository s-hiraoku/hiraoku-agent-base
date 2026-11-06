/** Explicit private file composition. No configuration discovery or credential generation. */
import { lstatSync } from "node:fs";
import { isAbsolute } from "node:path";
import { z } from "zod";
import { habDiscoveryPolicySchema } from "../hab/discovery.ts";
import { readRuntimeConfig } from "../runtime-config.ts";
import { deliverySchema } from "./delivery.ts";
const positive = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const absolute = z.string().refine(isAbsolute);
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
  registry: z.strictObject({
    authentication_groups: z.boolean().optional(),
    agent_rename: z.boolean().optional(),
    discovery: habDiscoveryPolicySchema.optional(),
    max_products: positive,
    max_agents: positive,
    max_bindings: positive,
    max_requests: positive,
    max_blocks: positive,
    max_audit_records: positive,
    max_context_ms: positive,
    busy_timeout_ms: positive,
    allowed_kinds: z.array(z.string()).min(1),
  }),
  delivery: deliverySchema,
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
