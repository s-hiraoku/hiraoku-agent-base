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
export async function startConfiguredLocalRelay(configPath: string) {
  try {
    const config = schema.parse(read(configPath)),
      secrets = keys.parse(read(config.keys_file));
    const auth = new LocalBearerAuthority(() => read(config.credentials_file));
    const remote = config.ingress
      ? await PinnedRelayOAuthAuthority.create(() =>
          read(config.ingress!.oauth_file),
        )
      : undefined;
    if (remote && remote.resource.resource !== config.ingress!.resource_url)
      throw Error("local_relay_resource_mismatch");
    let sink: LocalAudit | undefined;
    const host = await startLocalRelay({
      directory: config.directory,
      port: config.port,
      limits: config.limits,
      registry: {
        ...config.registry,
        fingerprint_key: Buffer.from(secrets.registry_fingerprint_key, "hex"),
      },
      store: {
        ...config.store,
        fingerprint_key: Buffer.from(secrets.relay_fingerprint_key, "hex"),
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
    try {
      sink = new LocalAudit(config.audit_directory, config.audit_max_bytes);
      return host;
    } catch (error) {
      await host.close();
      throw error;
    }
  } catch {
    throw Error("local_relay_start_rejected");
  }
}
