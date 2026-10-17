import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { chmodSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { AttachmentAcceptanceService } from "../src/relay/attachment-acceptance.ts";
import { SQLiteRelayStore } from "../src/relay/sqlite-store.ts";
import { RelayService } from "../src/relay/service.ts";
import {
  fixture as uploadFixture,
  intent,
  code,
} from "./relay-attachment-fixtures.js";
import { limits, message } from "./relay-http-fixtures.js";
function fixture(t, patch = {}) {
  const f = uploadFixture(t),
    path = join(f.dir, "relay.sqlite"),
    stores = new Set();
  let blob = f.store;
  const policy = {
    authorize(ctx) {
      const name = ["a", "b"].find((n) => f.contexts[n] === ctx);
      return f.mutable.active && f.mutable.peer && name
        ? { agent_id: name }
        : undefined;
    },
  };
  const open = (admit = true) => {
    const s = new SQLiteRelayStore(
      path,
      {
        fingerprint_key: new Uint8Array(32).fill(93),
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
        ...patch,
      },
      admit ? { check: (a) => blob.checkPrepared(a, limits) } : undefined,
    );
    s.migrate();
    chmodSync(path, 0o600);
    stores.add(s);
    return s;
  };
  const relay = open(),
    raw = new DatabaseSync(path);
  t.after(() => {
    raw.close();
    for (const s of stores) s.close();
  });
  const bindings = (patch = {}) => ({
    ...Object.fromEntries(
      ["prepare", "binding", "confirm", "checkPrepared"].map((k) => [
        k,
        blob[k].bind(blob),
      ]),
    ),
    ...patch,
  });
  const service = (server = relay, refs = blob, auth = policy) =>
    new AttachmentAcceptanceService(server, refs, limits, auth);
  const upload = (ready = true) => {
    const v = intent(),
      r = f.api.begin(f.contexts.a, v);
    f.putAll(r.attachment_id);
    if (ready) f.api.finalize(f.contexts.a, r.attachment_id);
    return {
      version: 1,
      message_id: v.message_id,
      recipient_id: v.recipient_id,
      kind: v.kind,
      thread_id: "acceptance-thread",
      in_reply_to: null,
      first_sent_at: v.first_sent_at,
      expires_at: v.expires_at,
      body: {
        parts: [
          { type: "text", text: "Synthetic attachment caption" },
          {
            type: "attachment",
            attachment_id: r.attachment_id,
            ...v.attachment,
          },
        ],
      },
    };
  };
  return {
    ...f,
    relay,
    raw,
    policy,
    openRelay: open,
    service,
    bindings,
    upload,
    authorize: () => "a",
    countMessages: () =>
      Number(raw.prepare("SELECT count(*) n FROM relay_messages").get().n),
    closeRelay(s) {
      s.close();
      stores.delete(s);
    },
    reopenBlob() {
      f.close(blob);
      blob = f.open();
      blob.migrate();
      return blob;
    },
  };
}
test("attachment acceptance: durable refs precede actual Relay commit and the original receipt confirms them", (t) => {
  const f = fixture(t),
    m = f.upload(),
    r = f.service().submit(f.contexts.a, m);
  assert.equal(r.state, "pending");
  assert.equal(f.countMessages(), 1);
  const b = f.store.binding(m.message_id, f.authorize);
  assert.equal(b.state, "accepted");
  assert.deepEqual(b.receipt, r);
  assert.deepEqual(f.service().submit(f.contexts.a, m), r);
  assert.equal(f.countMessages(), 1);
});
test("attachment acceptance: failure after prepare keeps pins and the same original intent can retry", (t) => {
  const f = fixture(t),
    m = f.upload();
  f.raw.exec(
    "CREATE TRIGGER fail_accept BEFORE INSERT ON relay_messages BEGIN SELECT RAISE(ABORT,'synthetic-private-sql'); END;",
  );
  assert.throws(
    () => f.service().submit(f.contexts.a, m),
    code("attachment_acceptance_failed"),
  );
  assert.equal(f.countMessages(), 0);
  assert.equal(f.store.binding(m.message_id, f.authorize).state, "prepared");
  assert.throws(
    () => f.api.cancel(f.contexts.a, m.body.parts[1].attachment_id),
    code("upload_bound"),
  );
  f.raw.exec("DROP TRIGGER fail_accept");
  assert.equal(f.service().submit(f.contexts.a, m).state, "pending");
});
test("attachment acceptance: failed confirmation recovers the original Relay receipt after both DBs reopen", (t) => {
  const f = fixture(t),
    m = f.upload(),
    broken = f.bindings({
      confirm() {
        throw Error("synthetic private failure");
      },
    });
  assert.throws(
    () => f.service(f.relay, broken).submit(f.contexts.a, m),
    code("attachment_acceptance_failed"),
  );
  const id = f.raw
    .prepare("SELECT receipt_id FROM relay_messages")
    .get().receipt_id;
  assert.equal(f.store.binding(m.message_id, f.authorize).state, "prepared");
  f.closeRelay(f.relay);
  const blob = f.reopenBlob(),
    relay = f.openRelay(),
    r = f.service(relay, blob).submit(f.contexts.a, m);
  assert.equal(r.receipt_id, id);
  assert.equal(f.countMessages(), 1);
  assert.equal(blob.binding(m.message_id, f.authorize).state, "accepted");
});
test("attachment acceptance: lost final response replays without another delivery or an extended deadline", (t) => {
  const f = fixture(t),
    m = f.upload(),
    r = f.service().submit(f.contexts.a, m);
  f.closeRelay(f.relay);
  const blob = f.reopenBlob(),
    relay = f.openRelay();
  assert.deepEqual(f.service(relay, blob).submit(f.contexts.a, m), r);
  assert.equal(f.countMessages(), 1);
  assert.equal(r.expires_at, m.expires_at);
  assert.equal(
    f.raw.prepare("SELECT count(*) n FROM relay_deliveries").get().n,
    1,
  );
});
test("attachment acceptance: incomplete and mismatched files never reach Relay acceptance", (t) => {
  const f = fixture(t),
    m = f.upload(false);
  assert.throws(
    () => f.service().submit(f.contexts.a, m),
    code("attachment_not_finalized"),
  );
  f.api.finalize(f.contexts.a, m.body.parts[1].attachment_id);
  assert.throws(
    () =>
      f
        .service()
        .submit(f.contexts.a, {
          ...m,
          body: { parts: [{ ...m.body.parts[1], filename: "other.bin" }] },
        }),
    code("attachment_reference_mismatch"),
  );
  assert.equal(f.countMessages(), 0);
});
test("attachment acceptance: default backend refuses attachment references even after explicit prepare", (t) => {
  const f = fixture(t),
    m = f.upload(),
    plain = f.openRelay(false);
  assert.throws(
    () => f.service(plain).submit(f.contexts.a, m),
    code("attachment_store_unavailable"),
  );
  assert.equal(f.countMessages(), 0);
  assert.equal(f.store.binding(m.message_id, f.authorize).state, "prepared");
  assert.equal(f.service().submit(f.contexts.a, m).state, "pending");
});
test("attachment acceptance: poll and ACK withhold attached data while ordinary text delivery continues", (t) => {
  const f = fixture(t),
    m = f.upload();
  f.service().submit(f.contexts.a, m);
  const normal = new RelayService(f.relay, limits, f.policy);
  assert.equal(normal.poll(f.contexts.b), null);
  assert.throws(
    () =>
      normal.ack(f.contexts.b, {
        sender_id: "a",
        message_id: m.message_id,
        generation: 1,
        lease_token: "A".repeat(43),
        request_id: "guessed",
      }),
    code("attachment_delivery_unavailable"),
  );
  const text = message("2".repeat(32));
  f.service().submit(f.contexts.a, text);
  const d = normal.poll(f.contexts.b);
  assert.equal(d.message.message_id, text.message_id);
  normal.ack(f.contexts.b, {
    sender_id: "a",
    message_id: text.message_id,
    generation: d.generation,
    lease_token: d.lease_token,
    request_id: "text-ack",
  });
  assert.equal(normal.poll(f.contexts.b), null);
  assert.equal(f.service().status(f.contexts.a, m.message_id).state, "pending");
});
test("attachment acceptance: changed body under an accepted original key conflicts", (t) => {
  const f = fixture(t),
    m = f.upload();
  f.service().submit(f.contexts.a, m);
  assert.throws(
    () =>
      f
        .service()
        .submit(f.contexts.a, {
          ...m,
          body: { parts: [{ type: "text", text: "changed" }, m.body.parts[1]] },
        }),
    code("idempotency_conflict"),
  );
  assert.equal(f.countMessages(), 1);
});
test("attachment acceptance: capacity refusal holds refs for exact retry without replacement", (t) => {
  const f = fixture(t, { max_pending: 1 }),
    text = message("3".repeat(32));
  f.service().submit(f.contexts.a, text);
  const m = f.upload();
  assert.throws(
    () => f.service().submit(f.contexts.a, m),
    code("capacity_exceeded"),
  );
  assert.equal(f.store.binding(m.message_id, f.authorize).state, "prepared");
  const normal = new RelayService(f.relay, limits, f.policy),
    d = normal.poll(f.contexts.b);
  normal.ack(f.contexts.b, {
    sender_id: "a",
    message_id: text.message_id,
    generation: d.generation,
    lease_token: d.lease_token,
    request_id: "free-slot",
  });
  assert.equal(f.service().submit(f.contexts.a, m).state, "pending");
  assert.equal(f.countMessages(), 2);
});
test("attachment acceptance: missing, throwing and async identity cannot create attached acceptance", async (t) => {
  const f = fixture(t),
    m = f.upload();
  for (const auth of [
    undefined,
    {
      authorize() {
        throw Error("private");
      },
    },
    {
      authorize: async () => {
        throw Error("private");
      },
    },
  ]) {
    assert.throws(
      () =>
        new AttachmentAcceptanceService(f.relay, f.store, limits, auth).submit(
          f.contexts.a,
          m,
        ),
      code("forbidden"),
    );
  }
  await new Promise((r) => setTimeout(r, 1));
  assert.equal(f.countMessages(), 0);
});
test("attachment acceptance: ordinary callbacks cannot bypass prepare and async admission fails closed", async (t) => {
  const f = fixture(t),
    m = f.upload();
  assert.throws(
    () => new RelayService(f.relay, limits, f.policy).submit(f.contexts.a, m),
    code("attachment_binding_unavailable"),
  );
  assert.equal(f.countMessages(), 0);
  const s = new SQLiteRelayStore(
    join(f.dir, "async.sqlite"),
    {
      fingerprint_key: new Uint8Array(32).fill(94),
      max_pending: 1,
      max_records: 1,
      max_pending_per_recipient: 1,
      max_body_bytes: 100000,
      max_clock_skew_ms: 1000,
      lease_ms: 1000,
      max_attempts: 1,
      retry_base_ms: 1,
      retry_cap_ms: 1,
      poll_scan_limit: 1,
    },
    {
      check: async () => {
        throw Error("private");
      },
    },
  );
  s.migrate();
  t.after(() => s.close());
  assert.throws(
    () => new RelayService(s, limits, f.policy).submit(f.contexts.a, m),
    code("attachment_binding_unavailable"),
  );
  await new Promise((r) => setTimeout(r, 1));
});
test("attachment acceptance: policy loss after Relay commit keeps pins until current authority confirms", (t) => {
  const f = fixture(t),
    m = f.upload(),
    wrapped = f.bindings({
      confirm(id, r, a) {
        f.mutable.active = false;
        return f.store.confirm(id, r, a);
      },
    });
  assert.throws(
    () => f.service(f.relay, wrapped).submit(f.contexts.a, m),
    code("forbidden"),
  );
  assert.equal(f.countMessages(), 1);
  f.mutable.active = true;
  assert.equal(f.service().submit(f.contexts.a, m).state, "pending");
  assert.equal(f.countMessages(), 1);
});
