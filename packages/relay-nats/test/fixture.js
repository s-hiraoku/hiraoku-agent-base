import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer, createConnection } from "node:net";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { randomBytes } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { connect } from "@nats-io/transport-node";
import { jetstreamManager } from "@nats-io/jetstream";
import { JetStreamRelay } from "../src/backend.ts";
import { SQLiteInbox } from "../../../src/relay/sqlite-inbox.ts";
import { DurableReceiver } from "../../../src/relay/receiver.ts";

export const limits = {
  envelope_bytes: 32768,
  text_bytes: 16000,
  data_bytes: 16000,
  attachment_bytes: 1000,
  total_attachment_bytes: 1000,
  parts: 8,
  attachments: 3,
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
    log = "",
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
    broker = spawn(serverBinary, ["-c", config], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    broker.stderr.on("data", (data) => {
      log += data.toString();
    });
    for (let attempt = 0; attempt < 100; attempt++) {
      if (broker.exitCode !== null) throw Error(`broker startup failed ${log}`);
      try {
        const nc = await connect({
          servers: options.server,
          user: options.user,
          pass: options.password,
          reconnect: false,
          timeout: 100,
        });
        await nc.close();
        return;
      } catch {
        await delay(20);
      }
    }
    throw Error(`broker startup timed out ${log}`);
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
  const f = {
    dir,
    options,
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
        submit: (message) => backend.submit(name, message),
        status: (id) => backend.status(name, id),
        poll: () => backend.poll(name),
        ack: (request) => backend.ack(name, request),
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

export async function gatePubAck(t, upstream, mode = "puback") {
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
    if (mode === "ack-request") remote.pipe(client);
    else client.pipe(remote);
    const source = mode === "ack-request" ? client : remote;
    const target = mode === "ack-request" ? remote : client;
    let buffer = Buffer.alloc(0);
    source.on("data", (chunk) => {
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
          mode === "ack-request"
            ? line.startsWith("PUB $JS.ACK.")
            : /^MSG /.test(line) && /^\{"stream":"HAB","seq":/.test(payload);
        if (!release && matches) {
          release = (drop = false) => {
            if (!drop) target.write(frame);
          };
          gateResolve();
        } else target.write(frame);
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
