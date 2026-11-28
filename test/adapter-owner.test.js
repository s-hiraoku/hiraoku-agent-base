import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import {
  chmodSync,
  mkdtempSync,
  rmSync,
  statSync,
  symlinkSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import process from "node:process";
import { once } from "node:events";
import { DatabaseSync } from "node:sqlite";
import { SQLiteHostOwner } from "../src/agent-sdk/sqlite-host-owner.ts";
import { code } from "./inbox-fixtures.js";

const yes = () => {};

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "hab-owner-test-"));
  const path = join(dir, "owner.sqlite");
  const owners = new Set();
  const options = {
    agent_id: "b",
    fingerprint_key: new Uint8Array(32).fill(82),
  };
  const open = (extra = {}, file = path) => {
    const s = new SQLiteHostOwner(file, { ...options, ...extra });
    owners.add(s);
    return s;
  };
  const owner = open();
  owner.migrate();
  t.after(() => {
    for (const s of owners) s.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return {
    dir,
    owner,
    ownerPath: path,
    ownerOptions: options,
    openOwner: open,
  };
}

test("Host owner: explicit migrate/acquire precede a single attachment", (t) => {
  const f = fixture(t);
  assert.throws(() => f.owner.attach(), code("host_owner_not_held"));
  f.owner.acquire(yes);
  const cap = f.owner.attach();
  cap.check();
  assert.throws(() => f.owner.attach(), code("host_owner_already_attached"));
  cap.release(yes);
  assert.throws(() => cap.check(), code("host_owner_not_held"));
});

test("Host owner: acquire requires current synchronous authorization", (t) => {
  const f = fixture(t);
  assert.throws(() => f.owner.acquire(undefined));
  assert.throws(() => f.owner.acquire(async () => {}));
  assert.throws(() =>
    f.owner.acquire(() => {
      throw Error("denied");
    }),
  );
  f.owner.acquire(yes);
  f.owner.attach().check();
});

test("Host owner: second SQLite connection cannot acquire, migrate or read through an active owner", (t) => {
  const f = fixture(t);
  const other = f.openOwner();
  other.migrate();
  f.owner.acquire(yes);
  assert.throws(() => other.acquire(yes), code("host_owner_busy"));
  assert.throws(() => other.migrate(), code("host_owner_busy"));
  assert.throws(() => f.openOwner(), code("host_owner_busy"));
  f.owner.attach().check();
});

test("Host owner: closing the raw composition resource fences an attached capability", (t) => {
  const f = fixture(t);
  f.owner.acquire(yes);
  const cap = f.owner.attach();
  cap.check();
  f.owner.close();
  assert.throws(() => cap.check(), code("host_owner_not_held"));
});

test("Host owner: file replacement and permission changes fail closed", (t) => {
  const f = fixture(t);
  f.owner.acquire(yes);
  const cap = f.owner.attach();
  chmodSync(f.ownerPath, 0o644);
  assert.throws(() => cap.check(), code("host_owner_lost"));
  chmodSync(f.ownerPath, 0o600);
  assert.throws(() => cap.check(), code("host_owner_not_held"));
});

test("Host owner: replaced inode cannot borrow the old owner's SQLite lock", (t) => {
  const f = fixture(t);
  f.owner.acquire(yes);
  const cap = f.owner.attach();
  renameSync(f.ownerPath, f.ownerPath + ".old");
  writeFileSync(f.ownerPath, "", { mode: 0o600 });
  assert.throws(() => cap.check(), code("host_owner_lost"));
});

test("Host owner: private file, symlink, binding and unknown schema are checked", (t) => {
  const f = fixture(t);
  assert.equal(statSync(f.ownerPath).mode & 0o777, 0o600);
  for (const patch of [
    { agent_id: "c" },
    { fingerprint_key: new Uint8Array(32).fill(1) },
  ]) {
    const s = f.openOwner(patch);
    assert.throws(() => s.migrate(), code("host_owner_binding_mismatch"));
  }
  const link = join(f.dir, "owner-link");
  symlinkSync(f.ownerPath, link);
  assert.throws(() => f.openOwner({}, link), code("host_owner_unavailable"));
  const path = join(f.dir, "unknown.sqlite");
  const db = new DatabaseSync(path);
  db.exec("CREATE TABLE other(id INTEGER)");
  db.close();
  chmodSync(path, 0o600);
  assert.throws(
    () => f.openOwner({}, path).migrate(),
    code("unknown_host_owner_schema"),
  );
  assert.throws(
    () => f.openOwner({ fingerprint_key: new Uint8Array(31) }),
    code("invalid_host_owner_options"),
  );
});

test("Host owner: WAL and memory cannot be used as process-lifetime ownership", (t) => {
  const f = fixture(t);
  const path = join(f.dir, "wal.sqlite");
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode=WAL");
  db.close();
  chmodSync(path, 0o600);
  assert.throws(() => f.openOwner({}, path), code("host_owner_unavailable"));
  assert.throws(
    () => f.openOwner({}, ":memory:"),
    code("invalid_host_owner_options"),
  );
});

test("Host owner: a terminated native process releases only the ephemeral owner lock", async (t) => {
  const f = fixture(t);
  const moduleUrl = new URL(
    "../src/agent-sdk/sqlite-host-owner.ts",
    import.meta.url,
  ).href;
  const source = `
   import { SQLiteHostOwner } from ${JSON.stringify(moduleUrl)};
   const s=new SQLiteHostOwner(process.argv[1],{agent_id:"b",fingerprint_key:new Uint8Array(32).fill(82)});
   s.migrate();s.acquire(()=>{});s.attach().check();process.send("held");
   process.on("message",()=>{});
 `;
  const child = spawn(
    process.execPath,
    ["--input-type=module", "-e", source, f.ownerPath],
    { stdio: ["ignore", "ignore", "pipe", "ipc"] },
  );
  t.after(() => {
    if (child.exitCode === null && !child.killed) child.kill("SIGKILL");
  });
  const [ready] = await once(child, "message");
  assert.equal(ready, "held");
  assert.throws(() => f.owner.acquire(yes), code("host_owner_busy"));
  const exited = once(child, "exit");
  child.kill("SIGKILL");
  await exited;
  f.owner.acquire(yes);
  f.owner.attach().check();
});

test("Host owner: closing a failed same-process competitor does not release the live OS lock", async (t) => {
  const f = fixture(t);
  f.owner.acquire(yes);
  for (let i = 0; i < 3; i++)
    assert.throws(() => f.openOwner(), code("host_owner_busy"));
  const moduleUrl = new URL(
    "../src/agent-sdk/sqlite-host-owner.ts",
    import.meta.url,
  ).href;
  const source = `
   import { SQLiteHostOwner } from ${JSON.stringify(moduleUrl)};
   try { const s=new SQLiteHostOwner(process.argv[1],{agent_id:"b",fingerprint_key:new Uint8Array(32).fill(82)});
     try{s.migrate();s.acquire(()=>{});process.send("unexpected");}finally{s.close();}
   } catch(e){process.send(e.code);}
 `;
  const child = spawn(
    process.execPath,
    ["--input-type=module", "-e", source, f.ownerPath],
    { stdio: ["ignore", "ignore", "pipe", "ipc"] },
  );
  t.after(() => {
    if (child.exitCode === null && !child.killed) child.kill("SIGKILL");
  });
  const [result] = await once(child, "message");
  assert.equal(result, "host_owner_busy");
  await once(child, "exit");
  f.owner.attach().check();
});
