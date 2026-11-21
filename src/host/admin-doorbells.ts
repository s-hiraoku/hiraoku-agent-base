/**
 * `hab:admin doorbell add | remove | list` (plan 3): operator doorbells (ADR-029) kept in
 * the events store, which the running host reads again on its next pass, so adding or
 * removing one needs no restart. The registry row refers to a secret file; command
 * output names only the URL's host.
 */
import { existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { readHostConfig } from "./config.ts";
import { readDoorbellSecretFile } from "./doorbell-secret.ts";
import { HostAdminError, hostAdminStatus } from "./admin.ts";
import { doorbellSecret, operatorCallbackUrl } from "../hab/events.ts";
import { parseHabAddress } from "../hab/registry.ts";

function store(configPath: string) {
  const { config } = readHostConfig(configPath);
  if (!config.ingress?.events)
    throw new HostAdminError("events_not_configured");
  const path = join(config.directory, "events.sqlite");
  // The host creates the store and its tables; admin never does.
  if (!existsSync(path)) throw new HostAdminError("events_not_initialized");
  const db = new DatabaseSync(path, { timeout: 5000 });
  const table = db
    .prepare(
      "SELECT 1 FROM sqlite_master WHERE type='table' AND name='hab_event_doorbells'",
    )
    .get();
  if (!table) {
    db.close();
    throw new HostAdminError("events_upgrade_pending");
  }
  return { db, configured: config.ingress.events.doorbells ?? [] };
}
function address(raw: string) {
  try {
    return parseHabAddress(raw).address;
  } catch {
    throw new HostAdminError("invalid_address");
  }
}
const hostOf = (url: string) => {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
};
const APPLIES = "host の次の配送の確認で効く。再起動は要らない。";

export interface DoorbellAddInput {
  address: string;
  url: string;
  secret_file: string;
}

export function hostAdminDoorbellAdd(
  configPath: string,
  input: DoorbellAddInput,
  now = Date.now(),
) {
  const target = address(input.address);
  const known = hostAdminStatus(configPath, now).addresses.find(
    (entry) => entry.address === target,
  );
  if (!known) throw new HostAdminError("address_not_found");
  if (known.state !== "active") throw new HostAdminError("address_not_active");
  let url: string;
  try {
    url = operatorCallbackUrl(input.url).href;
  } catch {
    throw new HostAdminError("invalid_doorbell");
  }
  if (!isAbsolute(input.secret_file))
    throw new HostAdminError("unsafe_doorbell_secret");
  try {
    doorbellSecret(readDoorbellSecretFile(input.secret_file));
  } catch {
    throw new HostAdminError("unsafe_doorbell_secret");
  }
  const { db } = store(configPath);
  try {
    const before = db
      .prepare(
        "SELECT url,secret_file FROM hab_event_doorbells WHERE address=?",
      )
      .get(target) as { url: string; secret_file: string } | undefined;
    db.prepare(
      `INSERT INTO hab_event_doorbells (address,url,secret_file,added_at) VALUES (?,?,?,?)
       ON CONFLICT(address) DO UPDATE SET url=excluded.url, secret_file=excluded.secret_file,
         added_at=excluded.added_at`,
    ).run(target, url, input.secret_file, now);
    return {
      address: target,
      host: hostOf(url),
      replaced: !!before,
      unchanged:
        !!before &&
        before.url === url &&
        before.secret_file === input.secret_file,
      applies: APPLIES,
    };
  } finally {
    db.close();
  }
}

export function hostAdminDoorbellRemove(configPath: string, raw: string) {
  const target = address(raw);
  const { db, configured } = store(configPath);
  try {
    const removed =
      db.prepare("DELETE FROM hab_event_doorbells WHERE address=?").run(target)
        .changes > 0;
    // A config doorbell for the address comes back into use; it needs a config edit.
    const inConfig = configured.some((d) => d.address === target);
    return {
      address: target,
      removed,
      still_in_config: inConfig,
      applies: APPLIES,
    };
  } finally {
    db.close();
  }
}

export function hostAdminDoorbellList(configPath: string) {
  const { db, configured } = store(configPath);
  try {
    const registered = db
      .prepare(
        "SELECT address,url,added_at FROM hab_event_doorbells ORDER BY address",
      )
      .all() as { address: string; url: string; added_at: number }[];
    const replaced = new Set(registered.map((row) => row.address));
    return {
      doorbells: [
        ...registered.map((row) => ({
          address: row.address,
          host: hostOf(row.url),
          source: "registry" as const,
          added_at: new Date(row.added_at).toISOString(),
        })),
        ...configured.map((d) => ({
          address: d.address,
          host: hostOf(d.url),
          source: "config" as const,
          // The registered doorbell for the same address is the one that rings.
          in_use: !replaced.has(d.address),
        })),
      ],
    };
  } finally {
    db.close();
  }
}
