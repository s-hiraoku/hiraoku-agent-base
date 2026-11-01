import assert from "node:assert/strict";
import { test } from "node:test";
import {
  writeFileSync,
  mkdirSync,
  unlinkSync,
  lstatSync,
  readdirSync,
  readFileSync,
} from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { SQLiteHabRegistry } from "../../../src/hab/sqlite-registry.ts";
import { HabMcpClient } from "../../../src/hab/mcp-client.ts";
import { SQLiteInbox } from "../../../src/relay/sqlite-inbox.ts";
import { DurableReceiver } from "../../../src/relay/receiver.ts";
import {
  startConfiguredJetStreamRelay,
  readJetStreamHostConfig,
} from "../src/configured.ts";
import { startConfiguredLocalRelay } from "../../../src/relay-host/configured.ts";
import { startLocalRelay } from "../../../src/relay-host/local.ts";
import { createJetStreamServiceFactory } from "../src/configured.ts";
import {
  options as registryOptions,
  principal,
  operations,
} from "../../../test/hab-registry-fixtures.js";
import { policy as httpPolicy } from "../../../test/relay-http-fixtures.js";
import { fixture } from "./fixture.js";

async function eventually(action) {
  for (let count = 0; count < 100; count++) {
    if (await action()) return;
    await delay(20);
  }
  throw Error("condition did not settle");
}
test("explicit private config serves the existing five MCP operations, survives restart, and fails closed on a missing volume", async (t) => {
  let host;
  t.after(async () => host?.close());
  const f = await fixture(t, {
    max_pending: 20,
    max_pending_per_recipient: 10,
    prefetch_per_recipient: 10,
    lease_ms: 2000,
  });
  const state = join(f.dir, "configured-state"),
    audit = join(f.dir, "audit");
  mkdirSync(state, { mode: 0o700 });
  mkdirSync(audit, { mode: 0o700 });
  const write = (name, value) => {
    const path = join(f.dir, name + ".local.json");
    writeFileSync(path, JSON.stringify(value), { mode: 0o600 });
    return path;
  };
  const admin = Symbol("synthetic-operator");
  const registry = new SQLiteHabRegistry(
    join(state, "registry.sqlite"),
    { ...registryOptions, authentication_groups: true },
    {
      administrator: (context) =>
        context === admin ? { actor_id: "synthetic-operator" } : undefined,
    },
  );
  registry.migrate();
  t.after(() => registry.close());
  const product = registry.registerProduct(admin, {
    request_id: "product",
    agent_name: "synthetic-host",
  });
  const agents = Object.fromEntries(
    ["a", "b"].map((name) => [
      name,
      registry.enroll(admin, {
        request_id: "enroll-" + name,
        product_id: product.product_id,
        bot_name: name,
      }),
    ]),
  );
  const markerValue = { version: 1, volume_id: "synthetic-ssd" };
  const marker = join(state, "volume.local.json");
  writeFileSync(marker, JSON.stringify(markerValue), { mode: 0o600 });
  const credentialsFile = write("credentials", { version: 1, credentials: [] });
  const keyFile = write("keys", {
    version: 1,
    registry_fingerprint_key: "3d".repeat(32),
    relay_fingerprint_key: "2a".repeat(32),
  });
  const registryConfig = { ...registryOptions, authentication_groups: true };
  delete registryConfig.fingerprint_key;
  const http = { ...httpPolicy };
  delete http.resource_url;
  delete http.allowed_origins;
  const serviceConfig = {
    version: 1,
    directory: state,
    port: 0,
    keys_file: keyFile,
    credentials_file: credentialsFile,
    audit_directory: audit,
    audit_max_bytes: 262144,
    limits: f.options.limits,
    registry: registryConfig,
    store: {
      max_pending: 20,
      max_records: 100,
      max_pending_per_recipient: 10,
      max_body_bytes: 100000,
      max_clock_skew_ms: 1000,
      lease_ms: 2000,
      max_attempts: 3,
      retry_base_ms: 50,
      retry_cap_ms: 200,
      poll_scan_limit: 10,
      agent_capacity: {
        max_pending_per_sender: 5,
        max_body_bytes_per_sender: 50000,
        max_records_per_sender: 25,
        max_body_bytes_per_recipient: 50000,
        max_records_per_recipient: 50,
        reservations: [],
      },
    },
    http,
  };
  const serviceFile = write("service", serviceConfig);
  const natsConfig = {
    version: 1,
    broker: {
      server: f.options.server,
      user: f.options.user,
      password: f.options.password,
      stream: "HAB",
      subject_prefix: "hab",
      max_consumers: 10,
      max_bytes: 4_000_000,
      max_message_bytes: 64000,
      request_timeout_ms: 1000,
    },
    routing: {
      epoch: 1,
      enabled: true,
      recipients: [agents.b.agent_id],
      kinds: ["question", "answer", "notice"],
    },
    pump: { interval_ms: 20, max_records_per_cycle: 20 },
    volume: {
      identity_file: marker,
      expected_id: "synthetic-ssd",
      expected_device: lstatSync(state).dev,
    },
  };
  const natsFile = write("jetstream", natsConfig);
  host = await startConfiguredJetStreamRelay(serviceFile, natsFile);
  const tokens = { a: "a".repeat(64), b: "b".repeat(64) };
  const now = Date.now();
  const credentials = [];
  for (const name of ["a", "b"]) {
    const identity = principal(name, { audience: host.url });
    const group = registry.createGroup(admin, { request_id: "group-" + name });
    registry.bindGroup(admin, {
      request_id: "bind-" + name,
      group_id: group.group_id,
      expected_epoch: group.epoch,
      principal: identity,
    });
    registry.addGroupMember(admin, {
      request_id: "member-" + name,
      group_id: group.group_id,
      expected_group_epoch: registry.inspectGroup(admin, group.group_id).epoch,
      agent_id: agents[name].agent_id,
      expected_epoch: agents[name].epoch,
    });
    agents[name] = registry.setAccess(admin, {
      request_id: "active-" + name,
      agent_id: agents[name].agent_id,
      expected_epoch: registry.inspect(admin, agents[name].agent_id).epoch,
      state: "active",
      operations,
    });
    registry.setGroupAccess(admin, {
      request_id: "group-active-" + name,
      group_id: group.group_id,
      expected_epoch: registry.inspectGroup(admin, group.group_id).epoch,
      state: "active",
      operations,
    });
    credentials.push({
      sha256: createHash("sha256").update(tokens[name]).digest("hex"),
      principal: identity,
      issued_at: new Date(now - 1000).toISOString(),
      expires_at: new Date(now + 30000).toISOString(),
    });
  }
  write("credentials", { version: 1, credentials });
  const client = (name) =>
    new HabMcpClient({
      policy: {
        resource_url: host.url,
        agent_id: agents[name].agent_id,
        max_request_bytes: 65536,
        max_response_bytes: 131072,
        timeout_ms: 2500,
        max_active_requests: 1,
        max_sse_events: 16,
        max_sse_lines: 128,
        max_json_depth: 64,
        max_json_nodes: 10000,
      },
      limits: f.options.limits,
      as_address: agents[name].address,
      authorization: () => "Bearer " + tokens[name],
    });
  assert.equal(
    (await client("a").resolve(agents.b.address)).recipient_id,
    agents.b.agent_id,
  );
  const message = f.message(agents.b.agent_id);
  const accepted = await client("a").submit(message);
  const inbox = new SQLiteInbox(join(f.dir, "configured-inbox.sqlite"), {
    agent_id: agents.b.agent_id,
    fingerprint_key: new Uint8Array(32).fill(45),
    limits: f.options.limits,
    max_records: 100,
    max_body_bytes: 100000,
    max_ack_records: 100,
    ack_retry_ms: 10000,
    retry_base_ms: 1,
    retry_cap_ms: 10,
    max_attempts: 100,
  });
  inbox.migrate();
  t.after(() => inbox.close());
  const receiver = new DurableReceiver(inbox, {
    poll: () => client("b").poll(),
    ack: (request) => client("b").ack(request),
  });
  await eventually(async () => {
    await receiver.receiveOnce();
    return receiver.inbox().length === 1;
  });
  assert.equal(receiver.inbox()[0].receipt_confirmed, true);
  assert.equal((await client("a").status(message.message_id)).state, "acked");
  await f.stop();
  const offline = f.message(agents.b.agent_id);
  const offlineReceipt = await client("a").submit(offline);
  assert.equal(offlineReceipt.state, "pending");
  await eventually(() => {
    try {
      return (
        JSON.parse(
          readFileSync(join(state, "jetstream-health.local.json"), "utf8"),
        ).reason === "broker_unavailable"
      );
    } catch {
      return false;
    }
  });
  const legacyWitness = new DatabaseSync(join(state, "relay.sqlite"), {
    readOnly: true,
  });
  assert.equal(
    legacyWitness
      .prepare("SELECT count(*) n FROM relay_messages WHERE message_id=?")
      .get(offline.message_id).n,
    0,
  );
  legacyWitness.close();
  await f.start();
  await eventually(async () => {
    await receiver.receiveOnce();
    return receiver.inbox().length === 2;
  });
  assert.equal(
    (await client("a").status(offline.message_id)).receipt_id,
    offlineReceipt.receipt_id,
  );
  await eventually(
    () =>
      JSON.parse(
        readFileSync(join(state, "jetstream-health.local.json"), "utf8"),
      ).state === "ready",
  );
  const firstUrl = host.url;
  serviceConfig.port = Number(new URL(firstUrl).port);
  write("service", serviceConfig);
  await host.close();
  await assert.rejects(startConfiguredLocalRelay(serviceFile));
  host = await startConfiguredJetStreamRelay(serviceFile, natsFile);
  assert.equal(host.url, firstUrl);
  assert.equal(
    (await client("a").status(message.message_id)).receipt_id,
    accepted.receipt_id,
  );
  unlinkSync(marker);
  await assert.rejects(client("a").submit(f.message(agents.b.agent_id)));
  writeFileSync(marker, JSON.stringify(markerValue), { mode: 0o600 });
  write("credentials", { version: 1, credentials: [] });
  await assert.rejects(client("a").status(message.message_id));
});

test("missing, nonprivate and unknown JetStream configuration fails without fallback", async (t) => {
  const f = await fixture(t);
  assert.throws(
    () => readJetStreamHostConfig(join(f.dir, "missing.local.json")),
    /local_relay_start_rejected/,
  );
  const path = join(f.dir, "invalid.local.json");
  writeFileSync(
    path,
    JSON.stringify({ version: 1, secret: "synthetic-not-for-errors" }),
    { mode: 0o600 },
  );
  assert.throws(
    () => readJetStreamHostConfig(path),
    (error) =>
      error.reason === "jetstream_config_rejected" &&
      !JSON.stringify(error).includes("synthetic-not-for-errors"),
  );
});

test("volume preflight rejects a foreign marker or device before creating any state files", async (t) => {
  const f = await fixture(t);
  const directory = join(f.dir, "empty-state");
  mkdirSync(directory, { mode: 0o700 });
  const marker = join(f.dir, "outside.local.json");
  writeFileSync(marker, JSON.stringify({ version: 1, volume_id: "expected" }), {
    mode: 0o600,
  });
  const config = {
    version: 1,
    broker: {
      server: f.options.server,
      user: f.options.user,
      password: f.options.password,
      stream: "HAB",
      subject_prefix: "hab",
      max_consumers: 10,
      max_bytes: 4_000_000,
      max_message_bytes: 64000,
      request_timeout_ms: 1000,
    },
    routing: { epoch: 1, enabled: false, recipients: [], kinds: ["question"] },
    pump: { interval_ms: 20, max_records_per_cycle: 20 },
    volume: {
      identity_file: marker,
      expected_id: "expected",
      expected_device: lstatSync(directory).dev,
    },
  };
  const options = {
    directory,
    port: 0,
    limits: f.options.limits,
    registry: registryOptions,
    store: { ...f.options, poll_scan_limit: 10 },
    http: { ...httpPolicy },
    authority: { individual: () => undefined },
    verify: () => null,
    audit: { record() {} },
  };
  delete options.http.resource_url;
  delete options.http.allowed_origins;
  await assert.rejects(
    startLocalRelay({
      ...options,
      service_factory: createJetStreamServiceFactory(config),
    }),
    { code: "local_relay_extension_storage_unavailable" },
  );
  assert.deepEqual(readdirSync(directory), []);
  const inside = join(directory, "volume.local.json");
  writeFileSync(inside, JSON.stringify({ version: 1, volume_id: "expected" }), {
    mode: 0o600,
  });
  config.volume.identity_file = inside;
  config.volume.expected_device++;
  await assert.rejects(
    startLocalRelay({
      ...options,
      service_factory: createJetStreamServiceFactory(config),
    }),
    { code: "local_relay_extension_storage_unavailable" },
  );
  assert.deepEqual(readdirSync(directory), ["volume.local.json"]);
  await assert.rejects(
    startLocalRelay({ ...options, service_factory: async () => ({}) }),
    /invalid_local_relay_options/,
  );
  await assert.rejects(
    startLocalRelay({
      ...options,
      service_factory: Object.assign(async () => ({}), {
        extension_id: "synthetic",
        preflight: async () => undefined,
      }),
    }),
    /invalid_local_relay_options/,
  );
  assert.deepEqual(readdirSync(directory), ["volume.local.json"]);
});
