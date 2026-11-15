/** Offline, operator-attested copy migration. Never rewrites or retires a live source.
 * The legacy store cannot prove its old backend/recipient; attestation is not verification. */
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import {
  constants,
  copyFileSync,
  existsSync,
  closeSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { bindingIdentity, type AgentBinding } from "./binding.ts";
import { z } from "zod";
import { fitHermesText } from "./hermes-desktop.ts";
import { peekedMessageSchema } from "./contract.ts";
import { SQLiteNotices } from "./sqlite-notices.ts";

export interface NoticeMigrationPlan {
  source: string;
  destination_directory: string;
  expected_source_target: string;
  destination_binding: AgentBinding;
  /** Obtained from inspectNoticeMigration; refuses changes between review and execution. */
  expected_source_sha256?: string;
  /** Explicit offline pair migration for the legacy Hermes five-element file binding. */
  hermes_screen?: {
    source: string;
    expected_source_sha256?: string;
    legacy_binding: [string, string, string, string, string];
  };
}
export interface NoticeMigrationAttestation {
  notifiers_stopped_and_source_will_not_restart: true;
  old_connection_recipient_and_existing_session_verified: true;
}
const hash = (path: string) =>
  createHash("sha256").update(readFileSync(path)).digest("hex");
function privateFile(path: string) {
  const info = lstatSync(path);
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    info.mode & 0o077 ||
    info.uid !== process.getuid?.()
  )
    throw new Error("migration_source_not_private");
  if (realpathSync(path) !== resolve(path))
    throw new Error("migration_symlink_path");
}
function sync(path: string) {
  const fd = openSync(path, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
const screenState = z.enum([
  "showing",
  "shown",
  "later",
  "declining",
  "declined",
  "accepting",
  "accept_waiting",
  "started",
  "queued",
  "unsupported",
  "unknown",
  "unavailable",
  "expired",
]);
const noticeLineSchema = z.strictObject({
  type: z.literal("notice"),
  sender_id: z.string(),
  message_id: z.string(),
  from: z.string().nullable(),
  display: z.string(),
  at: z.string().refine((x) => Number.isFinite(Date.parse(x))),
  binding: z.string(),
});
const stateLineSchema = z.strictObject({
  type: z.literal("state"),
  sender_id: z.string(),
  message_id: z.string(),
  state: screenState,
  at: z.string().refine((x) => Number.isFinite(Date.parse(x))),
});
const pairKey = (row: { sender_id: string; message_id: string }) =>
  JSON.stringify([row.sender_id, row.message_id]);
function supportedSchema(db: DatabaseSync) {
  for (const [table, required] of [
    ["notices_meta", ["id", "target"]],
    [
      "notices",
      [
        "sender_id",
        "message_id",
        "state",
        "sender",
        "expires_at",
        "shown_at",
        "decided_at",
        "message",
      ],
    ],
  ] as const) {
    const columns = (
      db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]
    ).map((x) => x.name);
    if (
      required.some((x) => !columns.includes(x)) ||
      columns.some((x) => ![...required, "revision"].includes(x))
    )
      throw new Error("migration_unsupported_schema");
  }
  const extra = db
    .prepare(
      "SELECT name,type FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'",
    )
    .all() as { name: string; type: string }[];
  if (
    extra.some(
      (x) =>
        ![
          "notices_meta",
          "notices",
          "notices_state",
          "notices_insert_revision",
          "notices_state_revision",
        ].includes(x.name),
    )
  )
    throw new Error("migration_unsupported_schema");
}
function screenCopy(db: DatabaseSync, plan: NoticeMigrationPlan) {
  const screen = plan.hermes_screen;
  if (!screen) return undefined;
  privateFile(screen.source);
  const before = statSync(screen.source);
  if (before.size > 64 * 1024 * 1024)
    throw new Error("migration_screen_too_large");
  const original = readFileSync(screen.source);
  const source_sha256 = createHash("sha256").update(original).digest("hex");
  if (
    screen.expected_source_sha256 &&
    screen.expected_source_sha256 !== source_sha256
  )
    throw new Error("migration_screen_changed");
  const old = z
    .tuple([
      z.string().min(1),
      z.string().min(1),
      z.string().min(1),
      z.string().min(1),
      z.string().min(1),
    ])
    .parse(screen.legacy_binding);
  let connection: unknown;
  try {
    connection = JSON.parse(plan.destination_binding.connection_id);
  } catch {
    throw new Error("migration_screen_binding_mismatch");
  }
  if (
    plan.destination_binding.product !== "hermes-desktop" ||
    plan.destination_binding.session_id !== old[0] ||
    plan.destination_binding.profile !== old[1] ||
    plan.destination_binding.recipient_id !== old[4] ||
    !Array.isArray(connection) ||
    connection.length !== 3 ||
    typeof connection[0] !== "string" ||
    !connection[0] ||
    connection[1] !== old[2] ||
    connection[2] !== old[3] ||
    plan.expected_source_target !== `hermes-desktop:${old[1]}:${old[0]}`
  )
    throw new Error("migration_screen_binding_mismatch");
  const oldKey = JSON.stringify(old),
    newKey = JSON.stringify([...old, connection[0]]);
  const rows = db
    .prepare("SELECT sender_id,message_id,state,message FROM notices")
    .all() as {
    sender_id: string;
    message_id: string;
    state: string;
    message: string;
  }[];
  const byKey = new Map(rows.map((row) => [pairKey(row), row]));
  const seen = new Set<string>();
  const text = original.toString("utf8");
  if (
    !Buffer.from(text).equals(original) ||
    (text.length && !text.endsWith("\n"))
  )
    throw new Error("migration_screen_incomplete");
  const lines = text ? text.slice(0, -1).split("\n") : [];
  const converted = lines.map((line) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw new Error("migration_screen_unsupported_schema");
    }
    const n = noticeLineSchema.safeParse(parsed),
      state = stateLineSchema.safeParse(parsed);
    if (!n.success && !state.success)
      throw new Error("migration_screen_unsupported_schema");
    const value = n.success ? n.data : state.data!;
    const row = byKey.get(pairKey(value));
    if (!row) throw new Error("migration_screen_missing_decision");
    if (n.success) {
      if (n.data.binding !== oldKey)
        throw new Error("migration_screen_binding_mismatch");
      const message = peekedMessageSchema.parse(JSON.parse(row.message));
      if (
        message.sender_id !== n.data.sender_id ||
        message.message_id !== n.data.message_id ||
        message.from !== n.data.from ||
        fitHermesText(message.display) !== n.data.display
      )
        throw new Error("migration_screen_payload_mismatch");
      seen.add(pairKey(value));
      return JSON.stringify({ ...n.data, binding: newKey });
    }
    return line; // Historical decision lines are not the authority; keep their bytes/order.
  });
  if (
    rows.some(
      (row) =>
        ["shown", "later"].includes(row.state) && !seen.has(pairKey(row)),
    )
  )
    throw new Error("migration_screen_missing_notice");
  const verify = () => {
    privateFile(screen.source);
    const after = statSync(screen.source);
    if (
      before.ino !== after.ino ||
      before.dev !== after.dev ||
      hash(screen.source) !== source_sha256
    )
      throw new Error("migration_screen_changed");
  };
  verify();
  return {
    original,
    converted: converted.length ? converted.join("\n") + "\n" : "",
    source_sha256,
    notice_count: seen.size,
    verify,
  };
}
function inspectLocked(db: DatabaseSync, plan: NoticeMigrationPlan) {
  if (
    plan.destination_binding.product === "hermes-desktop" &&
    plan.expected_source_target.startsWith("hermes-desktop:") &&
    !plan.hermes_screen
  )
    throw new Error("migration_hermes_screen_required");
  supportedSchema(db);
  const bound = db
    .prepare("SELECT target FROM notices_meta WHERE id=1")
    .get() as { target: string } | undefined;
  if (bound?.target !== plan.expected_source_target)
    throw new Error("migration_source_binding_mismatch");
  if (Object.values(db.prepare("PRAGMA quick_check").get() ?? {})[0] !== "ok")
    throw new Error("migration_source_corrupt");
  const blocked = db
    .prepare(
      "SELECT COUNT(*) AS n FROM notices WHERE state IN ('showing','accepting','accept_waiting','declining','unknown')",
    )
    .get() as { n: number };
  if (blocked.n)
    throw new Error("migration_unsettled_decisions_reconcile_first");
  const states = db
    .prepare(
      "SELECT state,COUNT(*) AS count FROM notices GROUP BY state ORDER BY state",
    )
    .all();
  return {
    source_target: bound.target,
    destination_target: bindingIdentity(plan.destination_binding),
    states,
  };
}
function openSource(plan: NoticeMigrationPlan) {
  privateFile(plan.source);
  // Opening a hot rollback journal or closing the last WAL connection can modify
  // the source as recovery. Refuse either artifact before SQLite can recover it.
  const rejectPendingRecovery = () => {
    for (const suffix of ["-wal", "-journal"]) {
      if (
        existsSync(plan.source + suffix) &&
        statSync(plan.source + suffix).size > 0
      )
        throw new Error(
          suffix === "-wal"
            ? "migration_source_wal_requires_offline_checkpoint"
            : "migration_source_journal_requires_offline_recovery",
        );
    }
  };
  rejectPendingRecovery();
  const identity = statSync(plan.source);
  const db = new DatabaseSync(plan.source);
  try {
    db.exec("PRAGMA busy_timeout=0; BEGIN EXCLUSIVE");
    rejectPendingRecovery();
    const current = lstatSync(plan.source);
    if (current.ino !== identity.ino || current.dev !== identity.dev)
      throw new Error("migration_source_replaced");
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}
export function inspectNoticeMigration(plan: NoticeMigrationPlan) {
  const db = openSource(plan);
  try {
    return {
      ...inspectLocked(db, plan),
      source_sha256: hash(plan.source),
      ...(plan.hermes_screen
        ? (() => {
            const screen = screenCopy(db, plan)!;
            return {
              screen_source_sha256: screen.source_sha256,
              screen_notice_count: screen.notice_count,
            };
          })()
        : {}),
      old_identity_requires_operator_verification: true,
    };
  } finally {
    db.exec("ROLLBACK");
    db.close();
  }
}

/** Creates an atomic bundle containing original backup + migrated copy + manifest.
 * The source stays unchanged. Operator must keep it stopped permanently after cutover.
 * No command here installs configuration, deploys, starts an agent or restores a snapshot. */
export function migrateNoticesOffline(
  plan: NoticeMigrationPlan,
  attestation: NoticeMigrationAttestation,
) {
  if (
    attestation.notifiers_stopped_and_source_will_not_restart !== true ||
    attestation.old_connection_recipient_and_existing_session_verified !== true
  )
    throw new Error("migration_operator_attestation_required");
  if (!plan.expected_source_sha256)
    throw new Error("migration_reviewed_fingerprint_required");
  if (plan.hermes_screen && !plan.hermes_screen.expected_source_sha256)
    throw new Error("migration_screen_fingerprint_required");
  const destination = resolve(plan.destination_directory);
  const parent = dirname(destination);
  const parentInfo = statSync(parent);
  if (
    realpathSync(parent) !== parent ||
    !parentInfo.isDirectory() ||
    parentInfo.mode & 0o077 ||
    parentInfo.uid !== process.getuid?.()
  )
    throw new Error("migration_destination_parent_not_private");
  // Never merge with or overwrite a previous attempt; retained bundles are evidence.
  if (existsSync(destination)) throw new Error("migration_destination_exists");
  const lock = destination + ".migration-lock";
  mkdirSync(lock, { mode: 0o700 });
  let staging: string | undefined;
  let db: DatabaseSync | undefined;
  try {
    db = openSource(plan);
    const report = inspectLocked(db, plan);
    const screen = screenCopy(db, plan);
    if (hash(plan.source) !== plan.expected_source_sha256)
      throw new Error("migration_source_changed");
    staging = mkdtempSync(join(parent, ".hab-migration-"));
    const backup = join(staging, "source.sqlite");
    const migrated = join(staging, "notices.sqlite");
    copyFileSync(plan.source, backup, constants.COPYFILE_EXCL);
    copyFileSync(backup, migrated, constants.COPYFILE_EXCL);
    if (
      hash(backup) !== plan.expected_source_sha256 ||
      hash(plan.source) !== plan.expected_source_sha256
    )
      throw new Error("migration_copy_mismatch");
    const copy = new DatabaseSync(migrated);
    try {
      copy
        .prepare("UPDATE notices_meta SET target=? WHERE id=1 AND target=?")
        .run(report.destination_target, plan.expected_source_target);
    } finally {
      copy.close();
    }
    const upgraded = new SQLiteNotices(migrated, report.destination_target);
    upgraded.close();
    const verify = new DatabaseSync(migrated, { readOnly: true });
    try {
      const columns = (db: DatabaseSync) =>
        (
          db.prepare("PRAGMA table_info(notices)").all() as { name: string }[]
        ).map((x) => x.name);
      const oldColumns = columns(db);
      const select = `SELECT ${oldColumns.map((name) => `"${name.replaceAll('"', '""')}"`).join(",")} FROM notices ORDER BY sender_id,message_id`;
      if (
        JSON.stringify(db.prepare(select).all()) !==
        JSON.stringify(verify.prepare(select).all())
      )
        throw new Error("migration_decisions_changed");
    } finally {
      verify.close();
    }
    if (screen) {
      writeFileSync(join(staging, "source-screen.jsonl"), screen.original, {
        mode: 0o600,
        flag: "wx",
      });
      writeFileSync(join(staging, "screen.jsonl"), screen.converted, {
        mode: 0o600,
        flag: "wx",
      });
    }
    writeFileSync(
      join(staging, "manifest.json"),
      JSON.stringify(
        {
          ...report,
          source_sha256: hash(backup),
          migrated_sha256: hash(migrated),
          ...(screen
            ? {
                screen_source_sha256: screen.source_sha256,
                screen_sha256: hash(join(staging, "screen.jsonl")),
                screen_notice_count: screen.notice_count,
              }
            : {}),
          attestation,
          warning:
            "Legacy identity is operator-attested, not derivable from the store. Never restart source or restore its snapshot after new decisions.",
        },
        null,
        2,
      ) + "\n",
      { mode: 0o600, flag: "wx" },
    );
    for (const name of ["source.sqlite", "notices.sqlite", "manifest.json"])
      sync(join(staging, name));
    if (screen) {
      sync(join(staging, "source-screen.jsonl"));
      sync(join(staging, "screen.jsonl"));
      screen.verify();
    }
    if (hash(plan.source) !== plan.expected_source_sha256)
      throw new Error("migration_source_changed");
    sync(staging);
    if (existsSync(destination))
      throw new Error("migration_destination_exists");
    renameSync(staging, destination);
    staging = undefined;
    sync(parent);
    return { ...report, destination_directory: destination };
  } finally {
    if (db) {
      db.exec("ROLLBACK");
      db.close();
    }
    if (staging) rmSync(staging, { recursive: true, force: true });
    rmSync(lock, { recursive: true });
  }
}
