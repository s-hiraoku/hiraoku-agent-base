import assert from "node:assert/strict";
import { test } from "node:test";
import { fixture, wire } from "./relay-attachment-mcp-fixtures.js";
import { payload, code } from "./relay-attachment-fixtures.js";
import { request, policy } from "./relay-http-fixtures.js";
import { HabHttpGateway } from "../src/hab/http.ts";
import { AttachmentHttpGateway } from "../src/relay/attachment-http.ts";
import { RelayHttpGateway } from "../src/relay/http.ts";
import {
  attachmentWirePolicy,
  decodeAttachmentBase64,
  encodeAttachmentBase64,
  parseWireUploadReceipt,
  parseWireAttachmentChunk,
} from "../src/relay/attachment-wire.ts";
import { RelayError } from "../src/relay/service.ts";
test("attachment MCP: optional catalogs add exactly six tools; default Relay and HAB retain four and five", async (t) => {
  const f = fixture(t);
  assert.equal((await f.list()).length, 11);
  assert.equal(
    (await f.list(new HabHttpGateway(f.service, policy, f.audit, f.verifier)))
      .length,
    5,
  );
  assert.equal(
    (await f.list(new RelayHttpGateway(f.service, policy, f.audit, f.verifier)))
      .length,
    4,
  );
  const core = new AttachmentHttpGateway(
    f.service,
    f.operations,
    wire,
    policy,
    f.audit,
    f.verifier,
  );
  const tools = await f.list(core);
  assert.equal(tools.length, 10);
  assert.equal(
    tools.filter((n) => n.startsWith("relay_attachment_")).length,
    6,
  );
  assert.ok(
    !tools.some((n) => /maintain|delete|shell|register|credential/.test(n)),
  );
});
test("attachment wire: policy and canonical bounded binary roundtrips", () => {
  assert.deepEqual(attachmentWirePolicy(wire), wire);
  const bytes = Uint8Array.from([0, 255, 128, 1]);
  assert.deepEqual(
    decodeAttachmentBase64(encodeAttachmentBase64(bytes, 4), 4),
    bytes,
  );
  const maximum = new Uint8Array(1048576).fill(255);
  assert.deepEqual(
    decodeAttachmentBase64(encodeAttachmentBase64(maximum, 1048576), 1048576),
    maximum,
  );
  for (const value of [
    { ...wire, chunk_bytes: 0 },
    { ...wire, chunk_bytes: 1048577 },
    { ...wire, max_attachment_bytes: 268435457 },
    { ...wire, chunk_bytes: 1 },
  ])
    assert.throws(
      () => attachmentWirePolicy(value),
      code("invalid_attachment_wire_policy"),
    );
});
test("attachment wire: rejects invalid alphabet, padding bits, whitespace, oversized and nonstring input", () => {
  for (const s of [
    "AA",
    "AA=",
    "AB==",
    "AAB=",
    "AA==\n",
    "AA== ",
    "-w==",
    "_w==",
    "AAAAAA==",
    {},
    null,
  ])
    assert.throws(
      () => decodeAttachmentBase64(s, 1),
      code("invalid_attachment_wire"),
    );
});
test("attachment MCP: missing verifier denies all six tools without touching uploads", async (t) => {
  const f = fixture(t),
    g = f.gateway({}, f.operations, () => null);
  for (const name of (await f.list()).filter((n) =>
    n.startsWith("relay_attachment_"),
  )) {
    const r = await g.fetch(
      request("tools/call", { name, arguments: f.beginInput() }),
    );
    assert.equal(r.status, 401);
  }
  assert.equal(f.count(), 0);
});
test("attachment MCP: unknown identity, URL, paths, extra fields and unsupported version are rejected before storage", async (t) => {
  const f = fixture(t);
  for (const patch of [
    { owner_id: f.a.agent_id },
    { agent_name: "grok-bot" },
    { url: "https://files.example/secret" },
    { path: "/private/synthetic" },
    { version: 2 },
  ]) {
    const r = await f.invoke("relay_attachment_begin", {
      ...f.beginInput(),
      ...patch,
    });
    assert.ok(
      r.response.status !== 200 ||
        r.body.error ||
        r.body.result?.isError === true,
    );
  }
  assert.equal(f.count(), 0);
  const disabled = new HabHttpGateway(f.service, policy, f.audit, f.verifier);
  const refused = await f.invoke(
    "relay_attachment_begin",
    f.beginInput(),
    "a",
    disabled,
  );
  assert.ok(
    refused.response.status !== 200 ||
      refused.body.error ||
      refused.body.result?.isError === true,
  );
  assert.equal(f.count(), 0);
});
test("attachment MCP: begin and chunk retry preserve IDs, original deadline and bounded offset", async (t) => {
  const f = fixture(t),
    input = f.beginInput(),
    first = await f.begin(input),
    again = await f.begin(input);
  assert.deepEqual(again, first);
  assert.equal(f.count(), 1);
  const put = {
    ...f.ref(first),
    offset: 0,
    data_base64: Buffer.from(payload.subarray(0, 4)).toString("base64"),
  };
  const r = await f.invoke("relay_attachment_put", put),
    againPut = await f.invoke("relay_attachment_put", put);
  assert.equal(r.result.next_offset, 4);
  assert.deepEqual(againPut.result, r.result);
  assert.equal(r.result.expires_at, input.expires_at);
  const conflict = await f.invoke("relay_attachment_put", {
    ...put,
    data_base64: "AAAAAA==",
  });
  assert.equal(conflict.result.error, "upload_chunk_conflict");
});
test("attachment MCP: malformed chunk is refused without progress or bytes", async (t) => {
  const f = fixture(t),
    r = await f.begin();
  for (const value of ["AA", "AB==", "AA==\n", "AAAAAAA="]) {
    const result = await f.invoke("relay_attachment_put", {
      ...f.ref(r),
      offset: 0,
      data_base64: value,
    });
    assert.ok(result.response.status !== 200 || result.result?.error);
  }
  assert.equal(
    (await f.invoke("relay_attachment_status", f.ref(r))).result.next_offset,
    0,
  );
  assert.equal(
    f.blobRaw.prepare("SELECT count(*) n FROM attachment_chunks").get().n,
    0,
  );
});
test("attachment MCP: upload status, finalize and cancel remain owner scoped", async (t) => {
  const f = fixture(t),
    r = await f.begin();
  for (const tool of [
    "relay_attachment_status",
    "relay_attachment_finalize",
    "relay_attachment_cancel",
  ]) {
    const result = await f.invoke(tool, f.ref(r), "c");
    assert.equal(result.result.error, "upload_not_found");
  }
  assert.equal(
    (await f.invoke("relay_attachment_finalize", f.ref(r))).result.error,
    "upload_incomplete",
  );
  const cancelled = await f.invoke("relay_attachment_cancel", f.ref(r));
  assert.equal(cancelled.result.state, "cancelled");
  assert.deepEqual(
    (await f.invoke("relay_attachment_cancel", f.ref(r))).result,
    cancelled.result,
  );
});
test("attachment MCP: finalized bytes are denied before message confirmation then read by the current receiver only", async (t) => {
  const f = fixture(t),
    r = await f.complete(),
    input = f.readInput(r);
  assert.equal(
    (await f.invoke("relay_attachment_read", input, "b")).result.error,
    "attachment_read_not_found",
  );
  await f.invoke("relay_submit", f.message(r));
  const first = await f.invoke("relay_attachment_read", input, "b");
  assert.equal(first.response.status, 200);
  assert.deepEqual(
    parseWireAttachmentChunk(first.result, wire).data,
    payload.subarray(0, 4),
  );
  assert.equal(Object.hasOwn(first.result, "data"), false);
  assert.equal(
    (await f.invoke("relay_attachment_read", input, "c")).result.error,
    "attachment_read_not_found",
  );
  assert.equal(
    (await f.invoke("relay_attachment_read", input, "a")).result.error,
    "attachment_read_not_found",
  );
  const eof = await f.invoke(
    "relay_attachment_read",
    f.readInput(r, payload.length),
    "b",
  );
  assert.equal(eof.result.data_base64, "");
  assert.equal(eof.result.eof, true);
  assert.deepEqual(
    (await f.invoke("relay_attachment_read", input, "b")).result,
    first.result,
  );
});
test("attachment MCP: receiver block and stop deny download and ACK; source cancel cannot unpin", async (t) => {
  const f = fixture(t),
    r = await f.complete();
  await f.invoke("relay_submit", f.message(r));
  assert.equal(
    (await f.invoke("relay_attachment_cancel", f.ref(r))).result.error,
    "upload_bound",
  );
  f.block(true, "synthetic-wire-block");
  assert.equal(
    (await f.invoke("relay_attachment_read", f.readInput(r), "b")).result.error,
    "forbidden",
  );
  f.block(false, "synthetic-wire-unblock");
  const delivery = (await f.invoke("relay_poll", {}, "b")).result.delivery;
  f.change(f.b, "stopped");
  assert.equal(
    (await f.invoke("relay_attachment_read", f.readInput(r), "b")).result.error,
    "forbidden",
  );
  assert.equal(
    (
      await f.invoke(
        "relay_ack",
        {
          sender_id: f.a.agent_id,
          message_id: r.message_id,
          generation: delivery.generation,
          lease_token: delivery.lease_token,
          request_id: "synthetic-wire-ack",
        },
        "b",
      )
    ).result.error,
    "forbidden",
  );
});
test("attachment MCP: invalid output is redacted and asynchronous host ports are rejected without unhandled rejection", async (t) => {
  const f = fixture(t);
  for (const begin of [
    () => {
      throw Error("synthetic-private-error");
    },
    () => Promise.reject(Error("synthetic-private-error")),
    () => ({ ...f.beginInput(), private_token: "synthetic-private-error" }),
  ]) {
    const uploads = Object.fromEntries(
      ["begin", "status", "put", "finalize", "cancel"].map((k) => [
        k,
        f.uploads[k].bind(f.uploads),
      ]),
    );
    uploads.begin = begin;
    const g = f.gateway({}, { ...f.operations, uploads }),
      r = await f.invoke("relay_attachment_begin", f.beginInput(), "a", g);
    assert.ok(
      ["relay_operation_failed", "invalid_attachment_wire"].includes(
        r.result.error,
      ),
    );
    assert.ok(!JSON.stringify(r.body).includes("synthetic-private-error"));
  }
});
test("attachment MCP: unknown host RelayError cannot expose arbitrary details", async (t) => {
  const f = fixture(t),
    uploads = Object.fromEntries(
      ["begin", "status", "put", "finalize", "cancel"].map((k) => [
        k,
        f.uploads[k].bind(f.uploads),
      ]),
    );
  uploads.begin = () => {
    throw new RelayError("synthetic_private_code");
  };
  const r = await f.invoke(
    "relay_attachment_begin",
    f.beginInput(),
    "a",
    f.gateway({}, { ...f.operations, uploads }),
  );
  assert.equal(r.result.error, "relay_operation_failed");
});
test("attachment MCP: audit failure before work refuses upload", async (t) => {
  const f = fixture(t),
    sink = {
      record(category) {
        if (category === "tool_started") throw Error("synthetic audit failure");
      },
    };
  const r = await f.invoke(
    "relay_attachment_begin",
    f.beginInput(),
    "a",
    f.gateway({}, f.operations, f.verifier, sink),
  );
  assert.ok(r.response.status !== 200 || r.result.error);
  assert.equal(f.count(), 0);
});
test("attachment MCP: lost post-commit audit result is reconciled with the same begin intent", async (t) => {
  const f = fixture(t),
    input = f.beginInput(),
    sink = {
      record(category) {
        if (category === "tool_succeeded")
          throw Error("synthetic audit failure");
      },
    };
  const r = await f.invoke(
    "relay_attachment_begin",
    input,
    "a",
    f.gateway({}, f.operations, f.verifier, sink),
  );
  assert.ok(r.response.status !== 200 || r.result.error);
  assert.equal(f.count(), 1);
  const recovered = await f.begin(input);
  assert.equal(recovered.request_id, input.request_id);
  assert.equal(f.count(), 1);
});
test("attachment MCP: HTTP request budget rejects before progress; response budget requires same-ID reconciliation", async (t) => {
  const f = fixture(t),
    input = f.beginInput();
  assert.equal(
    (
      await f.invoke(
        "relay_attachment_begin",
        input,
        "a",
        f.gateway({ max_request_bytes: 64 }),
      )
    ).response.status,
    413,
  );
  assert.equal(f.count(), 0);
  assert.equal(
    (
      await f.invoke(
        "relay_attachment_begin",
        input,
        "a",
        f.gateway({ max_response_bytes: 64 }),
      )
    ).response.status,
    503,
  );
  assert.equal(f.count(), 1);
  assert.equal((await f.begin(input)).request_id, input.request_id);
});
test("attachment wire: corrupted receipts and chunks never normalize into success", async (t) => {
  const f = fixture(t),
    r = await f.complete();
  assert.deepEqual(parseWireUploadReceipt(r, wire), r);
  for (const patch of [
    { next_offset: 1 },
    { received_bytes: 999 },
    { chunk_bytes: 8 },
    { state: "finalized", finalized_at: null },
    { state: "cancelled", terminal_at: null },
    { private_token: "x" },
  ])
    assert.throws(
      () => parseWireUploadReceipt({ ...r, ...patch }, wire),
      code("invalid_attachment_wire"),
    );
  await f.invoke("relay_submit", f.message(r));
  const c = (await f.invoke("relay_attachment_read", f.readInput(r), "b"))
    .result;
  for (const patch of [
    { offset: 1 },
    { next_offset: 10 },
    { eof: true },
    { size_bytes: 999999 },
    { data_base64: "AB==" },
    { chunk_bytes: 8 },
    { url: "https://files.example/file" },
  ])
    assert.throws(
      () => parseWireAttachmentChunk({ ...c, ...patch }, wire),
      code("invalid_attachment_wire"),
    );
});
test("attachment MCP: empty upload finalizes and returns authenticated empty EOF", async (t) => {
  const f = fixture(t),
    bytes = new Uint8Array(),
    input = f.beginInput(bytes),
    r = await f.complete(input, bytes);
  assert.equal(r.state, "finalized");
  assert.equal(r.next_offset, 0);
  await f.invoke("relay_submit", f.message(r));
  const c = (await f.invoke("relay_attachment_read", f.readInput(r), "b"))
    .result;
  assert.equal(c.data_base64, "");
  assert.equal(c.eof, true);
  assert.equal(c.size_bytes, 0);
});
test("attachment MCP: whole-file digest rejection is a visible fixed outcome", async (t) => {
  const f = fixture(t),
    input = f.beginInput(),
    r = await f.begin({
      ...input,
      attachment: { ...input.attachment, sha256: "0".repeat(64) },
    });
  for (let i = 0; i < payload.length; i += wire.chunk_bytes)
    await f.invoke("relay_attachment_put", {
      ...f.ref(r),
      offset: i,
      data_base64: Buffer.from(
        payload.subarray(i, i + wire.chunk_bytes),
      ).toString("base64"),
    });
  const rejected = (await f.invoke("relay_attachment_finalize", f.ref(r)))
    .result;
  assert.equal(rejected.state, "rejected");
  assert.equal(rejected.reason, "digest_mismatch");
  assert.equal(
    f.blobRaw.prepare("SELECT count(*) n FROM attachment_chunks").get().n,
    0,
  );
});
