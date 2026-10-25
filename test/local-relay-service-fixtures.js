import {
  mkdtempSync,
  realpathSync,
  mkdirSync,
  writeFileSync,
  chmodSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { limits, policy, envelope } from "./relay-http-fixtures.js";
import { options } from "./hab-registry-fixtures.js";
export function fixture(t) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "local-relay-service-")));
  chmodSync(dir, 0o700);
  for (const sub of ["state", "audit"])
    mkdirSync(join(dir, sub), { mode: 0o700 });
  const write = (name, value) => {
    const path = join(dir, name);
    writeFileSync(path, JSON.stringify(value), { mode: 0o600 });
    return path;
  };
  const registry = { ...options };
  delete registry.fingerprint_key;
  const http = { ...policy };
  delete http.resource_url;
  delete http.allowed_origins;
  const keyPath = write("keys.local.json", {
    version: 1,
    registry_fingerprint_key: "11".repeat(32),
    relay_fingerprint_key: "22".repeat(32),
  });
  const credentialsPath = write("credentials.local.json", {
    version: 1,
    credentials: [],
  });
  const config = {
    version: 1,
    directory: join(dir, "state"),
    port: 0,
    keys_file: keyPath,
    credentials_file: credentialsPath,
    audit_directory: join(dir, "audit"),
    audit_max_bytes: 262144,
    limits,
    registry,
    store: {
      max_pending: 20,
      max_records: 100,
      max_pending_per_recipient: 10,
      max_body_bytes: 100000,
      max_clock_skew_ms: 1000,
      lease_ms: 30000,
      max_attempts: 3,
      retry_base_ms: 10,
      retry_cap_ms: 100,
      poll_scan_limit: 20,
      agent_capacity: {
        max_pending_per_sender: 10,
        max_body_bytes_per_sender: 50000,
        max_records_per_sender: 25,
        max_body_bytes_per_recipient: 50000,
        max_records_per_recipient: 50,
        reservations: [],
      },
    },
    http,
  };
  const configPath = write("service.local.json", config);
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return { dir, write, config, configPath, keyPath, credentialsPath };
}
export function list(url, token) {
  return globalThis.fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-method": "tools/list",
      "mcp-protocol-version": "2026-07-28",
      ...(token ? { authorization: "Bearer " + token } : {}),
    },
    body: JSON.stringify(envelope()),
  });
}
