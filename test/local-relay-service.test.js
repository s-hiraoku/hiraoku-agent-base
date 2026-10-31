import test from "node:test";
import { request as httpRequest } from "node:http";
import { oauthFixture, resource, issuer } from "./relay-oauth-fixtures.js";
import process from "node:process";
import assert from "node:assert/strict";
import { chmodSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import {
  readLocalRelayConfig,
  startConfiguredLocalRelay,
} from "../src/relay-host/configured.ts";
import { envelope } from "./relay-http-fixtures.js";
import { fixture, list } from "./local-relay-service-fixtures.js";
const cli = resolve("scripts/hab-relay.mjs");
test("explicit group configuration creates registry v2 and stays deny-all across restart", async (t) => {
  const f = fixture(t);
  f.config.registry.authentication_groups = true;
  f.write("service.local.json", f.config);
  const first = await startConfiguredLocalRelay(f.configPath);
  try {
    assert.equal((await list(first.url)).status, 401);
  } finally {
    await first.close();
  }
  const raw = new DatabaseSync(join(f.config.directory, "registry.sqlite"), {
    readOnly: true,
  });
  try {
    assert.equal(
      raw.prepare("SELECT version FROM hab_registry_meta").get().version,
      2,
    );
    assert.equal(
      raw.prepare("SELECT count(*) n FROM hab_auth_groups").get().n,
      0,
    );
  } finally {
    raw.close();
  }
  const next = await startConfiguredLocalRelay(f.configPath);
  try {
    assert.equal((await list(next.url)).status, 401);
  } finally {
    await next.close();
  }
});
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
test("configured store requires a per-sender capacity smaller than the shared pool", async (t) => {
  const f = fixture(t);
  const store = { ...f.config.store };
  delete store.agent_capacity;
  for (const variant of [
    store,
    {
      ...f.config.store,
      agent_capacity: {
        ...f.config.store.agent_capacity,
        max_records_per_sender: f.config.store.max_records,
      },
    },
    {
      ...f.config.store,
      agent_capacity: {
        ...f.config.store.agent_capacity,
        max_pending_per_sender: f.config.store.max_pending,
      },
    },
  ]) {
    f.write("service.local.json", { ...f.config, store: variant });
    await assert.rejects(
      startConfiguredLocalRelay(f.configPath),
      /local_relay_start_rejected/,
    );
    assert.deepEqual(readdirSync(join(f.dir, "state")), []);
  }
  f.write("service.local.json", f.config);
  const host = await startConfiguredLocalRelay(f.configPath);
  await host.close();
});
test("startup refusal names a fixed reason and config fields, never values", async (t) => {
  const f = fixture(t);
  const store = { ...f.config.store };
  delete store.agent_capacity;
  f.write("service.local.json", { ...f.config, store });
  await assert.rejects(startConfiguredLocalRelay(f.configPath), (error) => {
    assert.equal(error.message, "local_relay_start_rejected");
    assert.equal(error.reason, "config_invalid");
    assert.deepEqual(error.fields, ["store.agent_capacity"]);
    return true;
  });
  f.write("service.local.json", f.config);
  chmodSync(f.keyPath, 0o644);
  await assert.rejects(startConfiguredLocalRelay(f.configPath), {
    reason: "keys_file_rejected",
  });
  chmodSync(f.keyPath, 0o600);
  f.write("credentials.local.json", { version: 99 });
  await assert.rejects(startConfiguredLocalRelay(f.configPath), {
    reason: "credentials_invalid",
  });
  f.write("credentials.local.json", { version: 1, credentials: [] });
  const host = await startConfiguredLocalRelay(f.configPath);
  try {
    // The same state directory is owned by the running host.
    await assert.rejects(startConfiguredLocalRelay(f.configPath), {
      reason: "state_in_use",
    });
  } finally {
    await host.close();
  }
  const blocker = await startConfiguredLocalRelay(f.configPath);
  t.after(() => blocker.close());
  const other = fixture(t);
  other.config.port = Number(new URL(blocker.url).port);
  other.write("service.local.json", other.config);
  await assert.rejects(startConfiguredLocalRelay(other.configPath), {
    reason: "port_in_use",
  });
});
test("CLI prints the refusal reason and offending fields only", async (t) => {
  const f = fixture(t);
  const store = { ...f.config.store };
  delete store.agent_capacity;
  f.write("service.local.json", { ...f.config, store });
  const child = spawn(process.execPath, [cli, "--config", f.configPath], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stderr.on("data", (data) => {
    output += data;
  });
  const [code] = await once(child, "exit");
  assert.equal(code, 1);
  assert.equal(
    output,
    "local_relay_start_rejected reason=config_invalid fields=store.agent_capacity\n",
  );
});
test("example relay config enables the per-sender capacity policy", () => {
  const example = JSON.parse(
    readFileSync(resolve("config/relay-service.example.json"), "utf8"),
  );
  const capacity = example.store.agent_capacity;
  assert.ok(capacity.max_records_per_sender < example.store.max_records);
  assert.ok(capacity.max_pending_per_sender < example.store.max_pending);
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
  assert.equal(output, "local_relay_start_rejected reason=config_required\n");
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

test("configured discovery policy is explicit, bounded, and does not create registrations", (t) => {
  const f = fixture(t);
  assert.equal(
    readLocalRelayConfig(f.configPath).config.registry.discovery,
    undefined,
  );
  f.config.registry.discovery = { availability_namespaces: ["hermes"] };
  f.write("service.local.json", f.config);
  assert.deepEqual(
    readLocalRelayConfig(f.configPath).config.registry.discovery,
    { availability_namespaces: ["hermes"] },
  );
  for (const invalid of [
    { availability_namespaces: ["Hermes"] },
    { availability_namespaces: ["hermes\n"] },
    { availability_namespaces: Array(101).fill("hermes") },
    { availability_namespaces: ["hermes"], grant: true },
  ]) {
    f.config.registry.discovery = invalid;
    f.write("service.local.json", f.config);
    assert.throws(
      () => readLocalRelayConfig(f.configPath),
      /local_relay_start_rejected/,
    );
  }
  assert.deepEqual(readdirSync(join(f.dir, "state")), []);
});
