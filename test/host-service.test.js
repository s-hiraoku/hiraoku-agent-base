import test from "node:test";
import { request as httpRequest } from "node:http";
import { oauthFixture, resource, issuer } from "./oauth-fixtures.js";
import process from "node:process";
import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { readHostConfig } from "../src/host/config.ts";
import { startHost } from "../src/host/start.ts";
import { envelope } from "./mcp-http-fixtures.js";
import { fixture, list } from "./host-service-fixtures.js";
const cli = resolve("scripts/hab-host.ts");
test("the host creates registry v2 with authentication groups and stays deny-all across restart", async (t) => {
  const f = await fixture(t);
  const first = await startHost(f.configPath);
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
  const next = await startHost(f.configPath);
  try {
    assert.equal((await list(next.url)).status, 401);
  } finally {
    await next.close();
  }
});
test("private explicit config starts deny-all; digest binding authenticates only until file revocation", async (t) => {
  const f = await fixture(t),
    host = await startHost(f.configPath);
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
  const f = await fixture(t);
  f.write("credentials.local.json", { version: 99 });
  await assert.rejects(startHost(f.configPath), /host_start_rejected/);
  assert.deepEqual(readdirSync(join(f.dir, "state")), ["volume.local.json"]);
  f.write("credentials.local.json", { version: 1, credentials: [] });
  chmodSync(f.keyPath, 0o644);
  await assert.rejects(startHost(f.configPath), /host_start_rejected/);
});
test("configured delivery queue requires a per-sender capacity smaller than the shared pool", async (t) => {
  const f = await fixture(t);
  const queue = f.config.delivery.queue;
  const missing = { ...queue };
  delete missing.agent_capacity;
  for (const variant of [
    missing,
    {
      ...queue,
      agent_capacity: {
        ...queue.agent_capacity,
        max_records_per_sender: queue.max_records,
      },
    },
    {
      ...queue,
      agent_capacity: {
        ...queue.agent_capacity,
        max_pending_per_sender: queue.max_pending,
      },
    },
  ]) {
    f.write("service.local.json", {
      ...f.config,
      delivery: { ...f.config.delivery, queue: variant },
    });
    await assert.rejects(startHost(f.configPath), /host_start_rejected/);
    assert.deepEqual(readdirSync(join(f.dir, "state")), ["volume.local.json"]);
  }
  f.write("service.local.json", f.config);
  const host = await startHost(f.configPath);
  await host.close();
});
function withoutSenderCapacity(f) {
  const queue = { ...f.config.delivery.queue };
  delete queue.agent_capacity;
  return { ...f.config, delivery: { ...f.config.delivery, queue } };
}
test("startup refusal names a fixed reason and config fields, never values", async (t) => {
  const f = await fixture(t);
  f.write("service.local.json", withoutSenderCapacity(f));
  await assert.rejects(startHost(f.configPath), (error) => {
    assert.equal(error.message, "host_start_rejected");
    assert.equal(error.reason, "config_invalid");
    assert.deepEqual(error.fields, ["delivery.queue.agent_capacity"]);
    return true;
  });
  f.write("service.local.json", f.config);
  chmodSync(f.keyPath, 0o644);
  await assert.rejects(startHost(f.configPath), {
    reason: "keys_file_rejected",
  });
  chmodSync(f.keyPath, 0o600);
  f.write("credentials.local.json", { version: 99 });
  await assert.rejects(startHost(f.configPath), {
    reason: "credentials_invalid",
  });
  f.write("credentials.local.json", { version: 1, credentials: [] });
  const host = await startHost(f.configPath);
  try {
    // The same state directory is owned by the running host.
    await assert.rejects(startHost(f.configPath), {
      reason: "state_in_use",
    });
  } finally {
    await host.close();
  }
  const blocker = await startHost(f.configPath);
  t.after(() => blocker.close());
  const other = await fixture(t);
  other.config.port = Number(new URL(blocker.url).port);
  other.write("service.local.json", other.config);
  await assert.rejects(startHost(other.configPath), {
    reason: "port_in_use",
  });
});
test("a config with the retired SQLite store section is refused before any state is created", async (t) => {
  const f = await fixture(t);
  const retired = { ...f.config, store: f.config.delivery.queue };
  delete retired.delivery;
  f.write("service.local.json", retired);
  await assert.rejects(startHost(f.configPath), (error) => {
    assert.equal(error.reason, "config_invalid");
    assert.deepEqual(error.fields, ["delivery", "store"]);
    return true;
  });
  f.write("service.local.json", {
    ...f.config,
    delivery: { ...f.config.delivery, routing: { epoch: 1, enabled: false } },
  });
  await assert.rejects(startHost(f.configPath), {
    reason: "config_invalid",
    fields: ["delivery.routing"],
  });
  assert.deepEqual(readdirSync(join(f.dir, "state")), ["volume.local.json"]);
});
test("retired JetStream config and an undrained JetStream journal are refused before delivery opens", async (t) => {
  const f = await fixture(t);
  for (const section of ["broker", "pump"]) {
    f.write("service.local.json", {
      ...f.config,
      delivery: { ...f.config.delivery, [section]: {} },
    });
    await assert.rejects(startHost(f.configPath), {
      reason: "config_invalid",
      fields: [`delivery.${section}`],
    });
  }
  f.write("service.local.json", f.config);
  const legacy = join(f.dir, "state", "jetstream-journal.sqlite");
  writeFileSync(legacy, "", { mode: 0o600 });
  await assert.rejects(startHost(f.configPath), {
    reason: "legacy_jetstream_journal_present",
  });
  assert.equal(existsSync(join(f.dir, "state", "delivery.sqlite")), false);
  rmSync(legacy);
  const host = await startHost(f.configPath);
  await host.close();
  assert.equal(existsSync(join(f.dir, "state", "delivery.sqlite")), true);
});
test("registry limits outside the registry's bounds are refused as config fields", async (t) => {
  const f = await fixture(t);
  for (const [patch, field] of [
    [{ busy_timeout_ms: 5000 }, "registry.busy_timeout_ms"],
    [{ max_context_ms: 300001 }, "registry.max_context_ms"],
    [{ max_agents: 1000001 }, "registry.max_agents"],
    [{ allowed_kinds: ["ok", "ok"] }, "registry.allowed_kinds"],
  ]) {
    f.write("service.local.json", {
      ...f.config,
      registry: { ...f.config.registry, ...patch },
    });
    await assert.rejects(startHost(f.configPath), (error) => {
      assert.deepEqual(
        { reason: error.reason, fields: error.fields },
        { reason: "config_invalid", fields: [field] },
      );
      return true;
    });
  }
  assert.deepEqual(readdirSync(join(f.dir, "state")), ["volume.local.json"]);
});
test("CLI prints the refusal reason and offending fields only", async (t) => {
  const f = await fixture(t);
  f.write("service.local.json", withoutSenderCapacity(f));
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
    "host_start_rejected reason=config_invalid fields=delivery.queue.agent_capacity\n",
  );
});
test("example host config enables the per-sender capacity policy", () => {
  const example = JSON.parse(
    readFileSync(resolve("config/host-service.example.json"), "utf8"),
  );
  const queue = example.delivery.queue;
  assert.ok(queue.agent_capacity.max_records_per_sender < queue.max_records);
  assert.ok(queue.agent_capacity.max_pending_per_sender < queue.max_pending);
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
  assert.equal(output, "host_start_rejected reason=config_required\n");
});
test("CLI uses private state across SIGTERM/restart and closes its owned port", async (t) => {
  for (const extension of ["ts", "mjs"]) {
    const f = await fixture(t);
    const entrypoint = resolve(`scripts/hab-host.${extension}`);
    for (let attempt = 0; attempt < 2; attempt++) {
      const child = spawn(
        process.execPath,
        [entrypoint, "--config", f.configPath],
        {
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
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
      const closed = once(child, "close");
      child.kill("SIGTERM");
      const [code, signal] = await closed;
      assert.equal(code, 0);
      assert.equal(signal, null);
      assert.ok(output.includes('"state":"stopped"'));
      assert.equal(errors, "");
      await assert.rejects(list(info.url));
    }
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
          Host: "hab.example",
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
  const f = await fixture(t),
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
    allowed_origins: ["https://hab.example"],
  };
  f.write("service.local.json", f.config);
  const host = await startHost(f.configPath);
  t.after(() => host.close());
  assert.equal(host.ingress_url, resource);
  const rejected = await ingressList(host);
  assert.equal(rejected.statusCode, 401);
  assert.match(rejected.headers["www-authenticate"], /resource_metadata=/);
  assert.equal((await list(host.url)).status, 401);
});
test("missing, permissive, invalid or mismatched OAuth config never creates a fallback ingress", async (t) => {
  const f = await fixture(t),
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
  await assert.rejects(startHost(f.configPath), /host_start_rejected/);
  chmodSync(path, 0o600);
  f.config.ingress.resource_url = "https://other.example/hab/mcp";
  f.write("service.local.json", f.config);
  await assert.rejects(startHost(f.configPath), /host_start_rejected/);
  f.config.ingress.resource_url = resource;
  f.config.ingress.oauth_file = join(f.dir, "absent.local.json");
  f.write("service.local.json", f.config);
  await assert.rejects(startHost(f.configPath), /host_start_rejected/);
  delete f.config.ingress;
  f.write("service.local.json", f.config);
  const host = await startHost(f.configPath);
  t.after(() => host.close());
  assert.equal((await list(host.url)).status, 401);
});

test("configured discovery policy is explicit, bounded, and does not create registrations", async (t) => {
  const f = await fixture(t);
  assert.equal(
    readHostConfig(f.configPath).config.registry.discovery,
    undefined,
  );
  f.config.registry.discovery = { availability_namespaces: ["hermes"] };
  f.write("service.local.json", f.config);
  assert.deepEqual(readHostConfig(f.configPath).config.registry.discovery, {
    availability_namespaces: ["hermes"],
  });
  for (const invalid of [
    { availability_namespaces: ["Hermes"] },
    { availability_namespaces: ["hermes\n"] },
    { availability_namespaces: Array(101).fill("hermes") },
    { availability_namespaces: ["hermes"], grant: true },
  ]) {
    f.config.registry.discovery = invalid;
    f.write("service.local.json", f.config);
    assert.throws(
      () => readHostConfig(f.configPath),
      /host_start_rejected/,
    );
  }
  assert.deepEqual(readdirSync(join(f.dir, "state")), ["volume.local.json"]);
});
