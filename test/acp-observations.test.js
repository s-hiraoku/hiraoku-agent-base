import test from "node:test";
import assert from "node:assert/strict";
import process from "node:process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

test("ACP fixture publishes complete observations while the next snapshot is partially written", t => {
  const cwd = mkdtempSync(join(tmpdir(), "hab-synthetic-acp-observations-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  writeFileSync(join(cwd, "synthetic-observations.json"), JSON.stringify({ events: [] }));
  const child = new URL("./acp-owner-child.js", import.meta.url).href;
  const result = spawnSync(process.execPath, ["--input-type=module", "--eval", `
    import fs from "node:fs";
    import assert from "node:assert/strict";
    import { syncBuiltinESMExports } from "node:module";
    const original = fs.writeFileSync;
    let writes = 0;
    fs.writeFileSync = (path, data, options) => {
      const previous = fs.readFileSync("synthetic-observations.json", "utf8");
      original(path, data.slice(0, Math.floor(data.length / 2)), options);
      assert.equal(fs.readFileSync("synthetic-observations.json", "utf8"), previous);
      assert.ok(Array.isArray(JSON.parse(previous).events));
      original(path, data, options);
      writes++;
    };
    syncBuiltinESMExports();
    process.argv[2] = "normal";
    await import(${JSON.stringify(child)});
    process.on("exit", () => assert.equal(writes, 3));
  `], {
    cwd, encoding: "utf8", timeout: 10000,
    input: [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } } },
      { jsonrpc: "2.0", id: 2, method: "session/new", params: { cwd, mcpServers: [{
        type: "http", url: "http://127.0.0.1:1/mcp", headers: [{ name: "Authorization", value: "synthetic" }],
      }] } },
    ].map(message => JSON.stringify(message) + "\n").join(""),
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(readFileSync(join(cwd, "synthetic-observations.json"))).events,
    ["initialize", "session/new"]);
});
