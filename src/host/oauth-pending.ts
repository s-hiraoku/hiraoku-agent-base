/**
 * Sign-ins that passed every OAuth check except the connection ledger: the operator
 * approves one with `hab:admin approve` instead of finding its subject in Auth0's logs.
 * A row holds only who tried and when; never a token, scope or message. The host
 * writes it; the operator CLI lists and removes rows.
 */
import { createHash } from "node:crypto";
import { chmodSync, existsSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

export const PENDING_FILE = "oauth-pending.sqlite";
export const PENDING_MAX_ROWS = 32;
export const PENDING_TTL_MS = 14 * 86_400_000;

export interface PendingSignIn {
  issuer: string;
  subject: string;
  client_id: string;
}
export interface PendingRow extends PendingSignIn {
  pending_id: string;
  first_seen_at: number;
  last_seen_at: number;
  attempts: number;
}

const SCHEMA = `CREATE TABLE IF NOT EXISTS hab_oauth_pending (
  pending_id TEXT PRIMARY KEY,
  issuer TEXT NOT NULL,
  subject TEXT NOT NULL,
  client_id TEXT NOT NULL,
  first_seen_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL,
  known_subject INTEGER NOT NULL)`;

/** Stable for one sign-in, so a rejected one that returns gets the same ID. */
export function pendingId({ issuer, subject, client_id }: PendingSignIn) {
  return (
    "pend_" +
    createHash("sha256")
      .update(JSON.stringify([issuer, subject, client_id]))
      .digest("hex")
      .slice(0, 16)
  );
}

export class PendingConnections {
  readonly #db: DatabaseSync;
  constructor(directory: string) {
    const path = join(directory, PENDING_FILE);
    const created = !existsSync(path);
    this.#db = new DatabaseSync(path, { timeout: 5000 });
    if (created) chmodSync(path, 0o600);
    this.#db.exec(SCHEMA);
  }
  /**
   * Record one fully verified but unregistered sign-in. `knownSubject` says the ledger
   * already has this subject (the owner's other product, or a product that came back
   * with a new client): such rows are never pushed out to make room for strangers.
   */
  record(signIn: PendingSignIn, knownSubject: boolean, now = Date.now()) {
    if (!this.#db.isOpen) return false;
    const id = pendingId(signIn);
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      this.#db
        .prepare("DELETE FROM hab_oauth_pending WHERE last_seen_at <= ?")
        .run(now - PENDING_TTL_MS);
      const seen = this.#db
        .prepare(
          "UPDATE hab_oauth_pending SET last_seen_at=?, attempts=attempts+1, known_subject=? WHERE pending_id=?",
        )
        .run(now, knownSubject ? 1 : 0, id);
      if (!seen.changes && !this.#makeRoom(knownSubject)) {
        this.#db.exec("COMMIT");
        return false;
      }
      if (!seen.changes)
        this.#db
          .prepare(
            `INSERT INTO hab_oauth_pending
             (pending_id,issuer,subject,client_id,first_seen_at,last_seen_at,attempts,known_subject)
             VALUES (?,?,?,?,?,?,1,?)`,
          )
          .run(
            id,
            signIn.issuer,
            signIn.subject,
            signIn.client_id,
            now,
            now,
            knownSubject ? 1 : 0,
          );
      this.#db.exec("COMMIT");
      return true;
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }
  /** Free one row when full: a stranger's oldest first; a known subject's only for another known one. */
  #makeRoom(knownSubject: boolean) {
    const { n } = this.#db
      .prepare("SELECT count(*) AS n FROM hab_oauth_pending")
      .get() as { n: number };
    if (n < PENDING_MAX_ROWS) return true;
    const victim = this.#db
      .prepare(
        `SELECT pending_id FROM hab_oauth_pending
         WHERE known_subject=0 OR ?=1
         ORDER BY known_subject, last_seen_at LIMIT 1`,
      )
      .get(knownSubject ? 1 : 0) as { pending_id: string } | undefined;
    if (!victim) return false;
    this.#db
      .prepare("DELETE FROM hab_oauth_pending WHERE pending_id=?")
      .run(victim.pending_id);
    return true;
  }
  close() {
    if (this.#db.isOpen) this.#db.close();
  }
}

/** Rows still in time, newest first, or none when the host never recorded one. */
export function readPending(directory: string, now = Date.now()): PendingRow[] {
  const path = join(directory, PENDING_FILE);
  if (!existsSync(path)) return [];
  const db = new DatabaseSync(path, { readOnly: true, timeout: 5000 });
  try {
    return (
      db
        .prepare(
          `SELECT pending_id,issuer,subject,client_id,first_seen_at,last_seen_at,attempts
           FROM hab_oauth_pending WHERE last_seen_at > ? ORDER BY last_seen_at DESC`,
        )
        .all(now - PENDING_TTL_MS) as unknown as PendingRow[]
    ).map((row) => ({ ...row }));
  } finally {
    db.close();
  }
}

/** Remove one row; true when it was there. */
export function removePending(directory: string, id: string) {
  const path = join(directory, PENDING_FILE);
  if (!existsSync(path)) return false;
  const db = new DatabaseSync(path, { timeout: 5000 });
  try {
    return (
      db.prepare("DELETE FROM hab_oauth_pending WHERE pending_id=?").run(id)
        .changes > 0
    );
  } finally {
    db.close();
  }
}
