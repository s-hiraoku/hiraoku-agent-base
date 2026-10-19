import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fixture as habFixture } from "./hab-attachment-fixtures.js";
import {
  fixture as queueFixture,
  options as queueOptions,
  deletionPolicy,
} from "./relay-attachment-deletion-fixtures.js";
import {
  payload,
  options as blobOptions,
  code,
} from "./relay-attachment-fixtures.js";
import { inboxOptions } from "./relay-attachment-inbox-fixtures.js";
import { limits } from "./relay-http-fixtures.js";
import { makeUploadRequestId } from "../src/relay/attachments.ts";
import { SQLiteAttachmentStore } from "../src/relay/sqlite-attachment-store.ts";
import { SQLiteAttachmentInbox } from "../src/relay/sqlite-attachment-inbox.ts";
import { SQLiteInbox } from "../src/relay/sqlite-inbox.ts";
import { SQLiteRelayStore } from "../src/relay/sqlite-store.ts";
import { RelayError, RelayService } from "../src/relay/service.ts";
import { HabRelayService } from "../src/hab/relay.ts";
import { HabAttachmentRead } from "../src/hab/attachment-read.ts";
import { AttachmentStager } from "../src/relay/attachment-stager.ts";
import { AttachmentDeletionWorker } from "../src/relay/attachment-deletion-worker.ts";
function fixture(t) {
  const f = habFixture(t, true, true),
    operator = Symbol("synthetic-maintenance"),
    maintenance = { active: true };
  const authorization = {
    authorize(ctx, op) {
      return ctx === operator && op === "maintenance" && maintenance.active
        ? { agent_id: "synthetic-operator" }
        : undefined;
    },
  };
  const authorize = () => {
    if (!maintenance.active) throw new RelayError("forbidden");
  };
  const service = new HabRelayService(f.registry, f.relay, limits);
  const read = new HabAttachmentRead(f.registry, f.relay, f.blob, limits);
  const send = (patch = {}, many = false) => {
    const m = f.upload(patch);
    if (many) {
      const {
        type: _type,
        attachment_id: _id,
        ...attachment
      } = m.body.parts[1];
      void _type;
      void _id;
      const r = f.uploads.begin(f.contexts.a, {
        version: 1,
        request_id: makeUploadRequestId(m.first_sent_at, "d".repeat(32)),
        message_id: m.message_id,
        recipient_id: m.recipient_id,
        kind: m.kind,
        first_sent_at: m.first_sent_at,
        expires_at: m.expires_at,
        attachment,
      });
      for (let n = 0; n < payload.length; n += 4)
        f.uploads.put(
          f.contexts.a,
          r.attachment_id,
          n,
          payload.subarray(n, n + 4),
        );
      f.uploads.finalize(f.contexts.a, r.attachment_id);
      m.body.parts.push({
        type: "attachment",
        attachment_id: r.attachment_id,
        ...attachment,
      });
    }
    f.api().submit(f.contexts.a, m);
    return m;
  };
  const worker = (
    queue = f.relay,
    blobs = f.blob,
    policy = deletionPolicy,
    auth = authorization,
  ) => new AttachmentDeletionWorker(queue, blobs, policy, auth);
  const queuePort = (patch) => ({
    ...Object.fromEntries(
      [
        "claimAttachmentDeletion",
        "withAttachmentDeletion",
        "completeAttachmentDeletion",
        "failAttachmentDeletion",
      ].map((k) => [k, f.relay[k].bind(f.relay)]),
    ),
    ...patch,
  });
  const ackRequest = (d, id = "synthetic-ack") => ({
    sender_id: d.message.sender_id,
    message_id: d.message.message_id,
    generation: d.generation,
    lease_token: d.lease_token,
    request_id: id,
  });
  const ack = (d, id) => {
    const req = ackRequest(d, id);
    return { req, receipt: service.ack(f.contexts.b, req) };
  };
  const local = () => {
    const options = {
      agent_id: f.b.agent_id,
      fingerprint_key: new Uint8Array(32).fill(99),
      limits,
      max_records: 10,
      max_body_bytes: 100000,
      max_ack_records: 20,
      ack_retry_ms: 86400000,
      retry_base_ms: 1,
      retry_cap_ms: 10,
      max_attempts: 5,
    };
    const files = new SQLiteAttachmentInbox(join(f.dir, "local-files.sqlite"), {
      ...inboxOptions,
      agent_id: f.b.agent_id,
    });
    files.migrate();
    const stores = new Set(),
      open = () => {
        const s = new SQLiteInbox(
          join(f.dir, "local-body.sqlite"),
          options,
          files,
        );
        s.migrate();
        stores.add(s);
        return s;
      },
      body = open(),
      raw = new DatabaseSync(join(f.dir, "local-body.sqlite"));
    t.after(() => {
      raw.close();
      for (const s of stores) s.close();
      files.close();
    });
    const stager = new AttachmentStager(
      files,
      {
        async read(req) {
          return read.read(f.contexts.b, req);
        },
      },
      limits,
    );
    const stage = async (m) => {
      for (let i = 0; i < 10; i++) {
        if ((await stager.stageOnce(f.a.agent_id, m)).state === "verified")
          return;
      }
      assert.fail("finite test staging budget exceeded");
    };
    return {
      files,
      body,
      raw,
      open,
      stage,
      close(s) {
        s.close();
        stores.delete(s);
      },
    };
  };
  return {
    ...f,
    service,
    read,
    send,
    worker,
    queuePort,
    ackRequest,
    ack,
    local,
    operator,
    maintenance,
    authorization,
    authorize,
    chunks: () =>
      Number(
        f.blobRaw.prepare("SELECT count(*) n FROM attachment_chunks").get().n,
      ),
    jobs: () =>
      Number(
        f.raw.prepare("SELECT count(*) n FROM relay_attachment_deletions").get()
          .n,
      ),
    due: () =>
      f.raw.exec("UPDATE relay_attachment_deletions SET next_retry_at=0"),
  };
}
test("attachment delivery: actual HAB lease, durable receiver, ACK and deletion preserve the receiver's exact bytes", async (t) => {
  const f = fixture(t),
    m = f.send(),
    d = f.service.poll(f.contexts.b),
    local = f.local();
  assert.equal(d.message.message_id, m.message_id);
  await local.stage(m);
  local.body.save(d);
  const req = local.body.claimAck(),
    receipt = f.service.ack(f.contexts.b, req);
  local.body.confirmAck(req, receipt);
  assert.deepEqual(f.service.ack(f.contexts.b, req), receipt);
  assert.equal(f.jobs(), 1);
  assert.equal(f.chunks(), 3);
  assert.throws(
    () =>
      f.read.read(f.contexts.b, {
        version: 1,
        sender_id: f.a.agent_id,
        message_id: m.message_id,
        attachment_id: m.body.parts[1].attachment_id,
        offset: 0,
      }),
    code("attachment_read_not_found"),
  );
  assert.equal(f.worker().workOnce(f.operator).state, "done");
  assert.equal(f.chunks(), 0);
  assert.deepEqual(
    local.files.read(
      f.a.agent_id,
      m.message_id,
      m.body.parts[1].attachment_id,
      0,
    ),
    payload.subarray(0, 4),
  );
  assert.equal(
    f.raw.prepare("SELECT body FROM relay_messages").get().body,
    null,
  );
  assert.equal(
    f.blob.binding(m.message_id, () => f.a.agent_id).receipt.state,
    "acked",
  );
});
test("attachment delivery: no explicit delivery port keeps the original attachment refusal", (t) => {
  const f = habFixture(t),
    m = f.upload();
  f.api().submit(f.contexts.a, m);
  assert.equal(
    new HabRelayService(f.registry, f.relay, limits).poll(f.contexts.b),
    null,
  );
  assert.equal(
    f.raw.prepare("SELECT generation FROM relay_deliveries").get().generation,
    0,
  );
});
test("attachment delivery: unconfirmed acceptance is not leased and exact submit reconciliation restores it", (t) => {
  const f = fixture(t),
    m = f.upload();
  assert.throws(
    () =>
      f
        .api(
          f.relay,
          f.bindingPort({
            confirm() {
              throw Error("synthetic-confirm-loss");
            },
          }),
        )
        .submit(f.contexts.a, m),
    code("attachment_acceptance_failed"),
  );
  assert.throws(
    () => f.service.poll(f.contexts.b),
    code("attachment_binding_unavailable"),
  );
  assert.equal(
    f.raw.prepare("SELECT generation FROM relay_deliveries").get().generation,
    0,
  );
  f.api().submit(f.contexts.a, m);
  assert.equal(f.service.poll(f.contexts.b).message.message_id, m.message_id);
});
test("attachment delivery: ACK enqueue failure rolls back receipt, body clearing and job creation", (t) => {
  const f = fixture(t),
    m = f.send(),
    d = f.service.poll(f.contexts.b),
    req = f.ackRequest(d);
  f.raw.exec(
    "CREATE TRIGGER fail_enqueue BEFORE INSERT ON relay_attachment_deletions BEGIN SELECT RAISE(ABORT,'synthetic-enqueue-failure');END;",
  );
  assert.throws(
    () => f.service.ack(f.contexts.b, req),
    code("registry_unavailable"),
  );
  assert.equal(f.jobs(), 0);
  assert.notEqual(
    f.raw.prepare("SELECT body FROM relay_messages").get().body,
    null,
  );
  assert.equal(
    f.raw.prepare("SELECT count(*) n FROM relay_ack_receipts").get().n,
    0,
  );
  assert.equal(
    f.raw.prepare("SELECT state FROM relay_messages").get().state,
    "leased",
  );
  f.raw.exec("DROP TRIGGER fail_enqueue");
  f.service.ack(f.contexts.b, req);
  assert.equal(f.jobs(), 1);
  assert.equal(f.service.status(f.contexts.a, m.message_id).state, "acked");
});
test("attachment delivery: a failure after enqueue rolls back the outbox together with the ACK", (t) => {
  const f = fixture(t);
  f.send();
  const d = f.service.poll(f.contexts.b),
    req = f.ackRequest(d);
  f.raw.exec(
    "CREATE TRIGGER fail_ack_audit BEFORE INSERT ON relay_delivery_audit WHEN NEW.event='acked' BEGIN SELECT RAISE(ABORT,'synthetic-audit-failure');END;",
  );
  assert.throws(
    () => f.service.ack(f.contexts.b, req),
    code("registry_unavailable"),
  );
  assert.equal(f.jobs(), 0);
  assert.equal(f.chunks(), 3);
  f.raw.exec("DROP TRIGGER fail_ack_audit");
  f.service.ack(f.contexts.b, req);
  assert.equal(f.jobs(), 1);
});
test("attachment delivery: a lost ACK response recovers the original local request after server cleanup", async (t) => {
  const f = fixture(t),
    m = f.send(),
    d = f.service.poll(f.contexts.b),
    local = f.local();
  await local.stage(m);
  local.body.save(d);
  const req = local.body.claimAck(),
    original = f.service.ack(f.contexts.b, req);
  f.worker().workOnce(f.operator);
  local.close(local.body);
  const body = local.open();
  local.raw.exec("UPDATE relay_receiver_acks SET next_retry_at=0");
  const retried = body.claimAck();
  assert.deepEqual(retried, req);
  assert.deepEqual(f.service.ack(f.contexts.b, retried), original);
  body.confirmAck(retried, original);
  assert.equal(f.jobs(), 1);
  assert.equal(f.chunks(), 0);
});
test("attachment delivery: stale leases and changed ACK keys never create another deletion", (t) => {
  const f = fixture(t);
  f.send();
  const first = f.service.poll(f.contexts.b);
  f.raw.exec("UPDATE relay_deliveries SET lease_until=0,next_visible_at=0");
  const next = f.service.poll(f.contexts.b);
  assert.equal(next.generation, first.generation + 1);
  assert.throws(
    () => f.service.ack(f.contexts.b, f.ackRequest(first)),
    code("invalid_ack"),
  );
  const { req } = f.ack(next);
  assert.equal(f.jobs(), 1);
  assert.throws(
    () => f.service.ack(f.contexts.b, { ...req, lease_token: "b".repeat(43) }),
    code("ack_idempotency_conflict"),
  );
  assert.throws(
    () => f.service.ack(f.contexts.b, { ...req, request_id: "another-ack" }),
    code("invalid_ack"),
  );
  assert.equal(f.jobs(), 1);
});
test("attachment deletion worker: failed physical deletion retains bytes and retries with a finite backoff", (t) => {
  const f = fixture(t);
  f.send();
  f.ack(f.service.poll(f.contexts.b));
  f.blobRaw.exec(
    "CREATE TRIGGER fail_blob_delete BEFORE DELETE ON attachment_chunks BEGIN SELECT RAISE(ABORT,'synthetic-private-blob-error');END;",
  );
  assert.equal(f.worker().workOnce(f.operator).state, "deferred");
  assert.equal(f.chunks(), 3);
  assert.equal(
    f.raw.prepare("SELECT last_error FROM relay_attachment_deletions").get()
      .last_error,
    "delete_failed",
  );
  f.blobRaw.exec("DROP TRIGGER fail_blob_delete");
  f.due();
  assert.equal(f.worker().workOnce(f.operator).state, "done");
  assert.equal(f.chunks(), 0);
});
test("attachment deletion worker: loss after blob commit retries idempotently through a reopened blob store", (t) => {
  const f = fixture(t);
  f.send();
  f.ack(f.service.poll(f.contexts.b));
  const bad = {
    deleteBound(grant) {
      f.blob.deleteBound(grant);
      throw Error("synthetic-post-commit-loss");
    },
  };
  assert.equal(f.worker(f.relay, bad).workOnce(f.operator).state, "deferred");
  assert.equal(f.chunks(), 0);
  const reopened = new SQLiteAttachmentStore(
    join(f.dir, "attachments.sqlite"),
    blobOptions,
  );
  reopened.migrate();
  t.after(() => reopened.close());
  f.due();
  assert.equal(f.worker(f.relay, reopened).workOnce(f.operator).state, "done");
  assert.equal(f.chunks(), 0);
});
test("attachment deletion worker: loss after completion reports uncertainty without recreating work", (t) => {
  const f = fixture(t);
  f.send();
  f.ack(f.service.poll(f.contexts.b));
  const port = f.queuePort({
    completeAttachmentDeletion(...args) {
      f.relay.completeAttachmentDeletion(...args);
      throw Error("synthetic-completion-response-loss");
    },
  });
  assert.throws(
    () => f.worker(port).workOnce(f.operator),
    code("attachment_deletion_uncertain"),
  );
  assert.equal(
    f.raw.prepare("SELECT state FROM relay_attachment_deletions").get().state,
    "done",
  );
  assert.equal(f.worker().workOnce(f.operator).state, "idle");
  assert.equal(f.jobs(), 1);
  assert.equal(f.chunks(), 0);
});
test("attachment deletion worker: maintenance is separate from individual receive and submit authority", async (t) => {
  const f = fixture(t);
  f.send();
  f.ack(f.service.poll(f.contexts.b));
  for (const auth of [
    undefined,
    {
      authorize() {
        return undefined;
      },
    },
    {
      authorize() {
        return Promise.reject(Error("synthetic-private-async"));
      },
    },
  ])
    assert.throws(
      () =>
        new AttachmentDeletionWorker(
          f.relay,
          f.blob,
          deletionPolicy,
          auth,
        ).workOnce(f.contexts.a),
      code("forbidden"),
    );
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(f.chunks(), 3);
  assert.equal(f.worker().workOnce(f.operator).state, "done");
});
test("attachment deletion worker: authority loss after deletion leaves a fenced uncertain job for reconciliation", (t) => {
  const f = fixture(t);
  f.send();
  f.ack(f.service.poll(f.contexts.b));
  const port = {
    deleteBound(grant) {
      const r = f.blob.deleteBound(grant);
      f.maintenance.active = false;
      return r;
    },
  };
  assert.throws(
    () => f.worker(f.relay, port).workOnce(f.operator),
    code("attachment_deletion_uncertain"),
  );
  assert.equal(f.chunks(), 0);
  f.maintenance.active = true;
  f.raw.exec("UPDATE relay_attachment_deletions SET lease_until=0");
  assert.equal(f.worker().workOnce(f.operator).state, "done");
});
test("attachment deletion worker: a late old worker cannot complete after its lease expires", (t) => {
  const f = fixture(t);
  f.send();
  f.ack(f.service.poll(f.contexts.b));
  const port = {
    deleteBound(grant) {
      const r = f.blob.deleteBound(grant);
      const until = Number(
        f.raw
          .prepare("SELECT lease_until FROM relay_attachment_deletions")
          .get().lease_until,
      );
      Atomics.wait(
        new Int32Array(new SharedArrayBuffer(4)),
        0,
        0,
        Math.max(1, until - Date.now() + 20),
      );
      return r;
    },
  };
  assert.throws(
    () =>
      f
        .worker(f.relay, port, { ...deletionPolicy, lease_ms: 1000 })
        .workOnce(f.operator),
    code("attachment_deletion_uncertain"),
  );
  assert.equal(f.chunks(), 0);
  assert.equal(f.worker().workOnce(f.operator).state, "done");
  assert.equal(
    f.raw.prepare("SELECT generation FROM relay_attachment_deletions").get()
      .generation,
    2,
  );
});
test("attachment deletion worker: a later sibling failure rolls back every owned attachment delete", (t) => {
  const f = fixture(t),
    m = f.send({}, true);
  f.ack(f.service.poll(f.contexts.b));
  const second = m.body.parts[2].attachment_id;
  f.blobRaw.exec(
    "CREATE TRIGGER fail_second_file BEFORE UPDATE ON attachment_uploads WHEN OLD.attachment_id='" +
      second +
      "' BEGIN SELECT RAISE(ABORT,'synthetic-sibling-failure');END;",
  );
  assert.equal(f.worker().workOnce(f.operator).state, "deferred");
  assert.equal(f.chunks(), 6);
  assert.deepEqual(
    f.blobRaw
      .prepare("SELECT state FROM attachment_uploads ORDER BY attachment_id")
      .all()
      .map((r) => r.state),
    ["finalized", "finalized"],
  );
  f.blobRaw.exec("DROP TRIGGER fail_second_file");
  f.due();
  assert.equal(f.worker().workOnce(f.operator).state, "done");
  assert.equal(f.chunks(), 0);
});
test("attachment deletion worker: terminal proof cannot escape and cleanup is idempotent across metadata GC gaps", (t) => {
  const f = fixture(t);
  f.send();
  f.ack(f.service.poll(f.contexts.b));
  const job = f.relay.claimAttachmentDeletion(f.authorize, deletionPolicy);
  let captured;
  f.relay.withAttachmentDeletion(job, f.authorize, (g) => {
    captured = g;
    return f.blob.deleteBound(g);
  });
  assert.throws(
    () => f.blob.deleteBound(captured),
    code("stale_attachment_deletion"),
  );
  f.blobRaw.exec("DELETE FROM attachment_refs;DELETE FROM attachment_bindings");
  assert.equal(
    f.relay.withAttachmentDeletion(job, f.authorize, (g) =>
      f.blob.deleteBound(g),
    ).deleted,
    0,
  );
  f.relay.completeAttachmentDeletion(job, f.authorize);
  assert.equal(f.chunks(), 0);
});
test("attachment deletion worker: original expiry queues and physically removes abandoned finalized bytes", (t) => {
  const f = fixture(t),
    expiry = Date.now() + 1500,
    first = new Date(expiry - 3600000).toISOString();
  const m = f.send({
    first_sent_at: first,
    expires_at: new Date(expiry).toISOString(),
  });
  Atomics.wait(
    new Int32Array(new SharedArrayBuffer(4)),
    0,
    0,
    Math.max(1, expiry - Date.now() + 20),
  );
  f.relay.maintain(f.authorize, 10);
  assert.equal(f.jobs(), 1);
  assert.equal(f.chunks(), 3);
  assert.equal(f.worker().workOnce(f.operator).state, "done");
  assert.equal(f.chunks(), 0);
  assert.equal(f.service.status(f.contexts.a, m.message_id).state, "expired");
});
test("attachment delivery: stop and block still apply to ACK retries while terminal cleanup remains maintenance", (t) => {
  const f = fixture(t);
  f.send();
  const d = f.service.poll(f.contexts.b),
    req = f.ackRequest(d);
  f.block(true, "block-attachment-ack");
  assert.throws(() => f.service.ack(f.contexts.b, req), code("forbidden"));
  assert.equal(f.jobs(), 0);
  f.block(false, "unblock-attachment-ack");
  f.service.ack(f.contexts.b, req);
  f.change(f.b, "stopped");
  assert.throws(() => f.service.ack(f.contexts.b, req), code("forbidden"));
  assert.equal(f.worker().workOnce(f.operator).state, "done");
  assert.equal(f.chunks(), 0);
});
test("attachment delivery: asynchronous delivery admission refuses to issue an attachment lease", async (t) => {
  const f = queueFixture(t),
    m = f.message();
  f.service.submit("a", m);
  const s = new SQLiteRelayStore(
    f.path,
    queueOptions,
    { check() {} },
    {
      limits,
      check() {
        return Promise.reject(Error("synthetic-private-check"));
      },
    },
  );
  s.migrate();
  t.after(() => s.close());
  const service = new RelayService(s, limits, {
    authorize(ctx) {
      return { agent_id: ctx };
    },
  });
  assert.throws(
    () => service.poll("b"),
    code("attachment_delivery_unavailable"),
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(
    f.raw.prepare("SELECT generation FROM relay_deliveries").get().generation,
    0,
  );
});
test("attachment delivery: corrupted source bytes cannot cross the receiver's ACK gate", async (t) => {
  const f = fixture(t),
    m = f.send(),
    d = f.service.poll(f.contexts.b),
    local = f.local();
  f.blobRaw.exec(
    "UPDATE attachment_chunks SET data=zeroblob(4) WHERE offset=0",
  );
  await assert.rejects(local.stage(m), code("attachment_integrity_failed"));
  assert.throws(() => local.body.save(d), code("attachment_inbox_unverified"));
  assert.equal(f.jobs(), 0);
  assert.equal(
    f.raw.prepare("SELECT count(*) n FROM relay_ack_receipts").get().n,
    0,
  );
});
test("attachment deletion worker: another message's file cannot replace the terminal binding", (t) => {
  const f = fixture(t);
  f.send();
  f.ack(f.service.poll(f.contexts.b));
  const expiry = Date.now() + 3600000,
    other = f.send({
      first_sent_at: new Date(expiry - 3600000).toISOString(),
      expires_at: new Date(expiry).toISOString(),
    });
  const port = {
    deleteBound(grant) {
      return f.blob.deleteBound({
        ...grant,
        attachment_ids: [other.body.parts[1].attachment_id],
      });
    },
  };
  assert.equal(f.worker(f.relay, port).workOnce(f.operator).state, "deferred");
  assert.equal(f.chunks(), 6);
});
