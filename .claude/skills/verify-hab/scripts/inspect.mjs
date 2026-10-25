#!/usr/bin/env node
/**
 * Read-only side-effect snapshot of a verify-hab run's DBs (never writes them).
 * Usage: node inspect.mjs <run-dir> [label]
 * Prints JSON and saves it as <run-dir>/evidence/NNN-inspect-<label>.json.
 * Message bodies are omitted: only ids, states, generations and audit events.
 */
import { DatabaseSync } from "node:sqlite";
import { readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const run = resolve(process.argv[2] ?? ""),
  label = process.argv[3] ?? "db";
const open = (name) =>
  new DatabaseSync(join(run, "instance", `${name}.sqlite`), { readOnly: true });
const relay = open("relay"),
  registry = open("registry");
const snapshot = {
  agents: registry
    .prepare("SELECT agent_id, address, state FROM hab_agents ORDER BY address")
    .all(),
  bindings: registry
    .prepare("SELECT agent_id, state FROM hab_bindings ORDER BY agent_id")
    .all(),
  // Stored thread keys are pair-scoped JSON [a, b, thread_id]; legacy rows keep the bare id.
  messages: relay
    .prepare(
      "SELECT sender_id, message_id, recipient_id, thread_id FROM relay_messages ORDER BY message_id",
    )
    .all()
    .map((m) => ({
      ...m,
      thread_id: m.thread_id.startsWith("[")
        ? JSON.parse(m.thread_id)[2]
        : m.thread_id,
    })),
  deliveries: relay
    .prepare(
      "SELECT message_id, recipient_id, state, generation FROM relay_deliveries ORDER BY message_id",
    )
    .all(),
  delivery_audit: relay
    .prepare("SELECT message_id, event FROM relay_delivery_audit ORDER BY id")
    .all(),
  ack_receipts: Number(
    relay.prepare("SELECT count(*) n FROM relay_ack_receipts").get().n,
  ),
};
relay.close();
registry.close();
const json = JSON.stringify(snapshot, null, 2);
const evidence = join(run, "evidence");
const n = String(
  Math.max(
    0,
    ...readdirSync(evidence).map((f) => Number(/^(\d{3})-/.exec(f)?.[1] ?? 0)),
  ) + 1,
).padStart(3, "0");
writeFileSync(join(evidence, `${n}-inspect-${label}.json`), json + "\n");
process.stdout.write(json + "\n");
