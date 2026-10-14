import assert from "node:assert/strict";
import { test, mock } from "node:test";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SQLiteDriver } from "../src/sqlite.ts";

test("real SQLite handles close on discovery, read, and migration constructor failures", () => {
  const directory = fs.mkdtempSync(join(tmpdir(), "hub-sqlite-failure-"));
  const originalClose = DatabaseSync.prototype.close;
  try {
    for (const mode of ["discovery", "read", "migration"]) {
      const path = join(directory, `${mode}.sqlite`);
      if (mode === "migration") {
        const seed = new DatabaseSync(path);
        seed.exec("CREATE TABLE audit(conflict TEXT)");
        seed.close();
      }
      const handles = [];
      let closes = 0;
      mock.method(DatabaseSync.prototype, "close", function () {
        handles.push(this);
        closes++;
        return originalClose.call(this);
      });
      if (mode !== "migration") {
        mock.method(
          fs,
          mode === "discovery" ? "readdirSync" : "readFileSync",
          () => {
            throw Error("dummy migration filesystem failure");
          },
        );
        syncBuiltinESMExports();
      }
      try {
        assert.throws(() => new SQLiteDriver(path));
        assert.equal(closes, 1);
        assert.equal(handles.length, 1);
        assert.throws(() => handles[0].prepare("SELECT 1"));
        // A separately opened real database can acquire a write transaction.
        const reopened = new DatabaseSync(path);
        try {
          reopened.exec("BEGIN IMMEDIATE; ROLLBACK");
        } finally {
          originalClose.call(reopened);
        }
      } finally {
        mock.restoreAll();
        syncBuiltinESMExports();
      }
    }
  } finally {
    mock.restoreAll();
    syncBuiltinESMExports();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
