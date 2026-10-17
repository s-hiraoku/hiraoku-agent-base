import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { HabAttachmentAcceptance } from "../src/hab/attachment-acceptance.ts";
import { HabAttachmentUploads } from "../src/hab/attachment-uploads.ts";
import { SQLiteRelayStore } from "../src/relay/sqlite-store.ts";
import { SQLiteAttachmentStore } from "../src/relay/sqlite-attachment-store.ts";
import {
  fixture as registryFixture,
  operations,
} from "./hab-registry-fixtures.js";
import { options, intent, payload } from "./relay-attachment-fixtures.js";
import { limits } from "./relay-http-fixtures.js";

export function fixture(t, enrollC = true) {
  const f = registryFixture(t),
    a = f.enroll("a"),
    b = f.enroll("b");
  if (enrollC) f.enroll("c");
  const blob = new SQLiteAttachmentStore(
    join(f.dir, "attachments.sqlite"),
    options,
  );
  blob.migrate();
  const relay = new SQLiteRelayStore(
    join(f.dir, "attachment-relay.sqlite"),
    {
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
    },
    { check: (acceptance) => blob.checkPrepared(acceptance, limits) },
  );
  relay.migrate();
  const raw = new DatabaseSync(join(f.dir, "attachment-relay.sqlite")),
    blobRaw = new DatabaseSync(join(f.dir, "attachments.sqlite"));
  t.after(() => {
    raw.close();
    blobRaw.close();
    relay.close();
    blob.close();
  });
  const uploads = new HabAttachmentUploads(f.registry, blob, options);
  const api = (store = relay, bindings = blob) =>
    new HabAttachmentAcceptance(f.registry, store, bindings, limits);
  const upload = () => {
    const v = intent(payload, { recipient_id: b.agent_id }),
      r = uploads.begin(f.contexts.a, v);
    for (let i = 0; i < payload.length; i += options.chunk_bytes)
      uploads.put(
        f.contexts.a,
        r.attachment_id,
        i,
        payload.subarray(i, i + options.chunk_bytes),
      );
    uploads.finalize(f.contexts.a, r.attachment_id);
    return {
      version: 1,
      message_id: v.message_id,
      recipient_id: v.recipient_id,
      kind: v.kind,
      first_sent_at: v.first_sent_at,
      expires_at: v.expires_at,
      thread_id: "synthetic-attachment-thread",
      in_reply_to: null,
      body: {
        parts: [
          { type: "text", text: "Synthetic attachment" },
          {
            type: "attachment",
            attachment_id: r.attachment_id,
            ...v.attachment,
          },
        ],
      },
    };
  };
  const change = (
    who,
    state,
    rights = state === "active" ? operations : [],
  ) => {
    const current = f.registry.inspect(f.admin, who.agent_id);
    return f.registry.setAccess(f.admin, {
      request_id: "change-" + who.agent_id + "-" + current.epoch,
      agent_id: who.agent_id,
      expected_epoch: current.epoch,
      state,
      operations: rights,
    });
  };
  const bindings = (patch) => ({
    ...Object.fromEntries(
      ["prepare", "binding", "confirm", "checkPrepared"].map((k) => [
        k,
        blob[k].bind(blob),
      ]),
    ),
    ...patch,
  });
  const block = (blocked, id) => {
    const aa = f.registry.inspect(f.admin, a.agent_id),
      bb = f.registry.inspect(f.admin, b.agent_id);
    return f.registry.setBlock(f.admin, {
      request_id: id,
      sender_id: a.agent_id,
      recipient_id: b.agent_id,
      sender_epoch: aa.epoch,
      recipient_epoch: bb.epoch,
      blocked,
    });
  };
  return {
    ...f,
    a,
    b,
    blob,
    raw,
    blobRaw,
    relay,
    uploads,
    api,
    upload,
    change,
    bindingPort: bindings,
    block,
    count: () =>
      Number(raw.prepare("SELECT count(*) n FROM relay_messages").get().n),
    pinCount: () =>
      Number(
        blobRaw.prepare("SELECT count(*) n FROM attachment_bindings").get().n,
      ),
    owner: () => a.agent_id,
  };
}
