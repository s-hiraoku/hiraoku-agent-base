/** Private, bounded checkpoint journal. Contains no credentials, contexts or raw claims. */
import { DatabaseSync } from "node:sqlite";
import { constants, openSync, closeSync, fstatSync } from "node:fs";
import { EnrollmentError, parseEnrollmentCheckpoint } from "./enrollment.ts";
import type { EnrollmentCheckpoint, EnrollmentJournal } from "./enrollment.ts";

const flowPattern = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,95}$(?![\s\S])/;
export class SQLiteEnrollmentJournal implements EnrollmentJournal {
  readonly #db: DatabaseSync;
  readonly #maxSessions: number;
  #ready = false;
  constructor(
    path: string,
    options: { max_sessions: number; busy_timeout_ms: number },
  ) {
    if (
      !Number.isSafeInteger(options?.max_sessions) ||
      options.max_sessions < 1 ||
      options.max_sessions > 1000000 ||
      !Number.isSafeInteger(options.busy_timeout_ms) ||
      options.busy_timeout_ms < 1 ||
      options.busy_timeout_ms > 1000
    )
      throw new EnrollmentError("invalid_enrollment_journal_options");
    this.#maxSessions = options.max_sessions;
    let db: DatabaseSync | undefined;
    try {
      if (path !== ":memory:") {
        const fd = openSync(
          path,
          constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW,
          0o600,
        );
        try {
          const file = fstatSync(fd);
          if (!file.isFile() || (file.mode & 0o077) !== 0) throw Error();
        } finally {
          closeSync(fd);
        }
      }
      db = new DatabaseSync(path);
      db.exec(
        `PRAGMA busy_timeout=${options.busy_timeout_ms}; PRAGMA synchronous=FULL`,
      );
      this.#db = db;
    } catch {
      db?.close();
      throw new EnrollmentError("enrollment_journal_unavailable");
    }
  }
  #transaction<T>(action: () => T): T {
    let began = false;
    try {
      this.#db.exec("BEGIN IMMEDIATE");
      began = true;
      const result = action();
      this.#db.exec("COMMIT");
      return result;
    } catch (error) {
      if (began) {
        try {
          this.#db.exec("ROLLBACK");
        } catch {
          this.#ready = false;
        }
      }
      if (error instanceof EnrollmentError) throw error;
      throw new EnrollmentError("enrollment_journal_unavailable");
    }
  }
  migrate(): void {
    this.#ready = false;
    this.#transaction(() => {
      if (
        !this.#db
          .prepare(
            "SELECT 1 FROM sqlite_master WHERE name='hab_enrollment_meta'",
          )
          .get()
      ) {
        if (
          this.#db
            .prepare(
              "SELECT 1 FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'",
            )
            .get()
        )
          throw new EnrollmentError("unknown_enrollment_journal_schema");
        this.#db.exec(`
          CREATE TABLE hab_enrollment_meta(id INTEGER PRIMARY KEY CHECK(id=1),version INTEGER NOT NULL);
          INSERT INTO hab_enrollment_meta VALUES(1,1);
          CREATE TABLE hab_enrollment_sessions(flow_id TEXT PRIMARY KEY,revision INTEGER NOT NULL CHECK(revision>0),checkpoint TEXT NOT NULL CHECK(json_valid(checkpoint)));
        `);
      }
      const meta = this.#db.prepare("SELECT * FROM hab_enrollment_meta").all();
      if (meta.length !== 1 || meta[0].id !== 1 || meta[0].version !== 1)
        throw new EnrollmentError("unsupported_enrollment_journal_schema");
      this.#db
        .prepare(
          "SELECT flow_id,revision,checkpoint FROM hab_enrollment_sessions LIMIT 0",
        )
        .all();
    });
    this.#ready = true;
  }
  #check(flowId: string) {
    if (!this.#ready)
      throw new EnrollmentError("enrollment_journal_not_migrated");
    if (!flowPattern.test(flowId))
      throw new EnrollmentError("invalid_enrollment_flow");
  }
  load(flowId: string) {
    this.#check(flowId);
    return this.#transaction(() => {
      const row = this.#db
        .prepare("SELECT * FROM hab_enrollment_sessions WHERE flow_id=?")
        .get(flowId);
      if (!row) return undefined;
      const revision = Number(row.revision);
      if (
        !Number.isSafeInteger(revision) ||
        revision < 1 ||
        String(row.checkpoint).length > 8192
      )
        throw new EnrollmentError("invalid_enrollment_checkpoint");
      const checkpoint = parseEnrollmentCheckpoint(
        JSON.parse(String(row.checkpoint)),
      );
      if (checkpoint.flow_id !== flowId)
        throw new EnrollmentError("invalid_enrollment_checkpoint");
      return { revision, checkpoint };
    });
  }
  save(
    flowId: string,
    expectedRevision: number,
    value: EnrollmentCheckpoint,
  ): number {
    this.#check(flowId);
    const checkpoint = parseEnrollmentCheckpoint(value);
    if (
      checkpoint.flow_id !== flowId ||
      !Number.isSafeInteger(expectedRevision) ||
      expectedRevision < 0 ||
      expectedRevision >= Number.MAX_SAFE_INTEGER
    )
      throw new EnrollmentError("invalid_enrollment_checkpoint");
    const json = JSON.stringify(checkpoint);
    if (json.length > 8192)
      throw new EnrollmentError("invalid_enrollment_checkpoint");
    return this.#transaction(() => {
      const row = this.#db
        .prepare("SELECT revision FROM hab_enrollment_sessions WHERE flow_id=?")
        .get(flowId);
      if (Number(row?.revision ?? 0) !== expectedRevision)
        throw new EnrollmentError("enrollment_journal_conflict");
      if (
        !row &&
        Number(
          this.#db
            .prepare("SELECT count(*) n FROM hab_enrollment_sessions")
            .get()!.n,
        ) >= this.#maxSessions
      )
        throw new EnrollmentError("enrollment_journal_capacity_exceeded");
      const revision = expectedRevision + 1;
      this.#db
        .prepare(
          "INSERT INTO hab_enrollment_sessions VALUES(?,?,?) ON CONFLICT(flow_id) DO UPDATE SET revision=excluded.revision,checkpoint=excluded.checkpoint",
        )
        .run(flowId, revision, json);
      return revision;
    });
  }
  close() {
    this.#ready = false;
    this.#db.close();
  }
}
