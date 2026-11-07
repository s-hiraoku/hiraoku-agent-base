import Database from "better-sqlite3";
import {
  closeSync,
  existsSync,
  lstatSync,
  openSync,
  readFileSync,
} from "node:fs";
import { Kysely, SqliteDialect } from "kysely";
import { DatabaseTaskStore } from "@a2a-js/sdk/server/database";

interface StoredTaskKey {
  tenant: string;
  owner: string;
  id: string;
}

export function openA2aTaskStore(path: string) {
  if (path !== ":memory:") {
    if (!existsSync(path)) closeSync(openSync(path, "wx", 0o600));
    const stat = lstatSync(path);
    if (!stat.isFile() || (stat.mode & 0o077) !== 0)
      throw Error("A2A store requires a private regular file");
  }
  const sqlite = new Database(path);
  try {
    sqlite.pragma("busy_timeout = 5000");
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
    sqlite.pragma("journal_mode = WAL");
    if (!initialized) {
      const schema = readFileSync(
        new URL("./sdk-task-schema.sql", import.meta.url),
        "utf8",
      );
      sqlite.transaction(() => sqlite.exec(schema))();
    }
    const source = "json_extract(metadata,'$.hab_relay.source.message_id')";
    sqlite.exec(
      `CREATE INDEX IF NOT EXISTS hab_a2a_tasks_source ON hab_a2a_tasks(${source})`,
    );
    const bySource = sqlite.prepare(
      `SELECT tenant,owner,id FROM hab_a2a_tasks WHERE ${source}=?`,
    );
    const overdue = sqlite.prepare(
      `SELECT tenant,owner,id FROM hab_a2a_tasks WHERE status_state NOT IN ('TASK_STATE_COMPLETED','TASK_STATE_FAILED','TASK_STATE_CANCELED','TASK_STATE_REJECTED') AND json_extract(metadata,'$.hab_relay.source.expires_at')<=? AND (tenant,owner,id)>(?,?,?) ORDER BY tenant,owner,id LIMIT ?`,
    );
    const nextExpiry = sqlite.prepare(
      `SELECT min(json_extract(metadata,'$.hab_relay.source.expires_at')) at FROM hab_a2a_tasks WHERE status_state NOT IN ('TASK_STATE_COMPLETED','TASK_STATE_FAILED','TASK_STATE_CANCELED','TASK_STATE_REJECTED') AND json_extract(metadata,'$.hab_relay.source.expires_at')>?`,
    );
    const db = new Kysely({ dialect: new SqliteDialect({ database: sqlite }) });
    return {
      store: new DatabaseTaskStore(db, { tableName: "hab_a2a_tasks" }),
      /** The stored Task whose relay request has this message ID, without a caller scope. */
      findBySource: (messageId: string) =>
        bySource.get(messageId) as
          { tenant: string; owner: string; id: string } | undefined,
      /** Bounded stable-key page; a failed apply need not block later overdue Tasks. */
      overdue: (expiredBy: string, limit: number, after?: StoredTaskKey) =>
        overdue.all(
          expiredBy,
          after?.tenant ?? "",
          after?.owner ?? "",
          after?.id ?? "",
          limit,
        ) as StoredTaskKey[],
      /** The earliest relay request expiry after `after` among non-terminal Tasks. */
      nextExpiry: (after: string) =>
        (nextExpiry.get(after) as { at: string | null }).at ?? undefined,
      close: async () => {
        try {
          await db.destroy();
        } finally {
          // Kysely initializes its driver lazily. Host maintenance can use the
          // eager connection without any SDK load/save, so destroy alone may not close it.
          if (sqlite.open) sqlite.close();
        }
      },
    };
  } catch (error) {
    sqlite.close();
    throw error;
  }
}
