import { existsSync, lstatSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { SqliteDelivery } from "../src/delivery/sqlite-delivery.ts";
import { HabDeliveryService } from "../src/host/hab-delivery-service.ts";

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

/** The private delivery store file a host keeps in its state directory. */
export const DELIVERY_FILE = "delivery.sqlite";

/** Polls a client until a delivery arrives or the deadline passes. */
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
  const identity = join(directory, "volume.local.json");
  if (!existsSync(identity))
    writeFileSync(
      identity,
      JSON.stringify({ version: 1, volume_id: "synthetic-volume" }),
      { mode: 0o600 },
    );
  return {
    volume: {
      identity_file: identity,
      expected_id: "synthetic-volume",
      expected_device: lstatSync(directory).dev,
    },
    queue: { ...queue, ...patch.queue },
    ...(patch.maintenance === undefined
      ? {}
      : { maintenance: patch.maintenance }),
  };
}

function openStore(t, { limits, directory, queue: patch, authorization }) {
  const policy = { ...queue, ...patch };
  const options = {
    ...policy,
    fingerprint_key: new Uint8Array(32).fill(62),
    path: join(directory, DELIVERY_FILE),
    limits,
    authorization,
  };
  const opened = new Set();
  const open = () => {
    const backend = SqliteDelivery.open(options);
    opened.add(backend);
    return backend;
  };
  t.after(() => {
    for (const backend of opened) backend.close();
  });
  return { policy, options, open };
}

/**
 * The SQLite store behind the HAB Registry, as the host wires it, for tests that drive the
 * synchronous DeliveryService directly.
 */
export async function sqliteDelivery(
  t,
  { registry, limits, directory, queue: patch = {}, assertCurrent },
) {
  const maintenance = Symbol("maintenance");
  const { options, open } = openStore(t, {
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
  let backend = open();
  let currentRegistry = registry;
  const compose = (selected = currentRegistry) =>
    new HabDeliveryService(selected, backend, assertCurrent);
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
    /** The same queue authorized by another Registry handle (a reopened or restored file). */
    serviceFor: (selected) => compose(selected),
    async reopen(nextRegistry = currentRegistry) {
      backend.close();
      backend = open();
      currentRegistry = nextRegistry;
      service = compose();
      return service;
    },
    close: async () => backend.close(),
  };
}

/** The SQLite store behind a plain Authorization (no Registry), for transport and client tests. */
export async function authorizedDelivery(
  t,
  { authorization, limits, directory, queue: patch = {} },
) {
  const { options, open } = openStore(t, {
    limits,
    directory,
    queue: patch,
    authorization,
  });
  let backend = open();
  const service = {
    submit: (context, input) =>
      backend.admitWithAuthorization(context, input, authorization),
    status: (context, id) =>
      backend.statusWithAuthorization(context, id, authorization),
    poll: (context) => backend.pollWithAuthorization(context, authorization),
    ack: (context, input) =>
      backend.ackWithAuthorization(context, input, authorization),
    inbox: (context, options = { limit: 10, include_read: false }) =>
      backend.readInboxWithAuthorization(context, authorization, options),
    received: (context, id) =>
      backend.receivedWithAuthorization(context, id, authorization),
  };
  return {
    options,
    service,
    get backend() {
      return backend;
    },
    async reopen() {
      backend.close();
      backend = open();
    },
  };
}
