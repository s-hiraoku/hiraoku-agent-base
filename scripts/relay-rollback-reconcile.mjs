/**
 * Read-only rollback reconciliation list. Compares the drained schema 4 journal copy with
 * the restored pre-upgrade journal and the recipients' post-upgrade inbox copies. Prints
 * no bodies, tokens or credentials.
 */
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { RECORD_RETENTION_MS } from "../src/messaging/contract.ts";

const INCOMPLETE = new Set(["staging", "pending", "leased", "quarantined"]);
const key = (row) => JSON.stringify([row.sender_id, row.message_id]);

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

/**
 * Lists every message the upgraded release accepted or finished after the backup, that is
 * each row absent from the backup journal or incomplete in it.
 */
export function reconcile({
  upgraded,
  backup,
  inboxes = [],
  now = Date.now(),
}) {
  const before = new Map(journal(backup).map((row) => [key(row), row]));
  const saved = new Map();
  for (const path of inboxes) {
    const [meta] = read(path, "SELECT agent_id FROM relay_inbox_meta");
    saved.set(
      meta.agent_id,
      new Set(
        read(path, "SELECT sender_id,message_id FROM relay_inbox").map(key),
      ),
    );
  }
  const messages = journal(upgraded)
    .filter((row) => {
      const prior = before.get(key(row));
      return !prior || INCOMPLETE.has(prior.state);
    })
    .map((row) => {
      const inbox = saved.get(row.recipient_id);
      const recipient_record = !inbox
        ? "no_inbox_copy"
        : inbox.has(key(row))
          ? "saved"
          : "absent";
      // An inbox may collect a record 30 days after its expiry, so absence then proves nothing.
      const collectable = Number(row.expires_at) + RECORD_RETENTION_MS <= now;
      const action =
        row.state === "acked" || recipient_record === "saved"
          ? "delivered"
          : recipient_record === "absent" &&
              !collectable &&
              ["expired", "quarantined"].includes(row.state)
            ? "not_saved"
            : "unknown";
      return {
        sender_id: row.sender_id,
        message_id: row.message_id,
        recipient_id: row.recipient_id,
        expires_at: new Date(Number(row.expires_at)).toISOString(),
        backup_state: before.get(key(row))?.state ?? null,
        final_state: row.state,
        recipient_record,
        action,
      };
    });
  const restored = [...before.values()].filter((row) =>
    INCOMPLETE.has(row.state),
  );
  return {
    messages,
    restored_incomplete_expire_by: restored.length
      ? new Date(
          Math.max(...restored.map((row) => Number(row.expires_at))),
        ).toISOString()
      : null,
  };
}

const usage =
  "usage: relay-rollback-reconcile --upgraded-journal <copy> --backup-journal <restored> [--inbox <copy>]...";

export function main(args = process.argv.slice(2)) {
  const options = { inboxes: [] };
  for (let i = 0; i < args.length; i += 2) {
    const [flag, value] = [args[i], args[i + 1]];
    if (value === undefined) throw Error(usage);
    if (flag === "--inbox") options.inboxes.push(value);
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
