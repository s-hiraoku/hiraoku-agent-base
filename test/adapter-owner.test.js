import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import {
  chmodSync,
  statSync,
  symlinkSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { spawn } from "node:child_process";
import process from "node:process";
import { once } from "node:events";
import { DatabaseSync } from "node:sqlite";
import { SQLiteHostOwner } from "../src/adapter-host/sqlite-owner.ts";
import { hostFixture, deferred } from "./adapter-host-fixtures.js";
import { code } from "./task-bridge-fixtures.js";
const yes = () => {};
function fixture(t) {
  const f = hostFixture(t),
    path = join(f.dir, "owner.sqlite"),
    owners = new Set();
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
  });
  return {
    ...f,
    owner,
    ownerPath: path,
    ownerOptions: options,
    openOwner: open,
  };
}
test("Host owner: explicit migrate/acquire precede a single host attachment", (t) => {
  const f = fixture(t);
  assert.throws(() => f.owner.attach(), code("host_owner_not_held"));
  f.owner.acquire(yes);
  const host = f.makeHost({ owner: f.owner });
  assert.equal(host.status(f.context).owner, "held");
  assert.throws(
    () => f.makeHost({ owner: f.owner }),
    code("host_owner_already_attached"),
  );
  assert.equal(host.status(f.context).paused, true);
  host.releaseOwner(f.context);
  assert.equal(host.status(f.context).owner, "lost");
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
  const f = fixture(t),
    other = f.openOwner();
  other.migrate();
  f.owner.acquire(yes);
  assert.throws(() => other.acquire(yes), code("host_owner_busy"));
  assert.throws(() => other.migrate(), code("host_owner_busy"));
  assert.throws(() => f.openOwner(), code("host_owner_busy"));
  f.owner.attach().check();
});
test("Host owner: release requires separate permission, paused control and no active operation", async (t) => {
  const f = fixture(t);
  f.owner.acquire(yes);
  const host = f.makeHost({ owner: f.owner });
  f.resume(host);
  assert.throws(() => host.releaseOwner(f.context), code("host_must_pause"));
  f.state.denied.add("release_owner");
  assert.throws(() => host.releaseOwner(f.context), code("host_forbidden"));
  f.state.denied.delete("release_owner");
  const wait = deferred();
  f.state.credential = () => wait.promise;
  const work = host.stepOnce(f.context, { op: "receive" });
  f.pause(host);
  assert.throws(() => host.releaseOwner(f.context), code("host_busy"));
  wait.resolve("Bearer fixture-b");
  await work;
  host.releaseOwner(f.context);
  await assert.rejects(
    host.stepOnce(f.context, { op: "inbox" }),
    code("host_owner_not_held"),
  );
});
test("Host owner: timeout keeps ownership until underlying credential work settles", async (t) => {
  const f = fixture(t);
  f.owner.acquire(yes);
  f.state.timeout_ms = 20;
  const wait = deferred();
  f.state.credential = () => wait.promise;
  const host = f.makeHost({ owner: f.owner });
  f.resume(host);
  assert.equal(
    (await host.stepOnce(f.context, { op: "receive" })).state,
    "incomplete",
  );
  f.pause(host);
  assert.throws(() => host.releaseOwner(f.context), code("host_busy"));
  assert.throws(() => f.openOwner(), code("host_owner_busy"));
  wait.resolve("Bearer fixture-b");
  await new Promise((r) => setTimeout(r, 20));
  host.releaseOwner(f.context);
  const next = f.openOwner();
  next.migrate();
  next.acquire(yes);
});
test("Host owner: closing the raw composition resource fences an already created host", async (t) => {
  const f = fixture(t);
  f.owner.acquire(yes);
  const host = f.makeHost({ owner: f.owner });
  f.resume(host);
  f.owner.close();
  await assert.rejects(
    host.stepOnce(f.context, { op: "receive" }),
    code("host_owner_not_held"),
  );
  assert.equal(f.state.tools.length, 0);
  // Administrative stop remains available after owner loss.
  f.pause(host);
  assert.equal(host.status(f.context).paused, true);
});
test("Host owner: lost owner after an RPC cannot save or ACK late data", async (t) => {
  const f = fixture(t);
  f.owner.acquire(yes);
  const host = f.makeHost({ owner: f.owner });
  f.resume(host);
  f.submit();
  f.state.afterNetwork = async () => {
    f.owner.close();
  };
  const result = await host.stepOnce(f.context, { op: "receive" });
  assert.equal(result.reason, "host_owner_not_held");
  assert.equal(f.inbox.inbox().length, 0);
  assert.deepEqual(f.state.tools, ["relay_poll"]);
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
  const path = join(f.dir, "unknown.sqlite"),
    db = new DatabaseSync(path);
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
  const f = fixture(t),
    path = join(f.dir, "wal.sqlite"),
    db = new DatabaseSync(path);
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
    "../src/adapter-host/sqlite-owner.ts",
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
  const host = f.makeHost({ owner: f.owner });
  assert.equal(host.status(f.context).paused, true);
  assert.equal(f.queued().length, 0);
  assert.equal(f.count(), 0);
});
test("Host owner: closing a failed same-process competitor does not release the live OS lock", async (t) => {
  const f = fixture(t);
  f.owner.acquire(yes);
  for (let i = 0; i < 3; i++)
    assert.throws(() => f.openOwner(), code("host_owner_busy"));
  const moduleUrl = new URL(
    "../src/adapter-host/sqlite-owner.ts",
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
