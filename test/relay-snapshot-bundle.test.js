import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  statSync,
  existsSync,
  chmodSync,
  symlinkSync,
  renameSync,
} from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fixture as habFixture } from "./hab-attachment-fixtures.js";
import { fixture as receiverFixture } from "./relay-receive-checkpoint-fixtures.js";
import { SQLiteSnapshotBundle } from "../src/relay/sqlite-snapshot-bundle.ts";
import { SQLiteRelayStore } from "../src/relay/sqlite-store.ts";
import { SQLiteAttachmentStore } from "../src/relay/sqlite-attachment-store.ts";
import { options as uploadOptions, code } from "./relay-attachment-fixtures.js";
import { HabAttachmentAcceptance } from "../src/hab/attachment-acceptance.ts";
import { limits } from "./relay-http-fixtures.js";
const relayOptions = {
  fingerprint_key: new Uint8Array(32).fill(94),
  max_pending: 10,
  max_records: 100,
  max_pending_per_recipient: 5,
  max_body_bytes: 100000,
  max_clock_skew_ms: 1000,
  lease_ms: 30000,
  max_attempts: 3,
  retry_base_ms: 10,
  retry_cap_ms: 100,
  poll_scan_limit: 10,
};
function fixture(t, extra = {}) {
  const f = habFixture(t, true, true),
    context = Symbol("synthetic-backup-operator"),
    state = { active: true, subject: "fixture-operator", observer: null };
  const snapshotRoot = join(f.dir, "snapshots"),
    restoreRoot = join(f.dir, "restored");
  mkdirSync(snapshotRoot, { mode: 0o700 });
  mkdirSync(restoreRoot, { mode: 0o700 });
  chmodSync(join(f.dir, "attachment-relay.sqlite"), 0o600);
  const options = {
    profile: "server",
    sources: [
      { role: "relay", path: join(f.dir, "attachment-relay.sqlite") },
      { role: "uploads", path: join(f.dir, "attachments.sqlite") },
    ],
    snapshot_root: snapshotRoot,
    restore_root: restoreRoot,
    integrity_key: new Uint8Array(32).fill(107),
    max_database_bytes: 4194304,
    max_total_bytes: 8388608,
    busy_timeout_ms: 10,
    deadline_ms: 5000,
    ...extra,
  };
  const authorization = {
    authorize(ctx, operation) {
      state.observer?.(operation);
      return ctx === context && state.active
        ? { subject_id: state.subject }
        : undefined;
    },
  };
  const stores = new Set();
  const bundle = (changes = {}, auth = authorization) => {
    const b = new SQLiteSnapshotBundle({ ...options, ...changes }, auth);
    stores.add(b);
    return b;
  };
  t.after(() => {
    for (const b of stores) b.close();
  });
  const b = bundle();
  const snapshot = (name) => join(snapshotRoot, name),
    restored = (name) => join(restoreRoot, name);
  return {
    ...f,
    context,
    state,
    options,
    bundle,
    b,
    snapshotRoot,
    restoreRoot,
    snapshot,
    restored,
    send() {
      const m = f.upload();
      f.api().submit(f.contexts.a, m);
      return m;
    },
  };
}
test("snapshot: server pair verifies and restores into new private offline files", async (t) => {
  const f = fixture(t),
    m = f.send();
  const saved = await f.b.create(f.context, "server-one");
  assert.equal(saved.database_count, 2);
  assert.equal((await f.b.verify(f.context, "server-one")).verified, true);
  assert.equal(
    (await f.b.restore(f.context, "server-one", "trial-one")).state,
    "offline",
  );
  const marker = JSON.parse(
    readFileSync(join(f.restored("trial-one"), "restore.json"), "utf8"),
  );
  assert.equal(marker.network_enabled, false);
  assert.equal(marker.requires_reconciliation, true);
  assert.equal(statSync(f.snapshot("server-one")).mode & 0o777, 0o700);
  for (const name of ["relay.sqlite", "uploads.sqlite", "manifest.json"])
    assert.equal(
      statSync(join(f.snapshot("server-one"), name)).mode & 0o777,
      0o600,
    );
  const db = new DatabaseSync(join(f.restored("trial-one"), "relay.sqlite"), {
    readOnly: true,
  });
  try {
    assert.equal(
      db.prepare("SELECT message_id FROM relay_messages").get().message_id,
      m.message_id,
    );
  } finally {
    db.close();
  }
  const manifest = readFileSync(
    join(f.snapshot("server-one"), "manifest.json"),
    "utf8",
  );
  assert.equal(manifest.includes(f.dir), false);
  assert.equal(manifest.includes("Synthetic attachment"), false);
});
test("snapshot: restored pending acceptance reconciles the same receipt against current registry", async (t) => {
  const f = fixture(t),
    m = f.send(),
    accepted = f.api().status(f.contexts.a, m.message_id);
  await f.b.create(f.context, "accepted");
  await f.b.restore(f.context, "accepted", "rehearsal");
  const blobs = new SQLiteAttachmentStore(
    join(f.restored("rehearsal"), "uploads.sqlite"),
    uploadOptions,
  );
  const relay = new SQLiteRelayStore(
    join(f.restored("rehearsal"), "relay.sqlite"),
    relayOptions,
    { check: (a) => blobs.checkPrepared(a, limits) },
  );
  try {
    blobs.migrate();
    relay.migrate();
    const api = new HabAttachmentAcceptance(f.registry, relay, blobs, limits);
    assert.equal(api.submit(f.contexts.a, m).receipt_id, accepted.receipt_id);
    f.change(f.a, "stopped");
    assert.throws(() => api.submit(f.contexts.a, m), code("forbidden"));
  } finally {
    relay.close();
    blobs.close();
  }
});
test("snapshot: every source writer lock is held before copying begins", async (t) => {
  const f = fixture(t);
  f.send();
  let both = 0;
  f.raw.exec("PRAGMA busy_timeout=0");
  f.blobRaw.exec("PRAGMA busy_timeout=0");
  f.state.observer = () => {
    let busy = 0;
    for (const db of [f.raw, f.blobRaw]) {
      try {
        db.exec("BEGIN IMMEDIATE");
        db.exec("ROLLBACK");
      } catch {
        busy++;
      }
    }
    if (busy === 2) both++;
  };
  await f.b.create(f.context, "locked");
  assert.ok(both > 2);
  f.state.observer = null;
  f.raw.exec("BEGIN IMMEDIATE");
  f.raw.exec("ROLLBACK");
});
test("snapshot: busy source releases earlier writer locks and publishes nothing", async (t) => {
  const f = fixture(t);
  f.blobRaw.exec("BEGIN IMMEDIATE");
  try {
    await assert.rejects(
      f.b.create(f.context, "busy"),
      code("snapshot_unavailable"),
    );
  } finally {
    f.blobRaw.exec("ROLLBACK");
  }
  f.raw.exec("BEGIN IMMEDIATE");
  f.raw.exec("ROLLBACK");
  assert.equal(existsSync(f.snapshot("busy")), false);
});
test("snapshot: denial, labels, missing and async authority create no directory", async (t) => {
  const f = fixture(t);
  for (const ctx of [
    "fixture-operator",
    { subject_id: "fixture-operator" },
    f.contexts.a,
  ])
    await assert.rejects(f.b.create(ctx, "denied"), code("forbidden"));
  await assert.rejects(
    f.bundle({}, null).create(f.context, "denied"),
    code("forbidden"),
  );
  await assert.rejects(
    f
      .bundle(
        {},
        { authorize: () => Promise.reject(Error("synthetic private")) },
      )
      .create(f.context, "denied"),
    code("forbidden"),
  );
  assert.equal(existsSync(f.snapshot("denied")), false);
});
test("snapshot: revocation during copy leaves an incomplete artifact and releases locks", async (t) => {
  const f = fixture(t);
  f.send();
  f.state.observer = () => {
    if (existsSync(join(f.snapshot("revoked"), "relay.sqlite")))
      f.state.active = false;
  };
  await assert.rejects(f.b.create(f.context, "revoked"), code("forbidden"));
  f.state.observer = null;
  f.state.active = true;
  assert.equal(existsSync(join(f.snapshot("revoked"), "manifest.json")), false);
  await assert.rejects(f.b.verify(f.context, "revoked"));
  f.raw.exec("BEGIN IMMEDIATE");
  f.raw.exec("ROLLBACK");
});
test("snapshot: substitution of verified subject stops publication", async (t) => {
  const f = fixture(t);
  f.state.observer = () => {
    if (existsSync(f.snapshot("changed"))) f.state.subject = "other-operator";
  };
  await assert.rejects(f.b.create(f.context, "changed"), code("forbidden"));
  assert.equal(existsSync(join(f.snapshot("changed"), "manifest.json")), false);
});
test("snapshot: existing backup and restore directories are never overwritten", async (t) => {
  const f = fixture(t);
  f.send();
  await f.b.create(f.context, "one");
  await assert.rejects(
    f.b.create(f.context, "one"),
    code("snapshot_unavailable"),
  );
  await f.b.restore(f.context, "one", "one");
  await assert.rejects(
    f.b.restore(f.context, "one", "one"),
    code("snapshot_unavailable"),
  );
  assert.equal((await f.b.verify(f.context, "one")).verified, true);
});
test("snapshot: manifest tampering, wrong integrity key and traversal fail before restore output", async (t) => {
  const f = fixture(t);
  await f.b.create(f.context, "one");
  await assert.rejects(
    f
      .bundle({ integrity_key: new Uint8Array(32).fill(9) })
      .restore(f.context, "one", "wrong"),
    code("snapshot_manifest_invalid"),
  );
  await assert.rejects(
    f.b.restore(f.context, "../one", "wrong"),
    code("invalid_snapshot_request"),
  );
  await assert.rejects(
    f.b.restore(f.context, "one", "../wrong"),
    code("invalid_snapshot_request"),
  );
  const path = join(f.snapshot("one"), "manifest.json"),
    data = JSON.parse(readFileSync(path, "utf8"));
  data.files[0].file = "../relay.sqlite";
  writeFileSync(path, JSON.stringify(data));
  await assert.rejects(
    f.b.restore(f.context, "one", "wrong"),
    code("snapshot_manifest_invalid"),
  );
  assert.equal(existsSync(f.restored("wrong")), false);
});
test("snapshot: modified database cannot be verified or restored", async (t) => {
  const f = fixture(t);
  await f.b.create(f.context, "one");
  const db = new DatabaseSync(join(f.snapshot("one"), "relay.sqlite"));
  db.exec("UPDATE relay_maintenance_totals SET last_at=123");
  db.close();
  await assert.rejects(
    f.b.verify(f.context, "one"),
    code("snapshot_integrity_failed"),
  );
  await assert.rejects(
    f.b.restore(f.context, "one", "wrong"),
    code("snapshot_integrity_failed"),
  );
});
test("snapshot: loose permissions and symlinked database source fail closed", async (t) => {
  const f = fixture(t),
    source = f.options.sources[0].path;
  chmodSync(source, 0o644);
  await assert.rejects(
    f.b.create(f.context, "loose"),
    code("snapshot_unavailable"),
  );
  chmodSync(source, 0o600);
  const link = join(f.dir, "linked.sqlite");
  symlinkSync(source, link);
  const sources = [{ role: "relay", path: link }, f.options.sources[1]];
  await assert.rejects(
    f.bundle({ sources }).create(f.context, "link"),
    code("snapshot_unavailable"),
  );
});
test("snapshot: source inode replacement during snapshot prevents a complete manifest", async (t) => {
  const f = fixture(t);
  let replaced = false;
  f.state.observer = () => {
    if (!replaced && existsSync(f.snapshot("replace"))) {
      replaced = true;
      const source = f.options.sources[1].path;
      renameSync(source, source + ".original");
      writeFileSync(source, "synthetic replacement", { mode: 0o600 });
    }
  };
  await assert.rejects(
    f.b.create(f.context, "replace"),
    code("snapshot_unavailable"),
  );
  assert.equal(existsSync(join(f.snapshot("replace"), "manifest.json")), false);
});
test("snapshot: schema mismatch and group completeness refuse implicit migration", async (t) => {
  const f = fixture(t);
  f.raw.exec("UPDATE relay_schema SET version=99");
  await assert.rejects(
    f.b.create(f.context, "unknown"),
    code("snapshot_schema_mismatch"),
  );
  assert.throws(
    () => f.bundle({ sources: f.options.sources.slice(0, 1) }),
    code("invalid_snapshot_options"),
  );
  assert.throws(
    () =>
      f.bundle({
        sources: [
          { role: "registry", path: f.options.sources[0].path },
          f.options.sources[1],
        ],
      }),
    code("invalid_snapshot_options"),
  );
});
test("snapshot: capacity and deadline checks withhold the commit manifest", async (t) => {
  const f = fixture(t);
  f.send();
  await assert.rejects(
    f.bundle({ max_database_bytes: 1 }).create(f.context, "small"),
    code("snapshot_unavailable"),
  );
  const limited = f.bundle({ deadline_ms: 20 });
  let delayed = false;
  f.state.observer = () => {
    if (!delayed && existsSync(f.snapshot("late"))) {
      delayed = true;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30);
    }
  };
  await assert.rejects(
    limited.create(f.context, "late"),
    code("snapshot_deadline"),
  );
  assert.equal(existsSync(join(f.snapshot("late"), "manifest.json")), false);
});
test("snapshot: overlapping operations and close refuse while native backup is pending", async (t) => {
  const f = fixture(t);
  const pending = f.b.create(f.context, "one");
  await assert.rejects(f.b.create(f.context, "two"), code("snapshot_busy"));
  assert.throws(() => f.b.close(), code("snapshot_busy"));
  await pending;
});
test("snapshot: receiver profile retains partial chunk and full delivery for offline continuation", async (t) => {
  const f = await receiverFixture(t);
  const { m } = await f.submitted();
  await f.worker().workOnce();
  await f.worker().workOnce();
  const snapshots = join(f.dir, "snapshots"),
    restores = join(f.dir, "restores");
  mkdirSync(snapshots, { mode: 0o700 });
  mkdirSync(restores, { mode: 0o700 });
  const context = Symbol("fixture-operator");
  const b = new SQLiteSnapshotBundle(
    {
      profile: "receiver",
      owner_id: f.b.agent_id,
      sources: [
        {
          role: "receive_checkpoint",
          path: join(f.dir, "receive-checkpoint.sqlite"),
        },
        { role: "attachment_inbox", path: join(f.dir, "native-files.sqlite") },
        { role: "inbox", path: join(f.dir, "native-body.sqlite") },
      ],
      snapshot_root: snapshots,
      restore_root: restores,
      integrity_key: new Uint8Array(32).fill(108),
      max_database_bytes: 4194304,
      max_total_bytes: 16777216,
      busy_timeout_ms: 10,
      deadline_ms: 5000,
    },
    {
      authorize: (ctx) =>
        ctx === context ? { subject_id: "fixture-operator" } : undefined,
    },
  );
  t.after(() => b.close());
  await b.create(context, "partial");
  await b.restore(context, "partial", "trial");
  const checkpoint = new DatabaseSync(
    join(restores, "trial", "receive_checkpoint.sqlite"),
    { readOnly: true },
  );
  const files = new DatabaseSync(
    join(restores, "trial", "attachment_inbox.sqlite"),
    { readOnly: true },
  );
  try {
    assert.equal(
      JSON.parse(
        checkpoint.prepare("SELECT payload FROM receive_checkpoint").get()
          .payload,
      ).message.message_id,
      m.message_id,
    );
    assert.equal(
      files
        .prepare("SELECT sum(length(data)) n FROM attachment_inbox_chunks")
        .get().n,
      4,
    );
  } finally {
    files.close();
    checkpoint.close();
  }
});
test("snapshot: WAL sources copy committed chunks without copying live sidecars", async (t) => {
  const f = fixture(t);
  f.raw.exec("PRAGMA journal_mode=WAL");
  f.blobRaw.exec("PRAGMA journal_mode=WAL");
  f.send();
  assert.equal(existsSync(f.options.sources[0].path + "-wal"), true);
  await f.b.create(f.context, "wal");
  await f.b.verify(f.context, "wal");
  f.raw.exec("UPDATE relay_maintenance_totals SET last_at=777");
  await f.b.restore(f.context, "wal", "old");
  const db = new DatabaseSync(join(f.restored("old"), "relay.sqlite"), {
    readOnly: true,
  });
  try {
    assert.equal(
      db.prepare("SELECT last_at FROM relay_maintenance_totals").get().last_at,
      0,
    );
  } finally {
    db.close();
  }
});
test("snapshot: revoked restore leaves no completion marker and no runtime side effects", async (t) => {
  const f = fixture(t);
  f.send();
  await f.b.create(f.context, "one");
  f.state.observer = (operation) => {
    if (
      operation === "restore" &&
      existsSync(join(f.restored("partial"), "relay.sqlite"))
    )
      f.state.active = false;
  };
  await assert.rejects(
    f.b.restore(f.context, "one", "partial"),
    code("forbidden"),
  );
  assert.equal(existsSync(join(f.restored("partial"), "restore.json")), false);
  assert.equal(
    f.raw.prepare("SELECT state FROM relay_messages").get().state,
    "pending",
  );
});
test("snapshot: create, verify and restore require their own current operation grant", async (t) => {
  const f = fixture(t);
  let allowed = "create";
  const b = f.bundle(
    {},
    {
      authorize(ctx, operation) {
        return ctx === f.context && operation === allowed
          ? { subject_id: "fixture-operator" }
          : undefined;
      },
    },
  );
  await b.create(f.context, "one");
  await assert.rejects(b.verify(f.context, "one"), code("forbidden"));
  await assert.rejects(b.restore(f.context, "one", "trial"), code("forbidden"));
  allowed = "restore";
  assert.equal((await b.restore(f.context, "one", "trial")).state, "offline");
});
test("snapshot: unsafe profile, hardlink, symlinked destination and extra files are rejected", async (t) => {
  const f = fixture(t);
  for (const profile of ["registry", "__proto__", "toString"])
    assert.throws(
      () => f.bundle({ profile }),
      code("invalid_snapshot_options"),
    );
  const { linkSync } = await import("node:fs");
  const hardlink = join(f.dir, "hardlink.sqlite");
  linkSync(f.options.sources[0].path, hardlink);
  await assert.rejects(
    f.b.create(f.context, "hardlink"),
    code("snapshot_unavailable"),
  );
  const { unlinkSync } = await import("node:fs");
  unlinkSync(hardlink);
  await f.b.create(f.context, "one");
  writeFileSync(join(f.snapshot("one"), "unexpected"), "synthetic", {
    mode: 0o600,
  });
  await assert.rejects(
    f.b.verify(f.context, "one"),
    code("snapshot_manifest_invalid"),
  );
  unlinkSync(join(f.snapshot("one"), "unexpected"));
  const dest = join(f.dir, "restore-link");
  symlinkSync(f.restoreRoot, dest);
  await assert.rejects(
    f.bundle({ restore_root: dest }).restore(f.context, "one", "trial"),
    code("snapshot_unavailable"),
  );
});
test("snapshot: local profile owner mismatch cannot produce a complete artifact", async (t) => {
  const f = await receiverFixture(t),
    snapshots = join(f.dir, "owner-snapshots"),
    restores = join(f.dir, "owner-restores");
  mkdirSync(snapshots, { mode: 0o700 });
  mkdirSync(restores, { mode: 0o700 });
  const b = new SQLiteSnapshotBundle(
    {
      profile: "receiver",
      owner_id: f.a.agent_id,
      sources: [
        {
          role: "receive_checkpoint",
          path: join(f.dir, "receive-checkpoint.sqlite"),
        },
        { role: "attachment_inbox", path: join(f.dir, "native-files.sqlite") },
        { role: "inbox", path: join(f.dir, "native-body.sqlite") },
      ],
      snapshot_root: snapshots,
      restore_root: restores,
      integrity_key: new Uint8Array(32).fill(109),
      max_database_bytes: 4194304,
      max_total_bytes: 16777216,
      busy_timeout_ms: 10,
      deadline_ms: 5000,
    },
    { authorize: () => ({ subject_id: "fixture-operator" }) },
  );
  t.after(() => b.close());
  await assert.rejects(
    b.create(null, "wrong"),
    code("snapshot_schema_mismatch"),
  );
  assert.equal(existsSync(join(snapshots, "wrong", "manifest.json")), false);
});
test("snapshot: sender profile restores finalized source and its exact pending message together", async (t) => {
  const f = await receiverFixture(t),
    v = f.source();
  await f.finish(f.uploadWorker());
  const { SQLiteOutbox } = await import("../src/relay/sqlite-outbox.ts");
  const { SQLiteUploadJournal } =
    await import("../src/relay/sqlite-upload-journal.ts");
  const { journalOptions } = await import("./relay-upload-journal-fixtures.js");
  const m = f.message(f.journal.status(v.request_id).receipt);
  const options = {
    agent_id: f.a.agent_id,
    fingerprint_key: new Uint8Array(32).fill(110),
    limits,
    max_records: 10,
    max_body_bytes: 100000,
    max_clock_skew_ms: 1000,
    lease_ms: 30000,
    retry_base_ms: 1,
    retry_cap_ms: 10,
    max_submit_attempts: 3,
    max_status_attempts: 3,
    status_retry_ms: 86400000,
  };
  const outboxPath = join(f.dir, "sender-outbox.sqlite"),
    outbox = new SQLiteOutbox(outboxPath, options, f.journal);
  t.after(() => outbox.close());
  outbox.migrate();
  outbox.enqueue(m);
  const snapshots = join(f.dir, "sender-snapshots"),
    restores = join(f.dir, "sender-restores");
  mkdirSync(snapshots, { mode: 0o700 });
  mkdirSync(restores, { mode: 0o700 });
  const b = new SQLiteSnapshotBundle(
    {
      profile: "sender",
      owner_id: f.a.agent_id,
      sources: [
        { role: "upload_journal", path: join(f.dir, "worker-source.sqlite") },
        { role: "outbox", path: outboxPath },
      ],
      snapshot_root: snapshots,
      restore_root: restores,
      integrity_key: new Uint8Array(32).fill(111),
      max_database_bytes: 4194304,
      max_total_bytes: 16777216,
      busy_timeout_ms: 10,
      deadline_ms: 5000,
    },
    { authorize: () => ({ subject_id: "fixture-operator" }) },
  );
  t.after(() => b.close());
  await b.create(null, "queued");
  await b.restore(null, "queued", "trial");
  const source = new SQLiteUploadJournal(
    join(restores, "trial", "upload_journal.sqlite"),
    { ...journalOptions, agent_id: f.a.agent_id },
  );
  const pending = new SQLiteOutbox(
    join(restores, "trial", "outbox.sqlite"),
    options,
    source,
  );
  try {
    source.migrate();
    pending.migrate();
    assert.equal(
      source.withFinalized(v.request_id, (r) => r.message_id),
      m.message_id,
    );
    assert.equal(pending.claim().message.message_id, m.message_id);
    assert.equal(
      f.raw.prepare("SELECT count(*) n FROM relay_messages").get().n,
      0,
    );
  } finally {
    pending.close();
    source.close();
  }
});

test("snapshot: a mixed authority or unrelated table cannot enter a delivery-only snapshot", async (t) => {
  const f = fixture(t);
  f.raw.exec(
    "CREATE TABLE hab_registry_meta(id INTEGER,version INTEGER,key_check TEXT,epoch INTEGER)",
  );
  await assert.rejects(
    f.b.create(f.context, "mixed"),
    code("snapshot_schema_mismatch"),
  );
  assert.equal(existsSync(join(f.snapshot("mixed"), "manifest.json")), false);
});
test("snapshot: blob commit before deletion completion restores and reconciles the same fenced job", async (t) => {
  const f = fixture(t);
  f.send();
  const { HabRelayService } = await import("../src/hab/relay.ts");
  const { deletionPolicy } =
    await import("./relay-attachment-deletion-fixtures.js");
  const { randomUUID } = await import("node:crypto");
  const service = new HabRelayService(f.registry, f.relay, limits),
    d = service.poll(f.contexts.b);
  service.ack(f.contexts.b, {
    sender_id: f.a.agent_id,
    message_id: d.message.message_id,
    generation: d.generation,
    lease_token: d.lease_token,
    request_id: randomUUID(),
  });
  const authorize = () => {},
    job = f.relay.claimAttachmentDeletion(authorize, deletionPolicy);
  assert.equal(
    f.relay.withAttachmentDeletion(job, authorize, (g) => f.blob.deleteBound(g))
      .deleted,
    1,
  );
  await f.b.create(f.context, "between-commits");
  await f.b.restore(f.context, "between-commits", "trial");
  const blobs = new SQLiteAttachmentStore(
    join(f.restored("trial"), "uploads.sqlite"),
    uploadOptions,
  );
  const relay = new SQLiteRelayStore(
    join(f.restored("trial"), "relay.sqlite"),
    relayOptions,
  );
  try {
    blobs.migrate();
    relay.migrate();
    assert.equal(
      relay.withAttachmentDeletion(job, authorize, (g) => blobs.deleteBound(g))
        .deleted,
      0,
    );
    relay.completeAttachmentDeletion(job, authorize);
    assert.equal(
      relay.claimAttachmentDeletion(authorize, deletionPolicy),
      null,
    );
  } finally {
    relay.close();
    blobs.close();
  }
});
