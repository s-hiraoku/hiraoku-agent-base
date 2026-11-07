/**
 * Read-only rollback reconciliation list. Compares the drained schema 4 journal copy with
 * the restored pre-upgrade journal, the recipients' post-upgrade inbox copies, the inboxes
 * the backup restores and the recipients' copied execution records. Prints no bodies,
 * tokens or credentials.
 */
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { RECORD_RETENTION_MS } from "../src/messaging/contract.ts";

const INCOMPLETE = new Set(["staging", "pending", "leased", "quarantined"]);
const key = (row) => JSON.stringify([row.sender_id, row.message_id]);
const iso = (ms) => new Date(Number(ms)).toISOString();

function read(path, query) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return db.prepare(query).all();
  } finally {
    db.close();
  }
}
const journal = (path) =>
  read(
    path,
    "SELECT sender_id,message_id,recipient_id,state,expires_at FROM nats_messages ORDER BY sender_id,message_id",
  );
const inboxAgent = (path) =>
  read(path, "SELECT agent_id FROM relay_inbox_meta")[0].agent_id;
/** Each inbox copy by agent: message key → its saved metadata (never the body). */
function inboxCopies(paths) {
  const copies = new Map();
  for (const path of paths)
    copies.set(
      inboxAgent(path),
      new Map(
        read(
          path,
          "SELECT sender_id,message_id,expires_at,released_at FROM relay_inbox",
        ).map((row) => [key(row), row]),
      ),
    );
  return copies;
}
/** `{recipient_id, handled: [{sender_id, message_id}]}` exported from an application's execution records. */
function executionRecords(paths) {
  const records = new Map();
  for (const path of paths) {
    const { recipient_id, handled } = JSON.parse(readFileSync(path, "utf8"));
    if (typeof recipient_id !== "string" || !Array.isArray(handled))
      throw Error(`invalid execution record: ${path}`);
    records.set(recipient_id, new Set(handled.map(key)));
  }
  return records;
}

/**
 * Lists every message whose outcome the restore erases: each ID the upgraded release
 * accepted that remains in supplied evidence, and each ID incomplete in the backup,
 * whether or not the upgraded journal still has its row. Separately lists bodies
 * restored unreleased and bodies retained only in upgraded copies.
 */
export function reconcile({
  upgraded,
  backup,
  inboxes = [],
  backupInboxes = [],
  executions = [],
  now = Date.now(),
}) {
  const before = new Map(journal(backup).map((row) => [key(row), row]));
  const after = new Map(journal(upgraded).map((row) => [key(row), row]));
  const saved = inboxCopies(inboxes);
  const handled = executionRecords(executions);
  const restoredCopies = inboxCopies(backupInboxes);
  const listed = [
    ...[...after.values()].filter((row) => {
      const prior = before.get(key(row));
      return !prior || INCOMPLETE.has(prior.state);
    }),
    // A row the upgraded journal already purged is still unresolved.
    ...[...before.values()].filter(
      (row) => INCOMPLETE.has(row.state) && !after.has(key(row)),
    ),
  ];
  // GC can erase a post-backup admission from both journals. Retained recipient
  // evidence must still be reconciled; execution exports need not contain expiry.
  const candidates = new Map(listed.map((row) => [key(row), row]));
  const include = (row) => {
    if (!before.has(key(row)) && !candidates.has(key(row)))
      candidates.set(key(row), row);
  };
  for (const [recipient_id, rows] of saved)
    for (const row of rows.values()) include({ ...row, recipient_id });
  for (const [recipient_id, rows] of handled)
    for (const id of rows) {
      const [sender_id, message_id] = JSON.parse(id);
      include({ sender_id, message_id, recipient_id, expires_at: null });
    }
  const messages = [...candidates.values()]
    .sort((a, b) => key(a).localeCompare(key(b)))
    .map((row) => {
      const final = after.get(key(row));
      const inbox = saved.get(row.recipient_id);
      const recipient_record = !inbox
        ? "no_inbox_copy"
        : inbox.has(key(row))
          ? "saved"
          : "absent";
      // An inbox may collect a record 30 days after its expiry, so absence then proves nothing.
      const collectable =
        row.expires_at === null ||
        Number(row.expires_at) + RECORD_RETENTION_MS <= now;
      const action =
        final?.state === "acked" || recipient_record === "saved"
          ? "delivered"
          : final &&
              recipient_record === "absent" &&
              !collectable &&
              ["expired", "quarantined"].includes(final.state)
            ? "not_saved"
            : "unknown";
      return {
        sender_id: row.sender_id,
        message_id: row.message_id,
        recipient_id: row.recipient_id,
        expires_at: row.expires_at === null ? null : iso(row.expires_at),
        backup_state: before.get(key(row))?.state ?? null,
        final_state: final?.state ?? null,
        recipient_record,
        execution_record: !handled.has(row.recipient_id)
          ? "no_record_copy"
          : handled.get(row.recipient_id).has(key(row))
            ? "handled"
            : "absent",
        action,
      };
    });
  // ACK proves the save, not the execution: a body acked before the backup but processed
  // after it comes back unprocessed with the restored inbox.
  const restored_bodies = [];
  for (const path of backupInboxes) {
    const recipient_id = inboxAgent(path);
    const copy = saved.get(recipient_id);
    const record = handled.get(recipient_id);
    for (const row of read(
      path,
      "SELECT sender_id,message_id,expires_at FROM relay_inbox WHERE released_at IS NULL ORDER BY sender_id,message_id",
    )) {
      const upgraded_record = !copy
        ? "no_inbox_copy"
        : !copy.has(key(row))
          ? "absent"
          : copy.get(key(row)).released_at !== null
            ? "released"
            : "unreleased";
      const execution_record = !record
        ? "no_record_copy"
        : record.has(key(row))
          ? "handled"
          : "absent";
      restored_bodies.push({
        recipient_id,
        sender_id: row.sender_id,
        message_id: row.message_id,
        expires_at: row.expires_at === null ? null : iso(row.expires_at),
        upgraded_record,
        execution_record,
        action:
          execution_record === "handled"
            ? "do_not_process"
            : execution_record === "absent" && upgraded_record === "unreleased"
              ? "process"
              : "unknown",
      });
    }
  }
  // These bodies are retained only in the upgraded copy. Waiting for relay expiry
  // cannot move them into the restored inbox. This is a review list, not replay.
  const retained_bodies = [];
  for (const [recipient_id, rows] of saved) {
    const restoredCopy = restoredCopies.get(recipient_id);
    const record = handled.get(recipient_id);
    for (const row of rows.values()) {
      if (row.released_at !== null) continue;
      const prior = restoredCopy?.get(key(row));
      if (prior?.released_at === null) continue; // already in restored_bodies
      const execution_record = !record
        ? "no_record_copy"
        : record.has(key(row))
          ? "handled"
          : "absent";
      retained_bodies.push({
        recipient_id,
        sender_id: row.sender_id,
        message_id: row.message_id,
        expires_at: iso(row.expires_at),
        backup_record: !restoredCopy
          ? "no_inbox_copy"
          : prior
            ? "released"
            : "absent",
        execution_record,
        action:
          execution_record === "handled"
            ? "do_not_process"
            : execution_record === "absent" && restoredCopy && !prior
              ? "review_application_handoff"
              : "unknown",
      });
    }
  }
  retained_bodies.sort(
    (a, b) =>
      a.recipient_id.localeCompare(b.recipient_id) ||
      key(a).localeCompare(key(b)),
  );
  const restored = [...before.values()].filter((row) =>
    INCOMPLETE.has(row.state),
  );
  return {
    messages,
    restored_bodies,
    retained_bodies,
    restored_incomplete_expire_by: restored.length
      ? iso(Math.max(...restored.map((row) => Number(row.expires_at))))
      : null,
  };
}

const usage =
  "usage: relay-rollback-reconcile --upgraded-journal <copy> --backup-journal <restored> [--inbox <copy>]... [--backup-inbox <restored>]... [--execution-record <json>]...";

export function main(args = process.argv.slice(2)) {
  const options = { inboxes: [], backupInboxes: [], executions: [] };
  const lists = {
    "--inbox": options.inboxes,
    "--backup-inbox": options.backupInboxes,
    "--execution-record": options.executions,
  };
  for (let i = 0; i < args.length; i += 2) {
    const [flag, value] = [args[i], args[i + 1]];
    if (value === undefined) throw Error(usage);
    if (Object.hasOwn(lists, flag)) lists[flag].push(value);
    else if (flag === "--upgraded-journal" && !options.upgraded)
      options.upgraded = value;
    else if (flag === "--backup-journal" && !options.backup)
      options.backup = value;
    else throw Error(usage);
  }
  if (!options.upgraded || !options.backup) throw Error(usage);
  return reconcile(options);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    process.stdout.write(JSON.stringify(main(), null, 2) + "\n");
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
