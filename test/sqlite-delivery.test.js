import assert from "node:assert/strict";
import { test } from "node:test";
import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SqliteDelivery } from "../src/delivery/sqlite-delivery.ts";
import {
  MAX_ACK_RETRY_MS,
  RECORD_RETENTION_MS,
  READ_BODY_RETENTION_MS,
} from "../src/messaging/contract.ts";
import { limits, message } from "./mcp-http-fixtures.js";
import { authorizedDelivery } from "./delivery-fixture.js";

// Delivery semantics of the SQLite store on its own (ADR-018): admission, one lease per
// recipient, retries, quarantine, expiry, ACK idempotency, capacity, fair poll and retention.
const agents = ["a", "b", "c", "d"];
async function fixture(t, { queue = {}, deny = () => false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "sqlite-delivery-"));
  chmodSync(dir, 0o700);
  const authorization = {
    authorize(context, operation, peer, kind) {
      if (context === "ops")
        return operation === "maintenance" ? { agent_id: "ops" } : undefined;
      if (!agents.includes(context) || operation === "maintenance")
        return undefined;
      return deny(context, operation, peer, kind)
        ? undefined
        : { agent_id: context };
    },
  };
  const delivery = await authorizedDelivery(t, {
    authorization,
    limits,
    directory: dir,
    queue: {
      max_attempts: 2,
      retry_base_ms: 1,
      retry_cap_ms: 1,
      lease_ms: 1000,
      ...queue,
    },
  });
  const raw = new DatabaseSync(delivery.options.path);
  t.after(() => {
    raw.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const second = [];
  t.after(() => second.forEach((store) => store.close()));
  return {
    dir,
    raw,
    authorization,
    options: delivery.options,
    service: delivery.service,
    get backend() {
      return delivery.backend;
    },
    reopen: () => delivery.reopen(),
    /** A second process-style handle on the same file. */
    other() {
      const store = SqliteDelivery.open(delivery.options);
      second.push(store);
      return store;
    },
    row: (id) =>
      raw.prepare("SELECT * FROM delivery_messages WHERE message_id=?").get(id),
    audit: (id) =>
      raw
        .prepare(
          "SELECT event FROM delivery_audit WHERE message_id=? ORDER BY id",
        )
        .all(id)
        .map((row) => row.event),
  };
}
let entropy = 0;
const next = (patch = {}) => ({
  ...message((++entropy).toString(16).padStart(32, "0")),
  ...patch,
});
const ack = (delivery, request_id = "ack-" + delivery.generation) => ({
  sender_id: delivery.message.sender_id,
  message_id: delivery.message.message_id,
  generation: delivery.generation,
  lease_token: delivery.lease_token,
  request_id,
});
const expireLeases = (f) =>
  f.raw.exec("UPDATE delivery_messages SET lease_until=0,next_visible_at=0");

test("accepted message is pollable at once, the ACK releases its body and a retried ACK returns the same receipt", async (t) => {
  const f = await fixture(t);
  const input = next();
  const receipt = f.service.submit("a", input);
  assert.equal(receipt.state, "pending");
  assert.ok(f.row(input.message_id).body.includes("synthetic private payload"));
  const delivery = f.service.poll("b");
  assert.deepEqual(delivery.message, { ...input, sender_id: "a" });
  assert.equal(delivery.generation, 1);
  const confirmed = f.service.ack("b", ack(delivery));
  assert.equal(confirmed.state, "acked");
  assert.deepEqual(f.service.ack("b", ack(delivery)), confirmed);
  assert.throws(() => f.service.ack("b", { ...ack(delivery), generation: 2 }), {
    code: "ack_idempotency_conflict",
  });
  assert.equal(f.service.status("a", input.message_id).state, "acked");
  const row = f.row(input.message_id);
  assert.deepEqual([row.body, row.body_bytes, row.token_hash], [null, 0, null]);
  assert.deepEqual(f.audit(input.message_id), ["accepted", "leased", "acked"]);
});

test("duplicate admission returns the original receipt and changed content is refused", async (t) => {
  const f = await fixture(t);
  const input = next();
  const receipt = f.service.submit("a", input);
  assert.deepEqual(f.service.submit("a", structuredClone(input)), receipt);
  assert.throws(
    () =>
      f.service.submit("a", {
        ...input,
        body: { parts: [{ type: "text", text: "changed" }] },
      }),
    { code: "idempotency_conflict" },
  );
  assert.equal(
    f.raw.prepare("SELECT count(*) n FROM delivery_messages").get().n,
    1,
  );
});

test("two handles on one file lease a recipient's message only once", async (t) => {
  const f = await fixture(t);
  f.service.submit("a", next());
  f.service.submit("c", next());
  const other = f.other();
  const first = f.service.poll("b");
  assert.ok(first);
  assert.equal(other.pollWithAuthorization("b", f.authorization), null);
  assert.equal(f.service.poll("b"), null);
  f.service.ack("b", ack(first));
  assert.ok(other.pollWithAuthorization("b", f.authorization));
});

test("lapsed lease is redelivered with a new generation, a stale ACK fails, and attempts end in quarantine", async (t) => {
  const f = await fixture(t);
  const input = next();
  f.service.submit("a", input);
  const first = f.service.poll("b");
  expireLeases(f);
  const second = f.service.poll("b");
  assert.equal(second.generation, 2);
  assert.notEqual(second.lease_token, first.lease_token);
  assert.throws(() => f.service.ack("b", ack(first)), { code: "invalid_ack" });
  expireLeases(f);
  assert.equal(f.service.poll("b"), null);
  assert.equal(f.service.status("a", input.message_id).state, "quarantined");
  assert.deepEqual(f.backend.diagnostics("ops"), {
    pending: 0,
    quarantined: 1,
  });
  assert.deepEqual(f.audit(input.message_id), [
    "accepted",
    "leased",
    "requeued",
    "leased",
    "quarantined",
  ]);
});

test("redelivery waits for the retry backoff", async (t) => {
  const f = await fixture(t, {
    queue: { retry_base_ms: 60000, retry_cap_ms: 60000 },
  });
  f.service.submit("a", next());
  f.service.poll("b");
  f.raw.exec("UPDATE delivery_messages SET lease_until=0");
  assert.equal(f.service.poll("b"), null);
  f.raw.exec("UPDATE delivery_messages SET next_visible_at=0");
  assert.equal(f.service.poll("b").generation, 2);
});

test("absolute expiry frees the body, refuses ACK and never resurrects through a duplicate", async (t) => {
  const f = await fixture(t);
  const at = Date.now();
  t.mock.timers.enable({ apis: ["Date"], now: at });
  const input = next();
  f.service.submit("a", input);
  const delivery = f.service.poll("b");
  t.mock.timers.setTime(Date.parse(input.expires_at));
  assert.throws(() => f.service.ack("b", ack(delivery)), {
    code: "invalid_ack",
  });
  assert.equal(f.service.status("a", input.message_id).state, "expired");
  const row = f.row(input.message_id);
  assert.deepEqual([row.body, row.body_bytes], [null, 0]);
  assert.equal(row.retain_until, row.expires_at + RECORD_RETENTION_MS);
  assert.equal(f.service.submit("a", input).state, "expired");
  assert.equal(f.service.poll("b"), null);
});

test("capacity refuses new work without evicting accepted work; an exact retry needs no capacity", async (t) => {
  const f = await fixture(t, { queue: { max_pending_per_recipient: 2 } });
  const kept = [next(), next()];
  const receipts = kept.map((input) => f.service.submit("a", input));
  assert.throws(() => f.service.submit("c", next()), {
    code: "capacity_exceeded",
  });
  assert.deepEqual(f.service.submit("a", kept[0]), receipts[0]);
  assert.equal(
    f.service.submit("a", next({ recipient_id: "d" })).state,
    "pending",
  );
  for (const input of kept)
    assert.equal(f.service.status("a", input.message_id).state, "pending");
});

test("a sender's retained records stay within its own budget", async (t) => {
  const f = await fixture(t, {
    queue: {
      agent_capacity: {
        max_pending_per_sender: 2,
        max_body_bytes_per_sender: 50000,
        max_records_per_sender: 2,
        max_body_bytes_per_recipient: 50000,
        max_records_per_recipient: 50,
        reservations: [],
      },
    },
  });
  for (let n = 0; n < 2; n++) {
    f.service.submit("a", next());
    f.service.ack("b", ack(f.service.poll("b"), "budget-" + n));
  }
  // ACKed records still count until retention collects them.
  assert.throws(() => f.service.submit("a", next()), {
    code: "capacity_exceeded",
  });
  assert.equal(f.service.submit("c", next()).state, "pending");
});

test("identities cannot read another sender's status, poll another mailbox or ACK for another recipient", async (t) => {
  const f = await fixture(t);
  const input = next();
  f.service.submit("a", input);
  assert.throws(() => f.service.status("c", input.message_id), {
    code: "not_found",
  });
  assert.equal(f.service.poll("c"), null);
  const delivery = f.service.poll("b");
  assert.throws(() => f.service.ack("c", ack(delivery)), {
    code: "invalid_ack",
  });
  assert.throws(
    () => f.service.ack("b", { ...ack(delivery), lease_token: "x".repeat(43) }),
    { code: "invalid_ack" },
  );
  assert.throws(() => f.service.submit("unknown", next()), {
    code: "forbidden",
  });
  assert.throws(() => f.service.poll("ops"), { code: "forbidden" });
  assert.throws(() => f.backend.maintain("a"), { code: "forbidden" });
});

test("a denied sender is skipped at poll without spending its attempt", async (t) => {
  let blocked = true;
  const f = await fixture(t, {
    deny: (context, operation, peer) =>
      blocked && operation === "poll" && peer === "a",
  });
  const held = next();
  f.service.submit("a", held);
  const later = next();
  f.service.submit("c", later);
  const delivery = f.service.poll("b");
  assert.equal(delivery.message.message_id, later.message_id);
  f.service.ack("b", ack(delivery));
  assert.equal(f.service.poll("b"), null);
  assert.equal(f.row(held.message_id).generation, 0);
  blocked = false;
  assert.equal(f.service.poll("b").message.message_id, held.message_id);
});

test("fair poll alternates senders despite one sender's older backlog", async (t) => {
  const f = await fixture(t, { queue: { fair_poll: true } });
  for (let n = 0; n < 3; n++) f.service.submit("a", next());
  f.service.submit("c", next());
  const senders = [];
  for (let n = 0; n < 4; n++) {
    const delivery = f.service.poll("b");
    senders.push(delivery.message.sender_id);
    f.service.ack("b", ack(delivery, "fair-" + n));
  }
  assert.deepEqual(senders, ["a", "c", "a", "a"]);
});

test("replies stay inside their agent pair and thread", async (t) => {
  const f = await fixture(t);
  const question = next();
  f.service.submit("a", question);
  const reference = { sender_id: "a", message_id: question.message_id };
  const reply = (patch) =>
    next({
      recipient_id: "a",
      kind: "answer",
      in_reply_to: reference,
      ...patch,
    });
  assert.equal(f.service.submit("b", reply()).state, "pending");
  assert.throws(() => f.service.submit("c", reply()), {
    code: "invalid_reference",
  });
  assert.throws(() => f.service.submit("b", reply({ thread_id: "other" })), {
    code: "invalid_reference",
  });
  assert.throws(() => f.service.submit("b", reply({ recipient_id: "c" })), {
    code: "invalid_reference",
  });
});

test("accepted messages and saved ACK receipts survive a reopen", async (t) => {
  const f = await fixture(t);
  const pending = next();
  f.service.submit("a", pending);
  const acked = next({ recipient_id: "c" });
  f.service.submit("a", acked);
  const delivery = f.service.poll("c");
  const receipt = f.service.ack("c", ack(delivery));
  await f.reopen();
  assert.deepEqual(f.service.ack("c", ack(delivery)), receipt);
  assert.equal(f.service.poll("b").message.message_id, pending.message_id);
});

test("maintenance keeps ACKed records through the ACK retry horizon and retention, then purges within its limit", async (t) => {
  const f = await fixture(t);
  const at = Date.now();
  t.mock.timers.enable({ apis: ["Date"], now: at });
  const ids = [];
  for (let n = 0; n < 3; n++) {
    const input = next();
    ids.push(input.message_id);
    f.service.submit("a", input);
    f.service.ack("b", ack(f.service.poll("b"), "keep-" + n));
  }
  t.mock.timers.setTime(at + MAX_ACK_RETRY_MS + RECORD_RETENTION_MS - 1);
  assert.deepEqual(f.backend.maintain("ops", 2), { purged: 0, safety_held: 0 });
  t.mock.timers.setTime(at + MAX_ACK_RETRY_MS + RECORD_RETENTION_MS + 1);
  assert.deepEqual(f.backend.maintain("ops", 2), { purged: 2, safety_held: 0 });
  assert.deepEqual(f.backend.maintain("ops", 2), { purged: 1, safety_held: 0 });
  for (const id of ids) assert.deepEqual(f.audit(id), []);
  const totals = f.raw
    .prepare("SELECT purged FROM delivery_maintenance_totals")
    .get();
  assert.equal(totals.purged, 3);
});

test("records whose IDs are not replay-bound are held instead of collected", async (t) => {
  const f = await fixture(t);
  const at = Date.now();
  t.mock.timers.enable({ apis: ["Date"], now: at });
  const legacy = next({ message_id: "legacy-id" });
  f.service.submit("a", legacy);
  const bound = next();
  f.service.submit("a", bound);
  t.mock.timers.setTime(
    Date.parse(legacy.expires_at) + RECORD_RETENTION_MS + 1,
  );
  assert.deepEqual(f.backend.maintain("ops", 1), { purged: 1, safety_held: 1 });
  assert.equal(f.row(bound.message_id), undefined);
  assert.equal(f.row("legacy-id").state, "expired");
  // A collected replay-bound ID has expired, so it cannot be admitted again.
  assert.throws(() => f.service.submit("a", bound), {
    code: "expired_before_acceptance",
  });
});

test("open refuses a foreign database, another key, an unsafe file mode and a memory database", async (t) => {
  const f = await fixture(t);
  assert.throws(
    () =>
      SqliteDelivery.open({
        ...f.options,
        fingerprint_key: new Uint8Array(32).fill(1),
      }),
    { code: "journal_key_or_version_mismatch" },
  );
  const foreign = join(f.dir, "foreign.sqlite");
  const db = new DatabaseSync(foreign);
  db.exec("CREATE TABLE nats_messages(x)");
  db.close();
  chmodSync(foreign, 0o600);
  assert.throws(() => SqliteDelivery.open({ ...f.options, path: foreign }), {
    code: "unknown_journal_schema",
  });
  chmodSync(foreign, 0o644);
  assert.throws(() => SqliteDelivery.open({ ...f.options, path: foreign }), {
    code: "insecure_journal_file",
  });
  assert.throws(() => SqliteDelivery.open({ ...f.options, path: ":memory:" }), {
    code: "durable_journal_required",
  });
});

test("a changed stored body fails integrity before it is leased", async (t) => {
  const f = await fixture(t);
  const input = next();
  f.service.submit("a", input);
  f.raw
    .prepare(
      "UPDATE delivery_messages SET body=replace(body,'synthetic','tampered')",
    )
    .run();
  assert.throws(() => f.service.poll("b"), {
    code: "journal_integrity_failed",
  });
  assert.equal(f.row(input.message_id).state, "pending");
});

test("a failed audit write rolls back the state change with it", async (t) => {
  const f = await fixture(t);
  f.raw.exec(
    "CREATE TRIGGER fail_audit BEFORE INSERT ON delivery_audit BEGIN SELECT RAISE(ABORT,'audit'); END",
  );
  const input = next();
  assert.throws(() => f.service.submit("a", input));
  assert.equal(f.row(input.message_id), undefined);
  f.raw.exec("DROP TRIGGER fail_audit");
  assert.equal(f.service.submit("a", input).state, "pending");
});

// Host inbox (ADR-020 mailbox): reading marks a message read, keeps its body for
// READ_BODY_RETENTION_MS and releases it after that; SDK ACKs still release at once.
test("inbox read marks messages read once, keeps them re-readable and releases the body after the retention", async (t) => {
  const f = await fixture(t);
  const first = next();
  const second = next({
    body: {
      parts: [
        { type: "text", text: "line one" },
        { type: "data", schema_id: "s.v1", schema_version: 1, value: { n: 1 } },
        { type: "text", text: "line two" },
      ],
    },
  });
  f.service.submit("a", first);
  f.service.submit("c", { ...second, thread_id: "thread-cb" });
  assert.deepEqual(f.service.inbox("a"), []);
  const read = f.service.inbox("b");
  assert.deepEqual(
    read.map((m) => [m.message_id, m.sender_id, m.text, m.data_parts, m.new]),
    [
      [first.message_id, "a", "synthetic private payload", 0, true],
      [second.message_id, "c", "line one\n\nline two", 1, true],
    ],
  );
  assert.equal(read[1].thread_id, "thread-cb");
  assert.equal(f.service.status("a", first.message_id).state, "acked");
  assert.deepEqual(f.service.inbox("b"), []);
  assert.equal(f.service.poll("b"), null);
  // Reads at the same millisecond are not repeated; move the read time back.
  f.raw.exec("UPDATE delivery_messages SET acked_at=acked_at-10");
  const again = f.service.inbox("b", { limit: 10, include_read: true });
  assert.deepEqual(
    again.map((m) => [m.message_id, m.new]).sort(),
    [
      [first.message_id, false],
      [second.message_id, false],
    ].sort(),
  );
  // A kept body stays charged to the byte quotas until it is released.
  assert.ok(f.row(first.message_id).body_bytes > 0);
  f.raw
    .prepare("UPDATE delivery_messages SET acked_at=? WHERE message_id=?")
    .run(Date.now() - READ_BODY_RETENTION_MS - 1, first.message_id);
  assert.deepEqual(
    f.service
      .inbox("b", { limit: 10, include_read: true })
      .map((m) => m.message_id),
    [second.message_id],
  );
  assert.deepEqual(
    [f.row(first.message_id).body, f.row(first.message_id).body_bytes],
    [null, 0],
  );
  assert.deepEqual(f.audit(first.message_id), ["accepted", "acked"]);
});

test("inbox respects the limit, skips leased and disallowed messages and refuses a bad limit", async (t) => {
  let blockC = false;
  const f = await fixture(t, {
    deny: (context, operation, peer) =>
      blockC && operation === "poll" && peer === "c",
  });
  const a1 = next();
  const a2 = next();
  const c1 = next();
  f.service.submit("a", a1);
  f.service.submit("a", a2);
  f.service.submit("c", { ...c1, thread_id: "thread-cb" });
  const leased = f.service.poll("b");
  assert.equal(leased.message.message_id, a1.message_id);
  blockC = true;
  assert.deepEqual(
    f.service
      .inbox("b", { limit: 1, include_read: false })
      .map((m) => m.message_id),
    [a2.message_id],
  );
  assert.deepEqual(f.service.inbox("b"), []);
  assert.equal(f.row(c1.message_id).state, "pending");
  for (const limit of [0, 51, 1.5])
    assert.throws(() => f.service.inbox("b", { limit, include_read: false }), {
      code: "invalid_request",
      details: { field: "limit", min: 1, max: 50 },
    });
});

test("an SDK ACK still releases the body, so the inbox does not show it again", async (t) => {
  const f = await fixture(t);
  const input = next();
  f.service.submit("a", input);
  const delivery = f.service.poll("b");
  f.service.ack("b", ack(delivery));
  f.raw.exec("UPDATE delivery_messages SET acked_at=acked_at-10");
  assert.deepEqual(f.service.inbox("b", { limit: 10, include_read: true }), []);
});

test("received returns reply metadata only for the caller's own received message", async (t) => {
  const f = await fixture(t);
  const input = next();
  f.service.submit("a", input);
  assert.deepEqual(f.service.received("b", input.message_id), {
    message_id: input.message_id,
    sender_id: "a",
    kind: "question",
    thread_id: "thread-ab",
    state: "pending",
    expires_at: input.expires_at,
  });
  assert.equal(f.row(input.message_id).state, "pending");
  assert.throws(() => f.service.received("a", input.message_id), {
    code: "reply_target_not_found",
    reason: "reply_target_unknown",
  });
  assert.throws(() => f.service.received("b", "bad id!"), {
    code: "invalid_request",
  });
  // The same message ID from two senders is ambiguous.
  f.service.submit("c", { ...input, thread_id: "thread-cb" });
  assert.throws(() => f.service.received("b", input.message_id), {
    code: "reply_target_not_found",
    reason: "reply_target_ambiguous",
  });
});

test("inbox reaches deliverable messages behind more denied ones than the poll scan limit", async (t) => {
  const f = await fixture(t, {
    queue: { poll_scan_limit: 1 },
    deny: (context, operation, peer) => operation === "poll" && peer === "c",
  });
  const blocked = [next(), next()];
  for (const input of blocked)
    f.service.submit("c", { ...input, thread_id: "thread-cb" });
  const allowed = next();
  f.service.submit("a", allowed);
  assert.deepEqual(
    f.service.inbox("b").map((m) => m.message_id),
    [allowed.message_id],
  );
});

test("inbox with a message_id reads that one message again, beyond the newest page", async (t) => {
  const f = await fixture(t);
  const older = next();
  const newer = next();
  f.service.submit("a", older);
  f.service.submit("a", newer);
  f.service.inbox("b");
  f.raw.exec("UPDATE delivery_messages SET acked_at=acked_at-10");
  f.raw
    .prepare(
      "UPDATE delivery_messages SET acked_at=acked_at-5 WHERE message_id=?",
    )
    .run(older.message_id);
  assert.deepEqual(
    f.service
      .inbox("b", { limit: 1, include_read: true })
      .map((m) => m.message_id),
    [newer.message_id],
  );
  assert.deepEqual(
    f.service
      .inbox("b", {
        limit: 1,
        include_read: false,
        message_id: older.message_id,
      })
      .map((m) => [m.message_id, m.new]),
    [[older.message_id, false]],
  );
  // A still-unread message asked for by ID is read (and marked read) at once.
  const unread = next();
  f.service.submit("a", unread);
  assert.deepEqual(
    f.service
      .inbox("b", {
        limit: 10,
        include_read: false,
        message_id: unread.message_id,
      })
      .map((m) => [m.message_id, m.new]),
    [[unread.message_id, true]],
  );
  assert.deepEqual(f.service.inbox("b"), []);
  assert.throws(
    () =>
      f.service.inbox("b", {
        limit: 1,
        include_read: false,
        message_id: "bad id",
      }),
    { code: "invalid_request", details: { field: "message_id" } },
  );
});

test("inbox stops before a message that would not fit the response budget and leaves it unread", async (t) => {
  const f = await fixture(t);
  const big = (n) =>
    next({ body: { parts: [{ type: "text", text: String(n).repeat(3000) }] } });
  const inputs = [big(1), big(2), big(3)];
  for (const input of inputs) f.service.submit("a", input);
  const budget = { limit: 10, include_read: false, max_bytes: 2 * 16200 };
  assert.deepEqual(
    f.service.inbox("b", budget).map((m) => m.message_id),
    [inputs[0].message_id, inputs[1].message_id],
  );
  assert.equal(f.row(inputs[2].message_id).state, "pending");
  // The first message is always taken, even when it alone exceeds the budget.
  assert.deepEqual(
    f.service.inbox("b", { ...budget, max_bytes: 1 }).map((m) => m.message_id),
    [inputs[2].message_id],
  );
});
