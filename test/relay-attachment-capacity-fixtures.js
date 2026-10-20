import { randomUUID } from "node:crypto";
import {
  fixture as uploadFixture,
  options as base,
  intent,
  payload,
} from "./relay-attachment-fixtures.js";
import { makeUploadRequestId } from "../src/relay/attachments.ts";
import { makeReplayBoundMessageId } from "../src/relay/contract.ts";
import { RelayError } from "../src/relay/service.ts";
import { limits } from "./relay-http-fixtures.js";
export { payload, limits };
export function fixture(t, patch = {}, capacity = {}) {
  const options = {
    ...base,
    max_records: 8,
    max_open_uploads: 6,
    max_open_per_owner: 6,
    max_live_bytes: 60,
    max_live_bytes_per_owner: 60,
    max_attachment_bytes: 64,
    busy_timeout_ms: 1000,
    ...patch,
  };
  if (!Object.hasOwn(patch, "owner_capacity"))
    options.owner_capacity = {
      max_records_per_owner: options.max_records,
      max_bindings_per_owner: options.max_records,
      reservations: [
        {
          owner_id: "b",
          open_uploads: 2,
          live_bytes: 20,
          records: 2,
          bindings: 1,
        },
      ],
      ...capacity,
    };
  const f = uploadFixture(t, options);
  f.contexts.c = Symbol("synthetic-c");
  const value = (bytes = payload, patch = {}) => {
    const v = intent(bytes, patch);
    v.request_id = makeUploadRequestId(
      v.first_sent_at,
      randomUUID().replaceAll("-", ""),
    );
    if (!patch.message_id)
      v.message_id = makeReplayBoundMessageId(
        v.first_sent_at,
        randomUUID().replaceAll("-", ""),
      );
    return v;
  };
  const start = (who = "a", bytes = payload, patch = {}, api = f.api) => {
    const v = value(bytes, patch);
    return { value: v, receipt: api.begin(f.contexts[who], v), bytes };
  };
  const finish = (who, u, api = f.api) => {
    f.putAll(u.receipt.attachment_id, u.bytes, api, f.contexts[who]);
    return api.finalize(f.contexts[who], u.receipt.attachment_id);
  };
  const message = (u) => ({
    version: 1,
    message_id: u.value.message_id,
    recipient_id: u.value.recipient_id,
    kind: u.value.kind,
    first_sent_at: u.value.first_sent_at,
    expires_at: u.value.expires_at,
    thread_id: "synthetic-capacity",
    in_reply_to: null,
    body: {
      parts: [
        {
          type: "attachment",
          attachment_id: u.receipt.attachment_id,
          ...u.value.attachment,
        },
      ],
    },
  });
  const authorize = (who) => (peer) => {
    const decision = f.authorization.authorize(
      f.contexts[who],
      "begin",
      peer?.recipient_id,
      peer?.kind,
    );
    if (!decision) throw new RelayError("forbidden");
    return decision.agent_id;
  };
  const bind = (who, u, store = f.store) =>
    store.prepare(message(u), limits, authorize(who));
  const usage = (who) => ({
    ...f.raw
      .prepare(
        "SELECT count(*) records,coalesce(sum(CASE WHEN state IN ('uploading','finalized') THEN 1 ELSE 0 END),0) open_uploads,coalesce(sum(CASE WHEN state IN ('uploading','finalized') THEN size_bytes ELSE 0 END),0) live_bytes FROM attachment_uploads WHERE owner_id=?",
      )
      .get(who),
    bindings: f.raw
      .prepare("SELECT count(*) n FROM attachment_bindings WHERE owner_id=?")
      .get(who).n,
  });
  const remove = (who, u) => {
    const m = message(u);
    return f.store.deleteBound({
      assertCurrent() {},
      reason: "acked",
      attachment_ids: [u.receipt.attachment_id],
      receipt: {
        sender_id: who,
        message_id: m.message_id,
        recipient_id: m.recipient_id,
        receipt_id: "synthetic-proof",
        accepted_at: new Date().toISOString(),
        expires_at: m.expires_at,
        state: "acked",
      },
    });
  };
  return {
    ...f,
    options,
    value,
    start,
    finish,
    message,
    authorize,
    bind,
    usage,
    remove,
  };
}
