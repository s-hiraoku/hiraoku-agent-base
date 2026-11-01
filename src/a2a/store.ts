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
    const db = new Kysely({ dialect: new SqliteDialect({ database: sqlite }) });
    return {
      store: new DatabaseTaskStore(db, { tableName: "hab_a2a_tasks" }),
      close: () => db.destroy(),
    };
  } catch (error) {
    sqlite.close();
    throw error;
  }
}
