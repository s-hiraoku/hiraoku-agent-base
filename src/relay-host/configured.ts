/** Explicit private file composition. No configuration discovery or credential generation. */
import { lstatSync } from "node:fs";
import { isAbsolute } from "node:path";
import { z } from "zod";
import { readRuntimeConfig } from "../runtime-config.ts";
import { LocalAudit } from "../local-audit.ts";
import { LocalBearerAuthority } from "./local-auth.ts";
import { PinnedRelayOAuthAuthority } from "./oauth-auth.ts";
import { startLocalRelay } from "./local.ts";
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
    attachment_bytes: positive,
    total_attachment_bytes: positive,
    parts: positive,
    attachments: positive,
    json_depth: positive,
    json_nodes: positive,
  }),
  registry: z.strictObject({
    authentication_groups: z.boolean().optional(),
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
  store: z
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
      (store) =>
        store.agent_capacity.max_records_per_sender < store.max_records &&
        store.agent_capacity.max_pending_per_sender < store.max_pending,
    ),
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
export class LocalRelayStartError extends Error {
  readonly reason: string;
  readonly fields: readonly string[];
  constructor(reason: string, fields: readonly string[] = []) {
    super("local_relay_start_rejected");
    this.name = "LocalRelayStartError";
    this.reason = reason;
    this.fields = Object.freeze([...fields]);
  }
}
function stage<T>(reason: string, action: () => T): T {
  try {
    return action();
  } catch (error) {
    if (error instanceof LocalRelayStartError) throw error;
    if (error instanceof z.ZodError)
      throw new LocalRelayStartError(
        reason,
        [
          ...new Set(
            error.issues.map((issue) => issue.path.join(".") || "(root)"),
          ),
        ].slice(0, 16),
      );
    throw new LocalRelayStartError(reason);
  }
}
// Fixed codes from the composed classes that are safe and useful to surface.
const hostReasons = new Set([
  "local_relay_private_path_required",
  "invalid_local_relay_options",
  "invalid_local_relay_ingress",
  "registry_key_mismatch",
  "unsupported_registry_schema",
  "unknown_registry_schema",
  "insecure_registry_file",
  "fingerprint_key_mismatch",
  "unknown_schema",
  "unsupported_schema",
  "unsupported_host_owner_schema",
  "unknown_host_owner_schema",
]);
function hostReason(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code === "EADDRINUSE") return "port_in_use";
  // Another Relay process already owns this state directory.
  if ((error as Error | undefined)?.message === "host_owner_busy")
    return "state_in_use";
  if (code === "EACCES") return "port_or_file_access_denied";
  if (code === "ENOENT") return "state_path_missing";
  for (const value of [code, (error as Error | undefined)?.message])
    if (typeof value === "string" && hostReasons.has(value)) return value;
  return "host_start_failed";
}
/** Validates the operator config and returns it with decoded keys; throws LocalRelayStartError. */
export function readLocalRelayConfig(configPath: string) {
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
export async function startConfiguredLocalRelay(configPath: string) {
  try {
    const { config, readCredentials, readOAuth, ...secrets } =
      readLocalRelayConfig(configPath);
    const auth = stage(
      "credentials_invalid",
      () => new LocalBearerAuthority(readCredentials),
    );
    let remote: PinnedRelayOAuthAuthority | undefined;
    try {
      remote = config.ingress
        ? await PinnedRelayOAuthAuthority.create(readOAuth)
        : undefined;
    } catch {
      throw new LocalRelayStartError("oauth_invalid");
    }
    if (remote && remote.resource.resource !== config.ingress!.resource_url)
      throw new LocalRelayStartError("oauth_resource_mismatch");
    let sink: LocalAudit | undefined;
    let host: Awaited<ReturnType<typeof startLocalRelay>>;
    try {
      host = await startLocalRelay({
        directory: config.directory,
        port: config.port,
        limits: config.limits,
        registry: {
          ...config.registry,
          fingerprint_key: secrets.registry_fingerprint_key,
        },
        store: {
          ...config.store,
          fingerprint_key: secrets.relay_fingerprint_key,
        },
        http: config.http,
        ...(config.ingress && remote
          ? {
              ingress: {
                port: config.ingress.port,
                resource_url: config.ingress.resource_url,
                issuer: remote.resource.issuer,
                allowed_origins: config.ingress.allowed_origins,
                authority: remote.authority,
                verify: remote.verify,
              },
            }
          : {}),
        authority: auth.authority,
        verify: auth.verify,
        audit: {
          record: (category, correlation) => {
            if (!sink) throw Error("local_relay_audit_unavailable");
            sink.record(category, correlation);
          },
        },
      });
    } catch (error) {
      throw new LocalRelayStartError(hostReason(error));
    }
    try {
      sink = new LocalAudit(config.audit_directory, config.audit_max_bytes);
      return host;
    } catch {
      await host.close();
      throw new LocalRelayStartError("audit_unavailable");
    }
  } catch (error) {
    if (error instanceof LocalRelayStartError) throw error;
    throw new LocalRelayStartError("start_failed");
  }
}
