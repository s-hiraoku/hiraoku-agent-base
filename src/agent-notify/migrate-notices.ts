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
import { SQLiteNotices } from "./sqlite-notices.ts";

export interface NoticeMigrationPlan {
  source: string;
  destination_directory: string;
  expected_source_target: string;
  destination_binding: AgentBinding;
  /** Obtained from inspectNoticeMigration; refuses changes between review and execution. */
  expected_source_sha256?: string;
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
function inspectLocked(db: DatabaseSync, plan: NoticeMigrationPlan) {
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
    writeFileSync(
      join(staging, "manifest.json"),
      JSON.stringify(
        {
          ...report,
          source_sha256: hash(backup),
          migrated_sha256: hash(migrated),
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
