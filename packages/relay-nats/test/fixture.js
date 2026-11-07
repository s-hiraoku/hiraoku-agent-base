import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer, createConnection } from "node:net";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { randomBytes } from "node:crypto";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { connect } from "@nats-io/transport-node";
import { jetstreamManager } from "@nats-io/jetstream";
import { JetStreamRelay } from "../src/backend.ts";
import { SQLiteInbox } from "../../../src/agent-sdk/sqlite-inbox.ts";
import { DurableReceiver } from "../../../src/agent-sdk/receiver.ts";

export const limits = {
  envelope_bytes: 32768,
  text_bytes: 16000,
  data_bytes: 16000,
  parts: 8,
  json_depth: 20,
  json_nodes: 1000,
};
async function freePort() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}
export function ackRequest(delivery, request_id = "ack-1") {
  return {
    sender_id: delivery.message.sender_id,
    message_id: delivery.message.message_id,
    generation: delivery.generation,
    lease_token: delivery.lease_token,
    request_id,
  };
}
/**
 * The backend's delivery surface as the host uses it: synchronous journal commits under an
 * explicit authorization. Submit publishes the admitted message; poll and ACK let the pump
 * prefetch candidates and clean up acknowledged bodies around the journal commit.
 */
export function operations(backend, authorization) {
  const pump = () =>
    backend.pumpOnce().catch((error) => {
      if (error?.code !== "capacity_exceeded") throw error;
    });
  return {
    async submit(context, message) {
      const receipt = backend.admitWithAuthorization(
        context,
        message,
        authorization,
      );
      await backend.publishPending();
      return backend.statusWithAuthorization(
        context,
        receipt.message_id,
        authorization,
      );
    },
    status: async (context, id) =>
      backend.statusWithAuthorization(context, id, authorization),
    async poll(context) {
      await pump();
      return backend.pollWithAuthorization(context, authorization);
    },
    async ack(context, request) {
      const receipt = backend.ackWithAuthorization(
        context,
        request,
        authorization,
      );
      await pump();
      return receipt;
    },
  };
}
export async function fixture(
  t,
  patch = {},
  serverBinary = process.env.HAB_NATS_SERVER,
) {
  if (!serverBinary)
    throw Error(
      "HAB_NATS_SERVER must point to the pinned nats-server 2.15.2 binary",
    );
  const runtime = resolve(".runtime");
  mkdirSync(runtime, { recursive: true, mode: 0o700 });
  const dir = mkdtempSync(join(runtime, "run-"));
  const port = await freePort();
  const password = randomBytes(24).toString("hex");
  const config = join(dir, "broker.conf");
  writeFileSync(
    config,
    `host: 127.0.0.1\nport: ${port}\njetstream {\n store_dir: ${JSON.stringify(join(dir, "store"))}\n max_file_store: 64MB\n max_memory_store: 0\n sync_interval: always\n}\naccounts { HAB {\n jetstream: enabled\n users: [\n {user: backend, password: ${JSON.stringify(password)}}\n {user: outsider, password: synthetic-outsider, permissions: {publish: {allow: ["public.>"]}, subscribe: {allow: ["public.>"]}}}\n ]\n} }\n`,
    { mode: 0o600 },
  );
  let broker,
    log = Buffer.alloc(0),
    generation = 0,
    backend,
    admin;
  const opened = new Set();
  const inboxes = new Set();
  let revoked = false;
  const authorization = {
    authorize(context, operation, peer) {
      if (!["a", "b", "c", "admin"].includes(context)) return undefined;
      if (operation === "maintenance" && context !== "admin") return undefined;
      if (revoked && (context === "a" || peer === "a")) return undefined;
      return { agent_id: context };
    },
  };
  const options = {
    journal_path: join(dir, "journal.sqlite"),
    server: `nats://127.0.0.1:${port}`,
    user: "backend",
    password,
    stream: "HAB",
    subject_prefix: "hab",
    max_consumers: 10,
    broker_max_bytes: 4_000_000,
    broker_max_message_bytes: 64_000,
    request_timeout_ms: 1000,
    limits,
    authorization,
    fingerprint_key: new Uint8Array(32).fill(42),
    max_records: 100,
    max_pending: 10,
    max_pending_per_recipient: 5,
    max_body_bytes: 100_000,
    max_clock_skew_ms: 1000,
    lease_ms: 250,
    max_attempts: 3,
    retry_base_ms: 50,
    retry_cap_ms: 200,
    ...patch,
  };
  async function start() {
    const started = performance.now();
    const deadline = started + 10000;
    const currentGeneration = ++generation;
    const safeCodes = new Set([
      "EACCES",
      "EAGAIN",
      "ECONNREFUSED",
      "ECONNRESET",
      "EHOSTUNREACH",
      "EINVAL",
      "EMFILE",
      "ENETUNREACH",
      "ENFILE",
      "ENOENT",
      "ENOEXEC",
      "ENOMEM",
      "ENOTFOUND",
      "EPERM",
      "ETIMEDOUT",
      "ETXTBSY",
      "TIMEOUT",
      "AUTHORIZATION_VIOLATION",
      "CONNECTION_CLOSED",
      "CONNECTION_REFUSED",
      "CONNECTION_TIMEOUT",
    ]);
    const safeCode = (error) =>
      [error?.code, error?.cause?.code].find((code) => safeCodes.has(code)) ??
      "OTHER";
    let state = { phase: "pending" },
      attempts = 0,
      stderrBytes = 0,
      lastConnectionCode = null,
      spawnErrorCode = null;
    const terminal = (reason, code = null, signal = null) => {
      if (state.phase === "pending")
        state = { phase: "terminal", reason, code, signal };
    };
    const child = spawn(serverBinary, ["-c", config], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    broker = child;
    child.on("error", (error) => {
      spawnErrorCode = safeCode(error);
      terminal("spawn_failed");
    });
    child.once("exit", (code, signal) => terminal("exited", code, signal));
    child.stderr.on("data", (data) => {
      stderrBytes += data.length;
      log = Buffer.concat([log, data]).subarray(-65536);
    });
    const observe = () => {
      if (child.exitCode !== null || child.signalCode !== null)
        terminal("exited", child.exitCode, child.signalCode);
      if (performance.now() >= deadline) terminal("deadline_exceeded");
    };
    while (state.phase === "pending") {
      observe();
      if (state.phase !== "pending") break;
      attempts++;
      let connected = false;
      try {
        const nc = await connect({
          servers: options.server,
          user: options.user,
          pass: options.password,
          reconnect: false,
          timeout: Math.min(
            100,
            Math.max(1, Math.ceil(deadline - performance.now())),
          ),
        });
        await nc.close();
        connected = true;
      } catch (error) {
        lastConnectionCode = safeCode(error);
      }
      observe();
      if (state.phase !== "pending") break;
      if (connected) {
        state = { phase: "ready" };
        break;
      }
      await delay(Math.min(20, Math.max(0, deadline - performance.now())));
    }
    const record = {
      reason: state.reason ?? "ready",
      generation: currentGeneration,
      attempts,
      elapsed_ms: Math.ceil(performance.now() - started),
      pid: child.pid ?? null,
      exit_code: state.code ?? child.exitCode,
      signal: state.signal ?? child.signalCode,
      spawn_error_code: spawnErrorCode,
      last_connection_code: lastConnectionCode,
      stderr_bytes: stderrBytes,
    };
    writeFileSync(
      join(dir, "broker-startup.json"),
      JSON.stringify(record) + "\n",
      { mode: 0o600 },
    );
    t.diagnostic?.(JSON.stringify({ event: "broker_startup", ...record }));
    if (state.phase !== "ready")
      throw Error(`broker startup ${JSON.stringify(record)}`);
  }
  async function stop(signal = "SIGTERM") {
    if (!broker || broker.exitCode !== null || broker.signalCode !== null)
      return;
    const exited = once(broker, "exit");
    broker.kill(signal);
    await exited;
  }
  async function open() {
    backend = await JetStreamRelay.open(options);
    opened.add(backend);
    return backend;
  }
  async function close(value) {
    if (opened.delete(value)) await value.close();
  }
  t.after(async () => {
    for (const inbox of inboxes) inbox.close();
    inboxes.clear();
    for (const value of opened) await value.close();
    opened.clear();
    await admin?.close();
    await stop();
    writeFileSync(join(dir, "broker.log"), log, { mode: 0o600 });
    writeFileSync(
      join(dir, "closed.json"),
      JSON.stringify({
        broker_pid: broker?.pid,
        exit_code: broker?.exitCode,
        signal: broker?.signalCode,
        live_gateways: opened.size,
        live_inboxes: inboxes.size,
      }) + "\n",
      { mode: 0o600 },
    );
  });
  await start();
  await open();
  admin = await connect({
    servers: options.server,
    user: options.user,
    pass: options.password,
    reconnect: false,
  });
  let manager = await jetstreamManager(admin);
  let counter = 0;
  const current = () => operations(backend, options.authorization);
  const f = {
    dir,
    options,
    ops: (target) => operations(target, options.authorization),
    submit: (context, message) => current().submit(context, message),
    status: (context, id) => current().status(context, id),
    poll: (context) => current().poll(context),
    ack: (context, request) => current().ack(context, request),
    track(value) {
      opened.add(value);
      return value;
    },
    get manager() {
      return manager;
    },
    get backend() {
      return backend;
    },
    revoke: (value = true) => {
      revoked = value;
    },
    message(recipient = "b", patch = {}) {
      const sent = Date.now() - 50;
      return {
        version: 1,
        message_id: `message-${++counter}`,
        recipient_id: recipient,
        kind: "question",
        body: { parts: [{ type: "text", text: "合成本文\r\nhello" }] },
        thread_id: "thread-1",
        in_reply_to: null,
        first_sent_at: new Date(sent).toISOString(),
        expires_at: new Date(sent + 3600000).toISOString(),
        ...patch,
      };
    },
    transport(name) {
      return {
        submit: (message) => f.submit(name, message),
        status: (id) => f.status(name, id),
        poll: () => f.poll(name),
        ack: (request) => f.ack(name, request),
      };
    },
    inbox(name) {
      const store = new SQLiteInbox(join(dir, `inbox-${name}.sqlite`), {
        agent_id: name,
        fingerprint_key: new Uint8Array(32).fill(44),
        limits,
        max_records: 100,
        max_body_bytes: 100000,
        max_ack_records: 100,
        ack_retry_ms: 10000,
        retry_base_ms: 1,
        retry_cap_ms: 10,
        max_attempts: 100,
      });
      store.migrate();
      inboxes.add(store);
      return store;
    },
    receiver(name, patch = {}) {
      const store = this.inbox(name);
      const receiver = new DurableReceiver(store, {
        ...this.transport(name),
        ...patch,
      });
      return {
        once: () => receiver.receiveOnce(),
        entries: () => receiver.inbox(),
        close() {
          inboxes.delete(store);
          store.close();
        },
      };
    },
    open,
    close,
    stop,
    start,
    async restart(signal = "SIGKILL") {
      await close(backend);
      await admin.close();
      await stop(signal);
      await start();
      await open();
      admin = await connect({
        servers: options.server,
        user: options.user,
        pass: options.password,
        reconnect: false,
      });
      manager = await jetstreamManager(admin);
    },
  };
  return f;
}

export async function gatePubAck(t, upstream) {
  const sockets = new Set();
  let release, gateResolve;
  const gated = new Promise((resolve) => {
    gateResolve = resolve;
  });
  const server = createServer((client) => {
    const remote = createConnection({
      host: "127.0.0.1",
      port: new URL(upstream).port,
    });
    sockets.add(client);
    sockets.add(remote);
    client.on("error", () => {});
    remote.on("error", () => {});
    client.pipe(remote);
    let buffer = Buffer.alloc(0);
    remote.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length) {
        const eol = buffer.indexOf("\r\n");
        if (eol === -1) return;
        const line = buffer.subarray(0, eol).toString();
        let size = eol + 2;
        if (/^(MSG|HMSG|PUB|HPUB) /.test(line)) {
          size += Number(line.split(" ").at(-1)) + 2;
          if (buffer.length < size) return;
        }
        const frame = Buffer.from(buffer.subarray(0, size));
        buffer = buffer.subarray(size);
        const payload = frame.subarray(eol + 2, -2).toString();
        const matches =
          /^MSG /.test(line) && /^\{"stream":"HAB","seq":/.test(payload);
        if (!release && matches) {
          release = (drop = false) => {
            if (!drop) client.write(frame);
          };
          gateResolve();
        } else client.write(frame);
      }
    });
    remote.on("end", () => client.end());
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  });
  return {
    server: `nats://127.0.0.1:${server.address().port}`,
    gated,
    release: (drop = false) => release(drop),
  };
}
