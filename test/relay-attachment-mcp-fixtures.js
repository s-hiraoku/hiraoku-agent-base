import { fixture as habFixture } from "./hab-attachment-fixtures.js";
import { options, intent, payload } from "./relay-attachment-fixtures.js";
import {
  policy,
  call,
  request,
  decode,
  limits,
} from "./relay-http-fixtures.js";
import { HabRelayService } from "../src/hab/relay.ts";
import { HabAttachmentRead } from "../src/hab/attachment-read.ts";
import { HabAttachmentHttpGateway } from "../src/hab/attachment-http.ts";
export const wire = {
  max_attachment_bytes: options.max_attachment_bytes,
  chunk_bytes: options.chunk_bytes,
};
export function fixture(t) {
  const f = habFixture(t, true, true),
    relay = new HabRelayService(f.registry, f.relay, limits),
    acceptance = f.api(),
    service = Object.fromEntries(
      ["status", "poll", "ack", "resolve"].map((k) => [
        k,
        relay[k].bind(relay),
      ]),
    );
  service.submit = acceptance.submit.bind(acceptance);
  const operations = {
    uploads: f.uploads,
    reads: new HabAttachmentRead(f.registry, f.relay, f.blob, limits),
  };
  const events = [],
    audit = {
      record(category, correlation) {
        events.push({ category, correlation });
      },
    };
  const verifier = ({ authorization }) =>
    f.contexts[
      {
        "Bearer fixture-a": "a",
        "Bearer fixture-b": "b",
        "Bearer fixture-c": "c",
      }[authorization]
    ] ?? null;
  const gateway = (
    patch = {},
    port = operations,
    verify = verifier,
    sink = audit,
  ) =>
    new HabAttachmentHttpGateway(
      service,
      port,
      wire,
      { ...policy, ...patch },
      sink,
      verify,
    );
  const g = gateway(),
    invoke = async (name, args = {}, who = "a", selected = g) => {
      const r = await call(selected, name, args, {
        headers: { Authorization: "Bearer fixture-" + who },
      });
      return { ...r, result: r.body?.result?.structuredContent };
    };
  const beginInput = (bytes = payload, patch = {}) =>
    intent(bytes, { ...patch, recipient_id: f.b.agent_id });
  const begin = async (input = beginInput()) =>
    (await invoke("relay_attachment_begin", input)).result;
  const complete = async (input = beginInput(), bytes = payload) => {
    const r = await begin(input);
    for (let i = 0; i < bytes.length; i += wire.chunk_bytes)
      await invoke("relay_attachment_put", {
        version: 1,
        attachment_id: r.attachment_id,
        offset: i,
        data_base64: Buffer.from(
          bytes.subarray(i, i + wire.chunk_bytes),
        ).toString("base64"),
      });
    return (
      await invoke("relay_attachment_finalize", {
        version: 1,
        attachment_id: r.attachment_id,
      })
    ).result;
  };
  const message = (r) => ({
    version: 1,
    message_id: r.message_id,
    recipient_id: r.recipient_id,
    kind: r.kind,
    first_sent_at: r.first_sent_at,
    expires_at: r.expires_at,
    thread_id: "synthetic-mcp-attachment",
    in_reply_to: null,
    body: {
      parts: [
        { type: "text", text: "Synthetic bytes" },
        { type: "attachment", attachment_id: r.attachment_id, ...r.attachment },
      ],
    },
  });
  const ref = (r) => ({ version: 1, attachment_id: r.attachment_id });
  const readInput = (r, offset = 0) => ({
    version: 1,
    sender_id: f.a.agent_id,
    message_id: r.message_id,
    attachment_id: r.attachment_id,
    offset,
  });
  const count = () =>
    f.blobRaw.prepare("SELECT count(*) n FROM attachment_uploads").get().n;
  const list = async (selected = g) =>
    (await decode(await selected.fetch(request()))).result.tools
      .map((t) => t.name)
      .sort();
  return {
    ...f,
    service,
    operations,
    events,
    audit,
    verifier,
    gateway,
    g,
    invoke,
    beginInput,
    begin,
    complete,
    message,
    ref,
    readInput,
    count,
    list,
  };
}
