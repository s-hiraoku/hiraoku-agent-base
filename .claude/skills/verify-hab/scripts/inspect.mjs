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
const delivery = open("delivery"),
  registry = open("registry");
const snapshot = {
  agents: registry
    .prepare("SELECT agent_id, address, state FROM hab_agents ORDER BY address")
    .all(),
  bindings: registry
    .prepare("SELECT agent_id, state FROM hab_bindings ORDER BY agent_id")
    .all(),
  // The delivery store keeps pair-scoped thread keys as JSON [[a, b], thread_id].
  messages: delivery
    .prepare(
      "SELECT sender_id, message_id, recipient_id, thread_key FROM delivery_messages ORDER BY message_id",
    )
    .all()
    .map(({ thread_key, ...m }) => ({
      ...m,
      thread_id: JSON.parse(thread_key)[1],
    })),
  deliveries: delivery
    .prepare(
      "SELECT message_id, recipient_id, state, generation FROM delivery_messages ORDER BY message_id",
    )
    .all(),
  delivery_audit: delivery
    .prepare("SELECT message_id, event FROM delivery_audit ORDER BY id")
    .all(),
  ack_receipts: Number(
    delivery
      .prepare(
        "SELECT count(*) n FROM delivery_messages WHERE ack_receipt_id IS NOT NULL",
      )
      .get().n,
  ),
};
delivery.close();
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
