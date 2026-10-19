import { makeUploadRequestId } from "../src/relay/attachments.ts";
import { test } from "node:test";
import { setImmediate } from "node:timers";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  fixture,
  transform,
  loseOnce,
} from "./relay-attachment-client-fixtures.js";
import { wire } from "./relay-attachment-mcp-fixtures.js";
import { payload, code, digest } from "./relay-attachment-fixtures.js";
import { HabAttachmentMcpClient } from "../src/hab/attachment-mcp-client.ts";
import { decode } from "./relay-http-fixtures.js";
const stageAll = async (local, c, m, store = local.files) => {
  for (let i = 0; i < 10; i++)
    if ((await local.stage(c, m, store)).state === "verified") return;
  assert.fail("finite synthetic staging budget exceeded");
};
test("attachment client: native localhost upload, resolve, durable receive, server ACK and physical cleanup", async (t) => {
  const f = await fixture(t),
    a = f.client(),
    b = f.client("b"),
    input = f.beginInput();
  const resolved = await a.resolve(f.b.address);
  assert.equal(resolved.recipient_id, f.b.agent_id);
  // The transport has no sender journal: this test explicitly saves intent before any begin.
  const intentPath = join(f.dir, "synthetic-intent.json");
  writeFileSync(intentPath, JSON.stringify(input), { mode: 0o600 });
  const r = await f.completeNative(
      a,
      JSON.parse(readFileSync(intentPath, "utf8")),
    ),
    m = f.message(r);
  const accepted = await a.submit(m),
    delivery = await b.poll(),
    local = f.local();
  assert.equal(accepted.message_id, m.message_id);
  local.files.prepare(f.a.agent_id, m);
  assert.throws(
    () => local.body.save(delivery),
    code("attachment_inbox_unverified"),
  );
  await stageAll(local, b, m);
  local.body.save(delivery);
  const req = local.body.claimAck(),
    ack = await b.ack(req);
  local.body.confirmAck(req, ack);
  assert.equal((await a.status(m.message_id)).state, "acked");
  await assert.rejects(
    () => b.read(f.readInput(r)),
    code("attachment_read_not_found"),
  );
  assert.equal(f.worker().workOnce(f.operator).state, "done");
  assert.equal(
    f.blobRaw.prepare("SELECT count(*) n FROM attachment_chunks").get().n,
    0,
  );
  assert.deepEqual(
    local.files.read(f.a.agent_id, m.message_id, r.attachment_id, 0),
    payload.subarray(0, 4),
  );
  assert.ok(
    f.tools.includes("relay_attachment_put") &&
      f.tools.includes("relay_attachment_read") &&
      f.tools.includes("relay_ack"),
  );
});
test("attachment client: lost begin response recovers exact original intent after listener restart", async (t) => {
  const f = await fixture(t),
    input = f.beginInput(),
    loss = loseOnce("relay_attachment_begin"),
    a = f.client("a", { fetch: loss.fetch });
  await assert.rejects(
    () => a.beginUpload(input),
    code("relay_transport_failed"),
  );
  assert.equal(f.count(), 1);
  await f.stop();
  await f.start();
  const r = await f.client().beginUpload(input);
  assert.equal(r.request_id, input.request_id);
  assert.equal(f.count(), 1);
  assert.equal(loss.lost, true);
});
test("attachment client: lost chunk response resumes by authoritative next_offset and exact old-byte retry", async (t) => {
  const f = await fixture(t),
    a = f.client(),
    r = await a.beginUpload(f.beginInput()),
    loss = loseOnce("relay_attachment_put"),
    uncertain = f.client("a", { fetch: loss.fetch });
  await assert.rejects(
    () => uncertain.putUploadChunk(r.attachment_id, 0, payload.subarray(0, 4)),
    code("relay_transport_failed"),
  );
  const status = await f.client().uploadStatus(r.attachment_id);
  assert.equal(status.next_offset, 4);
  const again = await a.putUploadChunk(
    r.attachment_id,
    0,
    payload.subarray(0, 4),
  );
  assert.equal(again.next_offset, 4);
  assert.equal(
    f.blobRaw.prepare("SELECT count(*) n FROM attachment_chunks").get().n,
    1,
  );
});
test("attachment client: lost finalize response recovers finalized state without upload recreation", async (t) => {
  const f = await fixture(t),
    a = f.client(),
    r = await a.beginUpload(f.beginInput());
  for (let i = 0; i < payload.length; i += 4)
    await a.putUploadChunk(r.attachment_id, i, payload.subarray(i, i + 4));
  const loss = loseOnce("relay_attachment_finalize");
  await assert.rejects(
    () => f.client("a", { fetch: loss.fetch }).finalizeUpload(r.attachment_id),
    code("relay_transport_failed"),
  );
  const restored = await f.client().finalizeUpload(r.attachment_id);
  assert.equal(restored.state, "finalized");
  assert.equal(f.count(), 1);
});
test("attachment client: interrupted download resumes from durable receiver DB after client and store reopen", async (t) => {
  const f = await fixture(t),
    a = f.client(),
    r = await f.completeNative(a),
    m = f.message(r);
  await a.submit(m);
  const local = f.local(),
    loss = loseOnce("relay_attachment_read", (v) => v.offset === 4),
    b = f.client("b", { fetch: loss.fetch });
  assert.equal((await local.stage(b, m)).files[0].next_offset, 4);
  await assert.rejects(
    () => local.stage(b, m),
    code("attachment_read_transport_failed"),
  );
  local.close(local.body);
  local.close(local.files);
  const files = local.openFiles(),
    body = local.openBody(files);
  assert.equal(
    (await local.stage(f.client("b"), m, files)).files[0].next_offset,
    8,
  );
  await stageAll(local, f.client("b"), m, files);
  const d = await f.client("b").poll();
  body.save(d);
  assert.ok(body.claimAck());
});
test("attachment client: ACK response loss reuses durable request after server cleanup and local restart", async (t) => {
  const f = await fixture(t),
    a = f.client(),
    r = await f.completeNative(a),
    m = f.message(r);
  await a.submit(m);
  const local = f.local(),
    b = f.client("b"),
    delivery = await b.poll();
  await stageAll(local, b, m);
  local.body.save(delivery);
  const req = local.body.claimAck(),
    loss = loseOnce("relay_ack");
  await assert.rejects(
    () => f.client("b", { fetch: loss.fetch }).ack(req),
    code("relay_transport_failed"),
  );
  assert.equal(f.worker().workOnce(f.operator).state, "done");
  local.close(local.body);
  local.close(local.files);
  const files = local.openFiles(),
    body = local.openBody(files);
  local.raw.exec("UPDATE relay_receiver_acks SET next_retry_at=0");
  const again = body.claimAck();
  assert.deepEqual(again, req);
  const ack = await f.client("b").ack(again);
  body.confirmAck(again, ack);
  assert.equal(
    f.raw.prepare("SELECT count(*) n FROM relay_ack_receipts").get().n,
    1,
  );
  assert.equal(
    f.raw.prepare("SELECT count(*) n FROM relay_attachment_deletions").get().n,
    1,
  );
  assert.deepEqual(
    files.read(f.a.agent_id, m.message_id, r.attachment_id, 0),
    payload.subarray(0, 4),
  );
});
test("attachment client: empty files cross native HTTP and verify without chunk reads", async (t) => {
  const f = await fixture(t),
    a = f.client(),
    empty = new Uint8Array(),
    r = await f.completeNative(a, f.beginInput(empty), empty),
    m = f.message(r);
  await a.submit(m);
  const local = f.local(),
    b = f.client("b");
  await stageAll(local, b, m);
  assert.equal(f.tools.filter((n) => n === "relay_attachment_read").length, 0);
  const eof = await b.read(f.readInput(r));
  assert.equal(eof.data.length, 0);
  assert.equal(eof.eof, true);
});
test("attachment client: upload owner and receiver identities cannot be selected by transport arguments", async (t) => {
  const f = await fixture(t),
    r = await f.completeNative();
  await assert.rejects(
    () => f.client("c").uploadStatus(r.attachment_id),
    code("upload_not_found"),
  );
  await f.client().submit(f.message(r));
  await assert.rejects(
    () => f.client("c").read(f.readInput(r)),
    code("attachment_read_not_found"),
  );
  f.block(true, "synthetic-client-block");
  await assert.rejects(
    () => f.client("b").read(f.readInput(r)),
    code("forbidden"),
  );
});
test("attachment client: wrong owner, upload identity or intent in a valid response is refused", async (t) => {
  const f = await fixture(t);
  for (const [change, wanted] of [
    [
      (v) => {
        v.owner_id = f.c.agent_id;
      },
      "forbidden",
    ],
    [
      (v) => {
        v.kind = "answer";
      },
      "relay_transport_failed",
    ],
    [
      (v) => {
        v.attachment.sha256 = "0".repeat(64);
      },
      "relay_transport_failed",
    ],
  ]) {
    const a = f.client("a", {
      fetch: transform("relay_attachment_begin", change),
    });
    await assert.rejects(() => a.beginUpload(f.beginInput()), code(wanted));
  }
  const r = await f.client().beginUpload(f.beginInput());
  await assert.rejects(
    () =>
      f
        .client("a", {
          fetch: transform("relay_attachment_status", (v) => {
            v.attachment_id = "different-upload";
          }),
        })
        .uploadStatus(r.attachment_id),
    code("relay_transport_failed"),
  );
});
test("attachment client: request binding rejects foreign receiver, different sender, file, offset and expired chunk", async (t) => {
  const f = await fixture(t),
    r = await f.completeNative();
  await f.client().submit(f.message(r));
  const changes = [
    [
      (v) => {
        v.recipient_id = f.c.agent_id;
      },
      "forbidden",
    ],
    [
      (v) => {
        v.sender_id = f.c.agent_id;
      },
      "relay_transport_failed",
    ],
    [
      (v) => {
        v.attachment_id = "different-file";
      },
      "relay_transport_failed",
    ],
    [
      (v) => {
        v.message_id = "different-message";
      },
      "relay_transport_failed",
    ],
    [
      (v) => {
        v.offset = 4;
        v.next_offset = 8;
      },
      "relay_transport_failed",
    ],
    [
      (v) => {
        v.expires_at = "2000-01-01T00:00:00.000Z";
      },
      "relay_transport_failed",
    ],
  ];
  for (const [change, wanted] of changes)
    await assert.rejects(
      () =>
        f
          .client("b", { fetch: transform("relay_attachment_read", change) })
          .read(f.readInput(r)),
      code(wanted),
    );
});
test("attachment client: corrupt base64 and response metadata never reach durable inbox", async (t) => {
  const f = await fixture(t),
    r = await f.completeNative(),
    m = f.message(r);
  await f.client().submit(m);
  const local = f.local(),
    b = f.client("b", {
      fetch: transform("relay_attachment_read", (v) => {
        v.data_base64 = "AB==";
      }),
    });
  await assert.rejects(
    () => local.stage(b, m),
    code("attachment_read_transport_failed"),
  );
  assert.equal(local.files.prepare(f.a.agent_id, m).files[0].next_offset, 0);
  assert.equal(
    f.raw.prepare("SELECT count(*) n FROM relay_ack_receipts").get().n,
    0,
  );
});
test("attachment client: missing credentials and invalid upload input fail before network", async (t) => {
  const f = await fixture(t),
    before = f.tools.length;
  const a = f.client("a", { authorization: () => "" });
  await assert.rejects(() => a.beginUpload(f.beginInput()), code("forbidden"));
  const good = f.client();
  for (const [offset, bytes] of [
    [-1, payload.subarray(0, 4)],
    [1, payload.subarray(0, 4)],
    [0, new Uint8Array()],
    [0, new Uint8Array(5)],
  ])
    await assert.rejects(
      () => good.putUploadChunk("synthetic-upload", offset, bytes),
      code("invalid_upload_chunk"),
    );
  await assert.rejects(
    () => good.beginUpload({ ...f.beginInput(), owner_id: f.c.agent_id }),
    code("invalid_upload_request"),
  );
  assert.equal(f.tools.length, before);
});
test("attachment client: local request and response limits reject finite transfers without automatic retry", async (t) => {
  const f = await fixture(t),
    a = f.client("a", { policy: { max_request_bytes: 64 } });
  await assert.rejects(
    () => a.beginUpload(f.beginInput()),
    code("capacity_exceeded"),
  );
  assert.equal(f.count(), 0);
  const input = f.beginInput(),
    small = f.client("a", { policy: { max_response_bytes: 64 } });
  await assert.rejects(
    () => small.beginUpload(input),
    code("relay_transport_failed"),
  );
  assert.equal(f.count(), 1);
  assert.equal(f.tools.filter((n) => n === "relay_attachment_begin").length, 1);
  assert.equal(
    (await f.client().beginUpload(input)).request_id,
    input.request_id,
  );
});
test("attachment client: one admission limit covers upload, download, directory and ordinary Relay calls", async (t) => {
  const f = await fixture(t);
  let finish, entered;
  const ready = new Promise((r) => {
      entered = r;
    }),
    a = f.client("a", {
      fetch: (url, init) => {
        entered();
        return new Promise((r) => {
          finish = () => globalThis.fetch(url, init).then(r);
        });
      },
    });
  const pending = a.beginUpload(f.beginInput());
  await ready;
  await assert.rejects(
    () => a.status("synthetic-message"),
    code("relay_client_busy"),
  );
  await assert.rejects(() => a.resolve(f.b.address), code("relay_client_busy"));
  await assert.rejects(
    () =>
      a.read({
        version: 1,
        sender_id: f.a.agent_id,
        message_id: "synthetic-message",
        attachment_id: "synthetic-file",
        offset: 0,
      }),
    code("relay_client_busy"),
  );
  finish();
  await pending;
});
test("attachment client: timed-out credential lookup keeps its slot until provider settles and sends no late request", async (t) => {
  const f = await fixture(t);
  let release;
  const a = f.client("a", {
    policy: { timeout_ms: 30 },
    authorization: () =>
      new Promise((r) => {
        release = r;
      }),
  });
  await assert.rejects(
    () => a.beginUpload(f.beginInput()),
    code("relay_transport_failed"),
  );
  await assert.rejects(
    () => a.uploadStatus("synthetic-file"),
    code("relay_client_busy"),
  );
  release("Bearer fixture-a");
  await new Promise((r) => setImmediate(r));
  assert.equal(f.tools.length, 0);
});
test("attachment client: redirect and mismatched text/structured output are refused without retry", async (t) => {
  const f = await fixture(t);
  let calls = 0;
  const redirected = f.client("a", {
    fetch: async () => {
      calls++;
      return new Response(null, {
        status: 302,
        headers: { Location: "https://files.example/other" },
      });
    },
  });
  await assert.rejects(
    () => redirected.beginUpload(f.beginInput()),
    code("relay_transport_failed"),
  );
  assert.equal(calls, 1);
  const bad = f.client("a", {
    fetch: async (url, init) => {
      const data = await decode(await globalThis.fetch(url, init));
      data.result.content = [
        {
          type: "text",
          text: JSON.stringify({ secret: "synthetic-mismatch" }),
        },
      ];
      return new Response(JSON.stringify(data), {
        headers: { "Content-Type": "application/json" },
      });
    },
  });
  await assert.rejects(
    () => bad.beginUpload(f.beginInput()),
    code("relay_transport_failed"),
  );
});
test("attachment client: premature success receipts cannot finalize, cancel or advance a chunk", async (t) => {
  const f = await fixture(t),
    a = f.client(),
    r = await a.beginUpload(f.beginInput());
  const fake = () =>
    f.client("a", {
      fetch: async (_url, init) => {
        const request = JSON.parse(init.body);
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: request.id,
            result: {
              resultType: "complete",
              content: [{ type: "text", text: JSON.stringify(r) }],
              structuredContent: r,
            },
          }),
          { headers: { "Content-Type": "application/json" } },
        );
      },
    });
  for (const run of [
    (c) => c.finalizeUpload(r.attachment_id),
    (c) => c.cancelUpload(r.attachment_id),
    (c) => c.putUploadChunk(r.attachment_id, 0, payload.subarray(0, 4)),
  ])
    await assert.rejects(() => run(fake()), code("relay_transport_failed"));
});
test("attachment client: policy copy is stable and malformed wire configuration fails closed", async (t) => {
  const f = await fixture(t),
    config = { ...wire },
    a = f.client("a", { attachments: config });
  config.chunk_bytes = 8;
  const r = await a.beginUpload(f.beginInput());
  assert.equal(r.chunk_bytes, 4);
  assert.throws(
    () =>
      new HabAttachmentMcpClient({ attachments: { ...wire, chunk_bytes: 0 } }),
    code("invalid_relay_client_policy"),
  );
  assert.throws(
    () => f.client("a", { attachments: { ...wire, chunk_bytes: 0 } }),
    code("invalid_attachment_wire_policy"),
  );
});

test("attachment client: ordered text, structured data and two files require complete durable bytes before ACK", async (t) => {
  const f = await fixture(t),
    a = f.client(),
    b = f.client("b"),
    first = f.beginInput(),
    r1 = await f.completeNative(a, first);
  const otherBytes = Uint8Array.from([3, 1, 4, 1, 5, 9]),
    other = {
      ...first,
      request_id: makeUploadRequestId(first.first_sent_at, "b".repeat(32)),
      attachment: {
        ...first.attachment,
        size_bytes: otherBytes.length,
        sha256: digest(otherBytes),
        filename: "synthetic-second.bin",
      },
    },
    r2 = await f.completeNative(a, other, otherBytes),
    m = f.message(r1);
  m.body.parts.push(
    {
      type: "data",
      schema_id: "synthetic-summary",
      schema_version: 1,
      value: { ok: true },
    },
    { type: "attachment", attachment_id: r2.attachment_id, ...r2.attachment },
  );
  await a.submit(m);
  const d = await b.poll(),
    local = f.local();
  assert.deepEqual(JSON.parse(JSON.stringify(d.message.body)), m.body);
  await local.stage(b, m);
  assert.throws(() => local.body.save(d), code("attachment_inbox_unverified"));
  await stageAll(local, b, m);
  local.body.save(d);
  const req = local.body.claimAck();
  local.body.confirmAck(req, await b.ack(req));
  assert.equal(f.worker().workOnce(f.operator).state, "done");
  assert.equal(
    f.blobRaw.prepare("SELECT count(*) n FROM attachment_chunks").get().n,
    0,
  );
  assert.deepEqual(
    local.files.read(f.a.agent_id, m.message_id, r2.attachment_id, 4),
    otherBytes.subarray(4),
  );
});
