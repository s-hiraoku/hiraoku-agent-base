import test from "node:test";
import { request as httpRequest } from "node:http";
import { oauthFixture, resource, issuer } from "./relay-oauth-fixtures.js";
import process from "node:process";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  realpathSync,
  mkdirSync,
  writeFileSync,
  chmodSync,
  rmSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createHash } from "node:crypto";
import { startConfiguredLocalRelay } from "../src/relay-host/configured.ts";
import { limits, policy, envelope } from "./relay-http-fixtures.js";
import { options } from "./hab-registry-fixtures.js";
const cli = resolve("scripts/hab-relay.mjs");
function fixture(t) {
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
    },
    http,
  };
  const configPath = write("service.local.json", config);
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return { dir, write, config, configPath, keyPath, credentialsPath };
}
function list(url, token) {
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
test("private explicit config starts deny-all; digest binding authenticates only until file revocation", async (t) => {
  const f = fixture(t),
    host = await startConfiguredLocalRelay(f.configPath);
  t.after(() => host.close());
  assert.equal((await list(host.url)).status, 401);
  const token = "c".repeat(64),
    now = Date.now();
  f.write("credentials.local.json", {
    version: 1,
    credentials: [
      {
        sha256: createHash("sha256").update(token).digest("hex"),
        principal: {
          issuer: "urn:synthetic:local",
          audience: host.url,
          subject: "synthetic-owner",
          client_id: "synthetic-client",
          connection_id: "synthetic-a",
        },
        issued_at: new Date(now).toISOString(),
        expires_at: new Date(now + 900000).toISOString(),
      },
    ],
  });
  assert.equal((await list(host.url, token)).status, 200);
  f.write("credentials.local.json", { version: 1, credentials: [] });
  assert.equal((await list(host.url, token)).status, 401);
  const audit = readFileSync(join(f.dir, "audit/audit.jsonl"), "utf8");
  assert.ok(audit.includes("auth_denied"));
  assert.ok(!audit.includes(token));
  assert.ok(!audit.includes("synthetic-owner"));
});
test("missing credentials, malformed config or permissive key file never starts a fallback host", async (t) => {
  const f = fixture(t);
  f.write("credentials.local.json", { version: 99 });
  await assert.rejects(
    startConfiguredLocalRelay(f.configPath),
    /local_relay_start_rejected/,
  );
  assert.deepEqual(readdirSync(join(f.dir, "state")), []);
  f.write("credentials.local.json", { version: 1, credentials: [] });
  chmodSync(f.keyPath, 0o644);
  await assert.rejects(
    startConfiguredLocalRelay(f.configPath),
    /local_relay_start_rejected/,
  );
});
test("CLI requires explicit config and prints no config contents", async () => {
  const child = spawn(process.execPath, [cli], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stderr.on("data", (data) => {
    output += data;
  });
  const [code] = await once(child, "exit");
  assert.equal(code, 1);
  assert.equal(output, "local_relay_start_rejected\n");
});
test("CLI uses private state across SIGTERM/restart and closes its owned port", async (t) => {
  const f = fixture(t);
  for (let attempt = 0; attempt < 2; attempt++) {
    const child = spawn(process.execPath, [cli, "--config", f.configPath], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    t.after(() => {
      if (child.exitCode === null) child.kill("SIGTERM");
    });
    let output = "",
      errors = "";
    child.stderr.on("data", (data) => {
      errors += data;
    });
    const ready = new Promise((resolveReady, reject) => {
      child.once("exit", () =>
        reject(Error("CLI exited before ready: " + errors)),
      );
      child.stdout.on("data", (data) => {
        output += data;
        const first = output.split("\n")[0];
        if (first.endsWith("}")) resolveReady(JSON.parse(first));
      });
    });
    const info = await ready;
    assert.equal(info.state, "ready");
    assert.equal((await list(info.url)).status, 401);
    const exited = once(child, "exit");
    child.kill("SIGTERM");
    const [code, signal] = await exited;
    assert.equal(code, 0);
    assert.equal(signal, null);
    assert.ok(output.includes('"state":"stopped"'));
    assert.equal(errors, "");
    await assert.rejects(list(info.url));
  }
});

function ingressList(host) {
  return new Promise((resolve, reject) => {
    const q = httpRequest(
      {
        hostname: "127.0.0.1",
        port: host.ingress_port,
        path: "/hab/mcp",
        method: "POST",
        headers: {
          Host: "relay.example",
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        },
      },
      (r) => {
        r.resume();
        r.on("end", () => resolve(r));
      },
    );
    q.on("error", reject);
    q.end(JSON.stringify(envelope()));
  });
}
test("explicit disabled OAuth file starts an all-deny second ingress, separate from local auth", async (t) => {
  const f = fixture(t),
    path = f.write("oauth.local.json", {
      version: 1,
      enabled: false,
      issuer,
      resource,
      keys: [],
      connections: [],
    });
  f.config.ingress = {
    port: 0,
    resource_url: resource,
    oauth_file: path,
    allowed_origins: ["https://relay.example"],
  };
  f.write("service.local.json", f.config);
  const host = await startConfiguredLocalRelay(f.configPath);
  t.after(() => host.close());
  assert.equal(host.ingress_url, resource);
  const rejected = await ingressList(host);
  assert.equal(rejected.statusCode, 401);
  assert.match(rejected.headers["www-authenticate"], /resource_metadata=/);
  assert.equal((await list(host.url)).status, 401);
});
test("missing, permissive, invalid or mismatched OAuth config never creates a fallback ingress", async (t) => {
  const f = fixture(t),
    auth = await oauthFixture(),
    path = f.write("oauth.local.json", auth.getConfig());
  f.config.ingress = {
    port: 0,
    resource_url: resource,
    oauth_file: path,
    allowed_origins: [],
  };
  f.write("service.local.json", f.config);
  chmodSync(path, 0o644);
  await assert.rejects(
    startConfiguredLocalRelay(f.configPath),
    /local_relay_start_rejected/,
  );
  chmodSync(path, 0o600);
  f.config.ingress.resource_url = "https://other.example/hab/mcp";
  f.write("service.local.json", f.config);
  await assert.rejects(
    startConfiguredLocalRelay(f.configPath),
    /local_relay_start_rejected/,
  );
  f.config.ingress.resource_url = resource;
  f.config.ingress.oauth_file = join(f.dir, "absent.local.json");
  f.write("service.local.json", f.config);
  await assert.rejects(
    startConfiguredLocalRelay(f.configPath),
    /local_relay_start_rejected/,
  );
  delete f.config.ingress;
  f.write("service.local.json", f.config);
  const host = await startConfiguredLocalRelay(f.configPath);
  t.after(() => host.close());
  assert.equal((await list(host.url)).status, 401);
});
