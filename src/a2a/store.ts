import { DatabaseSync } from "node:sqlite";
import type { StatementSync } from "node:sqlite";
import {
  closeSync,
  existsSync,
  lstatSync,
  openSync,
  readFileSync,
} from "node:fs";
import { Kysely, SqliteDialect } from "kysely";
import type { SqliteDatabase, SqliteStatement } from "kysely";
import { DatabaseTaskStore } from "@a2a-js/sdk/server/database";

/**
 * Kysely's SQLite driver over the built-in `node:sqlite`, so the Task store
 * needs no native addon. Kysely passes parameters as one array; `node:sqlite`
 * takes them as arguments. A statement that returns columns is a reader.
 */
function kyselyDatabase(sqlite: DatabaseSync): SqliteDatabase {
  const params = (parameters: ReadonlyArray<unknown>) =>
    parameters as unknown as Parameters<StatementSync["all"]>;
  return {
    close: () => {
      if (sqlite.isOpen) sqlite.close();
    },
    prepare(sql: string): SqliteStatement {
      const statement = sqlite.prepare(sql);
      return {
        reader: statement.columns().length > 0,
        all: (parameters) => statement.all(...params(parameters)),
        run: (parameters) => statement.run(...params(parameters)),
        iterate: (parameters) => statement.iterate(...params(parameters)),
      };
    },
  };
}

interface StoredTaskKey {
  tenant: string;
  owner: string;
  id: string;
}

/** A plain key object; `node:sqlite` rows have a null prototype. */
function taskKey(row: Record<string, unknown> | undefined) {
  if (!row) return undefined;
  return {
    tenant: String(row.tenant),
    owner: String(row.owner),
    id: String(row.id),
  } satisfies StoredTaskKey;
}

export function openA2aTaskStore(path: string) {
  if (path !== ":memory:") {
    if (!existsSync(path)) closeSync(openSync(path, "wx", 0o600));
    const stat = lstatSync(path);
    if (!stat.isFile() || (stat.mode & 0o077) !== 0)
      throw Error("A2A store requires a private regular file");
  }
  const sqlite = new DatabaseSync(path, { timeout: 5000 });
  try {
    const tables = sqlite
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
      )
      .all();
    const initialized = Boolean(
      sqlite
        .prepare(
          "SELECT 1 FROM sqlite_master WHERE type='table' AND name='hab_a2a_tasks'",
        )
        .get(),
    );
    if (tables.length && !initialized)
      throw Error("A2A store requires a dedicated database");
    sqlite.exec("PRAGMA journal_mode = WAL");
    if (!initialized) {
      const schema = readFileSync(
        new URL("./sdk-task-schema.sql", import.meta.url),
        "utf8",
      );
      sqlite.exec("BEGIN IMMEDIATE");
      try {
        sqlite.exec(schema);
        sqlite.exec("COMMIT");
      } catch (error) {
        sqlite.exec("ROLLBACK");
        throw error;
      }
    }
    const source = "json_extract(metadata,'$.hab.source.message_id')";
    sqlite.exec(
      `CREATE INDEX IF NOT EXISTS hab_a2a_tasks_source ON hab_a2a_tasks(${source})`,
    );
    const bySource = sqlite.prepare(
      `SELECT tenant,owner,id FROM hab_a2a_tasks WHERE ${source}=?`,
    );
    const overdue = sqlite.prepare(
      `SELECT tenant,owner,id FROM hab_a2a_tasks WHERE status_state NOT IN ('TASK_STATE_COMPLETED','TASK_STATE_FAILED','TASK_STATE_CANCELED','TASK_STATE_REJECTED') AND json_extract(metadata,'$.hab.source.expires_at')<=? AND (tenant,owner,id)>(?,?,?) ORDER BY tenant,owner,id LIMIT ?`,
    );
    const nextExpiry = sqlite.prepare(
      `SELECT min(json_extract(metadata,'$.hab.source.expires_at')) at FROM hab_a2a_tasks WHERE status_state NOT IN ('TASK_STATE_COMPLETED','TASK_STATE_FAILED','TASK_STATE_CANCELED','TASK_STATE_REJECTED') AND json_extract(metadata,'$.hab.source.expires_at')>?`,
    );
    const db = new Kysely({
      dialect: new SqliteDialect({ database: kyselyDatabase(sqlite) }),
    });
    return {
      store: new DatabaseTaskStore(db, { tableName: "hab_a2a_tasks" }),
      /** The stored Task whose delivery request has this message ID, without a caller scope. */
      findBySource: (messageId: string) => taskKey(bySource.get(messageId)),
      /** Bounded stable-key page; a failed apply need not block later overdue Tasks. */
      overdue: (expiredBy: string, limit: number, after?: StoredTaskKey) =>
        overdue
          .all(
            expiredBy,
            after?.tenant ?? "",
            after?.owner ?? "",
            after?.id ?? "",
            limit,
          )
          .map((row) => taskKey(row) as StoredTaskKey),
      /** The earliest delivery request expiry after `after` among non-terminal Tasks. */
      nextExpiry: (after: string) =>
        (nextExpiry.get(after) as unknown as { at: string | null }).at ??
        undefined,
      close: async () => {
        try {
          await db.destroy();
        } finally {
          // Kysely initializes its driver lazily. Host maintenance can use the
          // eager connection without any SDK load/save, so destroy alone may not close it.
          if (sqlite.isOpen) sqlite.close();
        }
      },
    };
  } catch (error) {
    if (sqlite.isOpen) sqlite.close();
    throw error;
  }
}
