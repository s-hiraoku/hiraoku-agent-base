import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { boundedText } from "../src/text-task.ts";

test("accepted non-NUL Unicode scalar text survives the pinned SQLite driver without replacement", () => {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE scalar_text(value TEXT)");
  const insert = db.prepare("INSERT INTO scalar_text VALUES(?)");
  const read = db.prepare("SELECT value FROM scalar_text");
  const remove = db.prepare("DELETE FROM scalar_text");
  let text = "",
    bytes = 0,
    scalars = 0,
    batches = 0;
  const flush = () => {
    if (!text) return;
    assert.equal(boundedText.parse(text), text);
    remove.run();
    insert.run(text);
    assert.equal(read.get().value, text);
    batches++;
    text = "";
    bytes = 0;
  };
  try {
    for (let code = 1; code <= 0x10ffff; code++) {
      if (code >= 0xd800 && code <= 0xdfff) continue;
      const scalar = String.fromCodePoint(code);
      const size = Buffer.byteLength(scalar);
      if (bytes + size > 32768) flush();
      text += scalar;
      bytes += size;
      scalars++;
    }
    flush();
    assert.equal(scalars, 1112063);
    assert.equal(batches, 134);
  } finally {
    db.close();
  }
});
