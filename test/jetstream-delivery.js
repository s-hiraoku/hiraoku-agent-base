import process from "node:process";
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import {
  Worker,
  MessageChannel,
  receiveMessageOnPort,
} from "node:worker_threads";
import { JetStreamRelay } from "../packages/relay-nats/src/backend.ts";
import { HabJetStreamService } from "../src/host/hab-delivery-service.ts";
import {
  natsServerBinary,
  startLocalBroker,
} from "../scripts/lib/nats-broker.mjs";

// Delivery tests need the pinned nats-server; a missing binary fails the test, it never skips.
export { natsServerBinary };

let shared;
/** One broker per test process; each delivery gets its own stream, so tests stay isolated. */
export async function startBroker() {
  if (shared) return shared;
  const dir = mkdtempSync(join(tmpdir(), "hab-nats-"));
  shared = startLocalBroker(dir, { maxFileStore: "8GB" }).then((broker) => {
    process.once("exit", () => rmSync(dir, { recursive: true, force: true }));
    return broker;
  });
  return shared;
}

export const queue = Object.freeze({
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
  agent_capacity: Object.freeze({
    max_pending_per_sender: 10,
    max_body_bytes_per_sender: 50000,
    max_records_per_sender: 25,
    max_body_bytes_per_recipient: 50000,
    max_records_per_recipient: 50,
    reservations: Object.freeze([]),
  }),
});

let streams = 0;
const streamName = () =>
  `T${process.pid}_${++streams}_${randomBytes(3).toString("hex")}`;

/**
 * Polls a running host until a delivery arrives. The host's JetStream pump publishes an accepted
 * message on its next cycle, so an immediate poll can briefly see nothing.
 */
export function pollUntilDelivered(client, timeoutMs) {
  return eventually(() => client.poll(), timeoutMs);
}
/** Retries `read` until it returns a truthy value or the deadline passes, then returns the last value. */
export async function eventually(read, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value || Date.now() > deadline) return value;
    await delay(20);
  }
}

/** A host config `delivery` section for `directory`, with its volume marker written. */
export async function deliverySection(directory, patch = {}) {
  const broker = await startBroker();
  const stream = streamName();
  const identity = join(directory, "volume.local.json");
  if (!existsSync(identity))
    writeFileSync(
      identity,
      JSON.stringify({ version: 1, volume_id: "synthetic-volume" }),
      { mode: 0o600 },
    );
  return {
    broker: {
      server: broker.server,
      user: broker.user,
      password: broker.password,
      stream,
      subject_prefix: stream.replaceAll("_", "-"),
      max_consumers: 100,
      max_bytes: 4000000,
      max_message_bytes: 64000,
      request_timeout_ms: 2000,
    },
    pump: { interval_ms: 10, max_records_per_cycle: 100 },
    volume: {
      identity_file: identity,
      expected_id: "synthetic-volume",
      expected_device: lstatSync(directory).dev,
    },
    queue: { ...queue, ...patch.queue },
    ...(patch.migrate_journal === undefined
      ? {}
      : { migrate_journal: patch.migrate_journal }),
  };
}

/**
 * Runs the production pump to completion on a second backend instance that shares the journal,
 * blocking the caller. Tests use it so a poll sees what the pump would have published by then.
 */
function synchronousPump(t, options) {
  const { port1, port2 } = new MessageChannel();
  port1.unref();
  const signal = new SharedArrayBuffer(4);
  const flag = new Int32Array(signal);
  const plain = { ...options };
  delete plain.authorization;
  const worker = new Worker(
    new URL("./jetstream-pump-worker.js", import.meta.url),
    {
      workerData: { port: port2, signal, options: plain },
      transferList: [port2],
    },
  );
  worker.unref();
  const call = (command) => {
    Atomics.store(flag, 0, 0);
    port1.postMessage(command);
    if (Atomics.wait(flag, 0, 0, 30000) === "timed-out")
      throw Error("JetStream pump worker timed out");
    const reply = receiveMessageOnPort(port1)?.message;
    if (!reply?.ok)
      throw Object.assign(Error(reply?.code ?? "pump_failed"), {
        code: reply?.code ?? "pump_failed",
      });
  };
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    try {
      call("close");
    } finally {
      await worker.terminate();
    }
  };
  t.after(close);
  return {
    pump(limit = 100) {
      try {
        call({ limit });
      } catch (error) {
        // Production keeps serving polls while publication is blocked by broker capacity.
        if (error.code !== "capacity_exceeded") throw error;
      }
    },
    close,
  };
}

async function openBackend(
  t,
  { limits, directory, queue: patch, authorization },
) {
  const broker = await startBroker();
  const stream = streamName();
  const policy = { ...queue, ...patch };
  const options = {
    ...policy,
    fingerprint_key: new Uint8Array(32).fill(62),
    journal_path: join(directory, "jetstream-journal.sqlite"),
    server: broker.server,
    user: broker.user,
    password: broker.password,
    stream,
    subject_prefix: stream.replaceAll("_", "-"),
    max_consumers: 100,
    broker_max_bytes: 4000000,
    broker_max_message_bytes: 64000,
    request_timeout_ms: 2000,
    limits,
    prefetch_per_recipient: Math.min(
      policy.max_pending,
      policy.max_pending_per_recipient,
    ),
    authorization,
  };
  const opened = new Set();
  const open = async () => {
    const backend = await JetStreamRelay.open(options);
    opened.add(backend);
    return backend;
  };
  t.after(async () => {
    for (const backend of opened) await backend.close();
  });
  return { policy, options, open };
}

/**
 * The JetStream backend behind the HAB Registry, as the host wires it, for tests that drive
 * the synchronous DeliveryService directly. Every poll first runs the pump to completion.
 */
export async function jetstreamDelivery(
  t,
  { registry, limits, directory, queue: patch = {}, assertCurrent },
) {
  const maintenance = Symbol("maintenance");
  const { policy, options, open } = await openBackend(t, {
    limits,
    directory,
    queue: patch,
    authorization: {
      authorize: (context, operation) =>
        context === maintenance && operation === "maintenance"
          ? { agent_id: "maintenance" }
          : undefined,
    },
  });
  let backend = await open();
  const pumper = synchronousPump(t, options);
  let currentRegistry = registry;
  const compose = (selected = currentRegistry) => {
    const service = new HabJetStreamService(
      selected,
      backend,
      policy,
      assertCurrent,
    );
    const poll = service.poll.bind(service);
    service.poll = (context) => {
      pumper.pump();
      return poll(context);
    };
    return service;
  };
  let service = compose();
  return {
    options,
    maintenance,
    get backend() {
      return backend;
    },
    get service() {
      return service;
    },
    pump: async () => pumper.pump(),
    /** The same queue authorized by another Registry handle (a reopened or restored file). */
    serviceFor: (selected) => compose(selected),
    async reopen(nextRegistry = currentRegistry) {
      await backend.close();
      backend = await open();
      currentRegistry = nextRegistry;
      service = compose();
      return service;
    },
    close: () => backend.close(),
  };
}

/** JetStream behind a plain Authorization (no Registry), for transport and client tests. */
export async function authorizedDelivery(
  t,
  { authorization, limits, directory, queue: patch = {} },
) {
  const { options, open } = await openBackend(t, {
    limits,
    directory,
    queue: patch,
    authorization,
  });
  let backend = await open();
  const pumper = synchronousPump(t, options);
  const service = {
    submit: (context, input) =>
      backend.admitWithAuthorization(context, input, authorization),
    status: (context, id) =>
      backend.statusWithAuthorization(context, id, authorization),
    poll: (context) => {
      pumper.pump();
      return backend.pollWithAuthorization(context, authorization);
    },
    ack: (context, input) =>
      backend.ackWithAuthorization(context, input, authorization),
  };
  return {
    options,
    service,
    get backend() {
      return backend;
    },
    pump: async () => pumper.pump(),
    async reopen() {
      await backend.close();
      backend = await open();
    },
  };
}
