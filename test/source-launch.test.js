import test from "node:test";
import process from "node:process";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync, chmodSync, symlinkSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SQLiteInbox } from "../src/agent-sdk/sqlite-inbox.ts";
import { spawn } from "node:child_process";
import { Worker } from "node:worker_threads";
import { setTimeout, clearTimeout } from "node:timers";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { sourceFixture } from "./source-launch-fixture.js";

function fixture(t, patch = {}) {
  const dir = mkdtempSync(join(tmpdir(), "hab-source-launch-"));
  const f = sourceFixture(dir, patch);
  t.after(() => { f.close(); rmSync(dir, { recursive: true, force: true }); });
  return { ...f, dir };
}
const raw = (t, path) => { const db = new DatabaseSync(path); t.after(() => db.close()); return db; };

test("source launch commits one immutable claim with no body or native/model dispatch", t => {
  const f = fixture(t), source = f.receive();
  assert.equal(f.journal.inspect(f.context, source), null);
  const first = f.journal.claim(f.context, source), second = f.journal.claim(f.context, source);
  assert.equal(first.newly_claimed, true); assert.equal(second.newly_claimed, false);
  assert.deepEqual(first.record, second.record);
  assert.deepEqual(Object.keys(first.record).sort(), ["claimed_at", "launch_id", "source"]);
  assert.equal(Object.isFrozen(first), true); assert.equal(Object.isFrozen(first.record.source), true);
  assert.equal(f.host.status(f.operator).owner, "held"); assert.equal(f.stores.network(), 0);
  assert.equal(statSync(f.path).mode & 0o777, 0o600);
  assert.equal(readFileSync(f.path).includes(Buffer.from("synthetic private payload")), false);
  assert.throws(() => f.stores.owner.attach(), /already_attached/, "journal did not consume or replace host ownership");
});

test("reopen and released inbox body preserve claim and prohibit another launch", t => {
  const f = fixture(t), source = f.receive(), first = f.journal.claim(f.context, source);
  f.journal.close(); f.inbox.releaseBody(source.sender_id, source.message_id);
  const reopened = f.open(); reopened.migrate();
  assert.deepEqual(reopened.inspect(f.context, source), first.record);
  assert.deepEqual(reopened.claim(f.context, source), { newly_claimed: false, record: first.record });
});

test("separate connections converge on the same claim without a second owner", t => {
  const f = fixture(t), other = f.open(), source = f.receive(); other.migrate();
  const a = f.journal.claim(f.context, source), b = other.claim(f.context, source);
  assert.equal(a.newly_claimed, true); assert.equal(b.newly_claimed, false); assert.deepEqual(a.record, b.record);
  assert.equal(f.host.status(f.operator).owner, "held");
});

test("only actual receipt-confirmed question entries can create a claim", t => {
  const f = fixture(t);
  for (const kind of ["notice", "answer", "execution_result"]) {
    assert.throws(() => f.journal.claim(f.context, f.receive({ kind })), /invalid_source_launch_question/);
  }
  assert.throws(() => f.journal.claim(f.context, f.receive({ confirmed: false })), /invalid_source_launch_question/);
  assert.throws(() => f.journal.claim(f.context, { sender_id: "synthetic-peer", message_id: "absent" }));
  assert.equal(raw(t, f.path).prepare("SELECT count(*) n FROM source_launch_claims").get().n, 0);
});

test("current context, approved sender and default-deny policy remain required", t => {
  const f = fixture(t), source = f.receive(), foreign = f.receive({ sender: "other-peer" });
  assert.throws(() => f.journal.claim({}, source), /source_launch_forbidden/);
  assert.throws(() => f.journal.claim(f.context, foreign), /source_launch_forbidden/);
  const denied = f.open({ authorization: undefined }); denied.migrate();
  assert.throws(() => denied.claim(f.context, source), /source_launch_forbidden/);
  assert.throws(() => denied.inspect(f.context, source), /source_launch_forbidden/);
  assert.equal(f.journal.inspect(f.context, source), null);
});

test("actor and authority epoch changing before commit roll back the new claim", t => {
  for (const field of ["actor", "epoch"]) {
    const f = fixture(t), source = f.receive(); let calls = 0;
    f.state.beforeAuthority = () => { if (++calls === 6) f.state[field] = "changed"; };
    assert.throws(() => f.journal.claim(f.context, source), /source_launch_forbidden/);
    f.state.beforeAuthority = null;
    assert.equal(f.journal.inspect(f.context, source), null);
  }
});

test("owner loss before or during claim denies and leaves no second launch permission", t => {
  const f = fixture(t), source = f.receive(); f.state.held = false;
  assert.throws(() => f.journal.claim(f.context, source), /source_launch_forbidden/);
  f.state.held = true; let n = 0;
  f.state.beforeAuthority = () => { if (++n === 6) f.state.held = false; };
  assert.throws(() => f.journal.claim(f.context, source), /source_launch_forbidden/);
  f.state.beforeAuthority = null; f.state.held = true;
  assert.equal(f.journal.inspect(f.context, source), null);
  f.host.releaseOwner(f.operator);
  assert.throws(() => f.journal.claim(f.context, source), /source_launch_forbidden/);
});

test("async policy and asynchronous owner checks fail closed", t => {
  const f = fixture(t), source = f.receive();
  const asyncPolicy = f.open({ authorization: async () => ({ agent_id: f.journal.agentId, actor_id: "actor", authority_epoch: "epoch" }) });
  asyncPolicy.migrate(); assert.throws(() => asyncPolicy.claim(f.context, source), /source_launch_forbidden/);
  const asyncOwner = f.open({ checkOwner: async () => {} });
  assert.throws(() => asyncOwner.migrate(), /source_launch_unavailable/);
});

test("capacity never evicts existing or unknown claims", t => {
  const f = fixture(t, { max_records: 1 }), a = f.receive(), b = f.receive();
  const first = f.journal.claim(f.context, a);
  assert.throws(() => f.journal.claim(f.context, b), /source_launch_capacity_exceeded/);
  assert.equal(f.journal.claim(f.context, a).newly_claimed, false);
  assert.deepEqual(f.journal.inspect(f.context, a), first.record);
});

test("policy/key binding, unmigrated and unknown schema refuse adoption", t => {
  const f = fixture(t), source = f.receive();
  for (const change of [{ policy_id: "different" }, { fingerprint_key: new Uint8Array(32).fill(82) }, { max_records: 21 }]) {
    const other = f.open(change);
    assert.throws(() => other.migrate(), /binding_mismatch/);
    assert.throws(() => other.claim(f.context, source), /not_migrated/);
  }
  const other = f.open({}, join(f.dir, "unmigrated.sqlite"));
  assert.throws(() => other.claim(f.context, source), /not_migrated/);
  const db = raw(t, join(f.dir, "unmigrated.sqlite")); db.exec("CREATE TABLE foreign_data(value TEXT)");
  assert.throws(() => other.migrate(), /unsupported_source_launch_schema/);
});

test("private path mode, symlink and replacement checks fail closed", t => {
  const f = fixture(t), source = f.receive(), link = join(f.dir, "link.sqlite");
  symlinkSync(f.path, link); assert.throws(() => f.open({}, link), /source_launch_unavailable/);
  chmodSync(f.path, 0o644); assert.throws(() => f.journal.claim(f.context, source), /identity_changed/);
  assert.throws(() => f.open(), /source_launch_unavailable/); chmodSync(f.path, 0o600);
});

test("record tampering or removed claim cannot create a second launch", t => {
  for (const action of ["DELETE FROM source_launch_claims", "UPDATE source_launch_claims SET launch_id='forged'"]) {
    const f = fixture(t), source = f.receive(); f.journal.claim(f.context, source);
    raw(t, f.path).exec(action);
    assert.throws(() => f.journal.claim(f.context, source), /integrity_failed/);
  }
});

test("lost commit response poisons instance; reopening reconciles original durable claim", t => {
  const f = fixture(t), source = f.receive(), original = DatabaseSync.prototype.exec; let commits = 0;
  DatabaseSync.prototype.exec = function (sql) {
    const value = Reflect.apply(original, this, [sql]);
    if (sql === "COMMIT" && this.prepare("PRAGMA database_list").get().file === realpathSync(f.path) && ++commits === 2) throw Error("synthetic lost source claim result");
    return value;
  };
  try { assert.throws(() => f.journal.claim(f.context, source), /source_launch_unavailable/); }
  finally { DatabaseSync.prototype.exec = original; }
  assert.throws(() => f.journal.claim(f.context, source), /source_launch_unavailable/);
  f.journal.close(); const reopened = f.open(); reopened.migrate();
  const record = reopened.claim(f.context, source); assert.equal(record.newly_claimed, false);
});

test("failed claim commit rolls back without issuing a launch claim", t => {
  const f = fixture(t), source = f.receive(), original = DatabaseSync.prototype.exec; let commits = 0;
  DatabaseSync.prototype.exec = function (sql) {
    if (sql === "COMMIT" && this.prepare("PRAGMA database_list").get().file === realpathSync(f.path) && ++commits === 2) throw Error("synthetic precommit failure");
    return Reflect.apply(original, this, [sql]);
  };
  try { assert.throws(() => f.journal.claim(f.context, source), /source_launch_unavailable/); }
  finally { DatabaseSync.prototype.exec = original; }
  assert.equal(f.journal.inspect(f.context, source), null);
  assert.equal(f.journal.claim(f.context, source).newly_claimed, true);
});

test("owned child crash after claim and before native create cannot relaunch on restart", async t => {
  const dir = mkdtempSync(join(tmpdir(), "hab-source-launch-crash-"));
  const child = spawn(process.execPath, [fileURLToPath(new URL("./source-launch-child.js", import.meta.url)), dir], { env: {}, stdio: "ignore" });
  let exited = false;
  const timeout = setTimeout(() => { if (!exited) child.kill("SIGKILL"); }, 5000);
  t.after(() => { clearTimeout(timeout); if (exited) rmSync(dir, { recursive: true, force: true }); });
  const [code, signal] = await once(child, "exit"); exited = true; clearTimeout(timeout);
  assert.equal(code, null); assert.equal(signal, "SIGKILL");
  const claim = JSON.parse(readFileSync(join(dir, "claim.json"), "utf8"));
  const f = sourceFixture(dir);
  try { assert.deepEqual(f.journal.claim(f.context, claim.record.source), { ...claim, newly_claimed: false }); }
  finally { f.close(); }
});


test("concurrent native SQLite connections issue one claim under the parent's actual host owner", async t => {
  const f = fixture(t), source = f.receive(), workers = [], ready = [], results = [], exits = [];
  for (let i = 0; i < 2; i++) {
    const gate = new SharedArrayBuffer(4), value = new Int32Array(gate);
    const worker = new Worker(new URL("./source-launch-worker.js", import.meta.url), { workerData: {
      gate, source, inboxPath: join(f.dir, "inbox.sqlite"), journalPath: f.path,
      inboxOptions: { agent_id: f.journal.agentId, fingerprint_key: new Uint8Array(32).fill(79), limits: f.options.limits,
        max_records: 20, max_body_bytes: 100000, retry_base_ms: 1, retry_cap_ms: 10, max_ack_records: 40, ack_retry_ms: 86400000, max_attempts: 3 },
      journalOptions: { agent_id: f.journal.agentId, policy_id: f.options.policy_id, fingerprint_key: f.options.fingerprint_key,
        limits: f.options.limits, max_records: 20 },
    } });
    workers.push(worker);
    let readyResolve, readyReject, resultResolve, resultReject;
    ready.push(new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; }));
    results.push(new Promise((resolve, reject) => { resultResolve = resolve; resultReject = reject; }));
    exits.push(new Promise((resolve, reject) => { worker.once("exit", code => code === 0 ? resolve() : reject(Error("synthetic_worker_failed"))); }));
    for (const pending of [ready.at(-1), results.at(-1), exits.at(-1)]) void pending.catch(() => {});
    worker.on("error", error => { readyReject(error); resultReject(error); });
    worker.on("exit", code => { if (code !== 0) { readyReject(Error("synthetic_worker_failed")); resultReject(Error("synthetic_worker_failed")); } });
    worker.on("message", message => {
      if (message.type === "owner-check") {
        let permitted = -1;
        try { f.options.checkOwner(); permitted = 1; } catch { /* Explicit denial to this owned fixture. */ }
        Atomics.store(value, 0, permitted); Atomics.notify(value, 0);
      } else if (message.type === "ready") readyResolve();
      else if (message.type === "result") resultResolve(message.value);
    });
  }
  const timer = setTimeout(() => { for (const worker of workers) void worker.terminate(); }, 5000);
  try {
    await Promise.all(ready); for (const worker of workers) worker.postMessage({ type: "claim" });
    const claims = await Promise.all(results); await Promise.all(exits);
    assert.equal(claims.filter(c => c.newly_claimed).length, 1);
    assert.equal(claims[0].record.launch_id, claims[1].record.launch_id);
    assert.equal(f.host.status(f.operator).owner, "held");
  } finally { clearTimeout(timer); await Promise.all(workers.map(w => w.terminate())); }
});

test("structured and continuation questions cannot widen the initial text-only launch scope", t => {
  const f = fixture(t);
  for (const patch of [
    { in_reply_to: { sender_id: "synthetic-peer", message_id: "earlier-question" } },
    { body: { parts: [{ type: "data", schema_id: "synthetic-data", schema_version: 1, value: { command: "untrusted instruction" } }] } },
  ]) {
    const source = f.receive({ patch });
    assert.throws(() => f.journal.claim(f.context, source), /invalid_source_launch_question/);
    assert.equal(f.journal.inspect(f.context, source), null);
  }
});

test("signed empty metadata from another same-key policy cannot erase a launch claim", t => {
  const f = fixture(t), source = f.receive(); f.journal.claim(f.context, source);
  const otherPath = join(f.dir, "other-policy.sqlite");
  const other = f.open({ policy_id: "other-approved-policy" }, otherPath); other.migrate();
  const otherRaw = raw(t, otherPath), targetRaw = raw(t, f.path);
  const meta = otherRaw.prepare("SELECT * FROM source_launch_meta").get();
  targetRaw.exec("DELETE FROM source_launch_claims");
  targetRaw.prepare("UPDATE source_launch_meta SET record_count=?,last_at=?,seal=?").run(meta.record_count, meta.last_at, meta.seal);
  assert.throws(() => f.journal.claim(f.context, source), /integrity_failed/);
});

test("same-count signed row substitution fails ordered membership verification", t => {
  const f = fixture(t), first = f.receive(), second = f.receive(), otherPath = join(f.dir, "same-context.sqlite");
  const other = f.open({}, otherPath); other.migrate();
  other.claim(f.context, second); f.journal.claim(f.context, first);
  const db = raw(t, f.path), otherDb = raw(t, otherPath), row = otherDb.prepare("SELECT * FROM source_launch_claims").get();
  // Valid same-context row, older than the target high-water, with unchanged row count.
  db.exec("DELETE FROM source_launch_claims");
  db.prepare("INSERT INTO source_launch_claims VALUES(?,?,?,?,?)").run(row.sender_id, row.message_id, row.launch_id, row.data, row.fingerprint);
  assert.throws(() => f.journal.claim(f.context, first), /integrity_failed/);
});

test("signed metadata from another agent cannot remove a claim under a shared key", t => {
  const f = fixture(t), source = f.receive(); f.journal.claim(f.context, source);
  const inbox = new SQLiteInbox(join(f.dir, "other-agent-inbox.sqlite"), {
    agent_id: "other-agent", fingerprint_key: new Uint8Array(32).fill(79), limits: f.options.limits,
    max_records: 20, max_body_bytes: 100000, max_ack_records: 40, ack_retry_ms: 86400000,
    retry_base_ms: 1, retry_cap_ms: 10, max_attempts: 3,
  });
  inbox.migrate(); t.after(() => inbox.close());
  const otherPath = join(f.dir, "other-agent.sqlite"), other = f.open({ agent_id: "other-agent", inbox }, otherPath);
  // This isolated empty metadata context is never used for a source claim or native action.
  other.migrate();
  const meta = raw(t, otherPath).prepare("SELECT * FROM source_launch_meta").get(), db = raw(t, f.path);
  db.exec("DELETE FROM source_launch_claims");
  db.prepare("UPDATE source_launch_meta SET record_count=?,last_at=?,seal=?").run(meta.record_count, meta.last_at, meta.seal);
  assert.throws(() => f.journal.claim(f.context, source), /integrity_failed/);
});

test("post-migration ignored-write triggers cannot produce undurable launch permissions", t => {
  const f = fixture(t), source = f.receive(), db = raw(t, f.path);
  db.exec("CREATE TRIGGER ignored_claim BEFORE INSERT ON source_launch_claims BEGIN SELECT RAISE(IGNORE); END; CREATE TRIGGER ignored_meta BEFORE UPDATE ON source_launch_meta BEGIN SELECT RAISE(IGNORE); END");
  for (let i = 0; i < 2; i++) assert.throws(() => f.journal.claim(f.context, source), /unsupported_source_launch_schema/);
  assert.equal(db.prepare("SELECT count(*) n FROM source_launch_claims").get().n, 0);
});

test("changed table definition is rejected after initial migration", t => {
  const f = fixture(t), source = f.receive();
  raw(t, f.path).exec("ALTER TABLE source_launch_claims ADD COLUMN unexpected TEXT");
  assert.throws(() => f.journal.claim(f.context, source), /unsupported_source_launch_schema/);
});

test("ignored INSERT or metadata UPDATE is not returned as a committed new claim", t => {
  for (const prefix of ["INSERT INTO source_launch_claims", "UPDATE source_launch_meta"]) {
    const f = fixture(t), source = f.receive(), original = DatabaseSync.prototype.prepare;
    DatabaseSync.prototype.prepare = function (sql) {
      if (sql.startsWith(prefix) && Reflect.apply(original, this, ["PRAGMA database_list"]).get().file === realpathSync(f.path))
        return { run: () => ({ changes: 0, lastInsertRowid: 0 }) };
      return Reflect.apply(original, this, [sql]);
    };
    try { assert.throws(() => f.journal.claim(f.context, source), /source_launch_integrity_failed/); }
    finally { DatabaseSync.prototype.prepare = original; }
    assert.equal(f.journal.inspect(f.context, source), null);
  }
});

test("semantically identical limits order preserves the journal binding", t => {
  const f = fixture(t), source = f.receive(), claim = f.journal.claim(f.context, source);
  const limits = Object.fromEntries(Object.entries(f.options.limits).reverse());
  const other = f.open({ limits }); other.migrate();
  assert.deepEqual(other.claim(f.context, source), { newly_claimed: false, record: claim.record });
});

test("outer inbox commit or response failure retains the already durable launch claim", t => {
  for (const afterCommit of [false, true]) {
    const f = fixture(t), source = f.receive(), original = DatabaseSync.prototype.exec;
    const inboxPath = realpathSync(join(f.dir, "inbox.sqlite")); let injected = false;
    DatabaseSync.prototype.exec = function (sql) {
      if (sql === "COMMIT" && !injected && this.prepare("PRAGMA database_list").get().file === inboxPath) {
        injected = true;
        if (afterCommit) Reflect.apply(original, this, [sql]);
        throw Error("synthetic outer inbox commit response failure");
      }
      return Reflect.apply(original, this, [sql]);
    };
    try { assert.throws(() => f.journal.claim(f.context, source)); }
    finally { DatabaseSync.prototype.exec = original; }
    assert.equal(injected, true);
    assert.equal(f.journal.claim(f.context, source).newly_claimed, false);
  }
});
