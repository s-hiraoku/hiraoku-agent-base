import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { TaskService } from "./store.ts";
import type { Driver, Statement, Row } from "./types.ts";
export class SQLiteDriver implements Driver {
  readonly db: DatabaseSync;
  readonly nowSQL = "hub_now()";
  clock = () => Date.now();
  constructor(path = ":memory:") {
    this.db = new DatabaseSync(path);
    try {
      this.db.function("hub_now", () => this.clock());
      this.db.exec("PRAGMA busy_timeout=5000");
      // journal_mode changes may report SQLITE_BUSY immediately on a new shared file.
      const deadline = Date.now() + 5000;
      for (;;) {
        try {
          this.db.exec("PRAGMA journal_mode=WAL");
          break;
        } catch (error) {
          if (
            !(error instanceof Error) ||
            !("errcode" in error) ||
            error.errcode !== 5 ||
            Date.now() >= deadline
          ) {
            throw error;
          }
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
        }
      }
      this.db.exec("BEGIN IMMEDIATE");
      try {
        // Refuse an unknown legacy schema instead of modifying or discarding its records.
        if (
          this.db
            .prepare("SELECT name FROM sqlite_master WHERE name='tasks'")
            .get() &&
          !this.db
            .prepare(
              "SELECT name FROM sqlite_master WHERE name='hub_migrations'",
            )
            .get()
        ) {
          throw new Error("legacy_schema_requires_reviewed_migration");
        }
        this.db.exec(
          "CREATE TABLE IF NOT EXISTS hub_migrations(id TEXT PRIMARY KEY)",
        );
        this.db.exec("COMMIT");
      } catch (e) {
        this.db.exec("ROLLBACK");
        throw e;
      }
      const root = fileURLToPath(new URL("../drizzle/", import.meta.url));
      for (const name of readdirSync(root)
        .filter((n) => n.endsWith(".sql"))
        .sort()) {
        this.db.exec("BEGIN IMMEDIATE");
        try {
          if (
            this.db
              .prepare("SELECT id FROM hub_migrations WHERE id=?")
              .get(name)
          ) {
            this.db.exec("COMMIT");
            continue;
          }
          this.db.exec(readFileSync(`${root}/${name}`, "utf8"));
          this.db.prepare("INSERT INTO hub_migrations VALUES(?)").run(name);
          this.db.exec("COMMIT");
        } catch (e) {
          this.db.exec("ROLLBACK");
          throw e;
        }
      }
    } catch (error) {
      this.db.close();
      throw error;
    }
  }
  async batch(statements: Statement[]): Promise<Row[][]> {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = statements.map(
        (s) => this.db.prepare(s.sql).all(...(s.params ?? [])) as Row[],
      );
      this.db.exec("COMMIT");
      return result;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  close() {
    this.db.close();
  }
}
export class Hub extends TaskService {
  readonly sqlite: SQLiteDriver;
  constructor(path = ":memory:", now = () => Date.now(), leaseMs = 30000) {
    const sqlite = new SQLiteDriver(path);
    super(sqlite, now, leaseMs);
    this.sqlite = sqlite;
    sqlite.clock = () => this.now();
  }
  close() {
    this.sqlite.close();
  }
}
