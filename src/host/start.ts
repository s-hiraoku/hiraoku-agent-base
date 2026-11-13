/** Starts the configured host: local auth, optional OAuth ingress, JetStream delivery and audit. */
import { LocalAudit } from "../local-audit.ts";
import { LocalBearerAuthority } from "./local-auth.ts";
import { PinnedOAuthAuthority } from "./oauth-auth.ts";
import { startHostServer } from "./server.ts";
import { createJetStreamDelivery } from "./delivery.ts";
import { HostStartError, readHostConfig, stage } from "./config.ts";
// Fixed codes from the composed classes that are safe and useful to surface.
const hostReasons = new Set([
  "local_relay_private_path_required",
  "local_relay_extension_storage_unavailable",
  "broker_unavailable",
  "broker_store_missing",
  "broker_configuration_mismatch",
  "unsupported_broker_version",
  "loopback_broker_required",
  "journal_migration_required",
  "journal_key_or_version_mismatch",
  "unknown_journal_schema",
  "insecure_journal_file",
  "insufficient_prefetch_window",
  "invalid_local_relay_options",
  "invalid_local_relay_ingress",
  "invalid_local_relay_a2a",
  "a2a_identity_conflict",
  "a2a_identity_retired",
  "a2a_identity_renamed",
  "a2a_identity_revoked",
  "a2a_identity_stopped",
  "registry_key_mismatch",
  "unsupported_registry_schema",
  "unsupported_registry_name_schema",
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
export async function startHost(configPath: string) {
  try {
    const { config, readCredentials, readOAuth, ...secrets } =
      readHostConfig(configPath);
    const auth = stage(
      "credentials_invalid",
      () => new LocalBearerAuthority(readCredentials),
    );
    let remote: PinnedOAuthAuthority | undefined;
    try {
      remote = config.ingress
        ? await PinnedOAuthAuthority.create(readOAuth)
        : undefined;
    } catch {
      throw new HostStartError("oauth_invalid");
    }
    if (remote && remote.resource.resource !== config.ingress!.resource_url)
      throw new HostStartError("oauth_resource_mismatch");
    const delivery = stage("config_invalid", () =>
      createJetStreamDelivery(config.delivery, secrets.relay_fingerprint_key),
    );
    let sink: LocalAudit | undefined;
    let host: Awaited<ReturnType<typeof startHostServer>>;
    try {
      host = await startHostServer({
        directory: config.directory,
        port: config.port,
        limits: config.limits,
        registry: {
          ...config.registry,
          fingerprint_key: secrets.registry_fingerprint_key,
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
        delivery,
        ...(config.a2a ? { a2a: config.a2a } : {}),
      });
    } catch (error) {
      throw new HostStartError(hostReason(error));
    }
    try {
      sink = new LocalAudit(config.audit_directory, config.audit_max_bytes);
      return host;
    } catch {
      await host.close();
      throw new HostStartError("audit_unavailable");
    }
  } catch (error) {
    if (error instanceof HostStartError) throw error;
    throw new HostStartError("start_failed");
  }
}
