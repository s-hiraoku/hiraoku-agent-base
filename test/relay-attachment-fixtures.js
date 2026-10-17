import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import {
  AttachmentUploadService,
  makeUploadRequestId,
} from "../src/relay/attachments.ts";
import { SQLiteAttachmentStore } from "../src/relay/sqlite-attachment-store.ts";
import { message } from "./relay-http-fixtures.js";
export const options = {
  fingerprint_key: new Uint8Array(32).fill(83),
  chunk_bytes: 4,
  max_attachment_bytes: 4096,
  max_records: 20,
  max_open_uploads: 10,
  max_open_per_owner: 5,
  max_live_bytes: 10000,
  max_live_bytes_per_owner: 5000,
  upload_ttl_ms: 60000,
  max_clock_skew_ms: 1000,
  busy_timeout_ms: 50,
};
export const digest = (bytes) =>
  createHash("sha256").update(bytes).digest("hex");
export const payload = Uint8Array.from([0, 255, 128, 1, 10, 13, 42, 77, 0, 6]);
export const code = (wanted) => (error) =>
  error.code === wanted && error.message === wanted;
export function intent(bytes = payload, patch = {}) {
  const m = message();
  return {
    version: 1,
    request_id: makeUploadRequestId(
      m.first_sent_at,
      digest(patch.request_id ?? "synthetic-upload").slice(0, 32),
    ),
    message_id: m.message_id,
    recipient_id: "b",
    kind: "question",
    first_sent_at: m.first_sent_at,
    expires_at: m.expires_at,
    attachment: {
      media_type: "application/octet-stream",
      size_bytes: bytes.byteLength,
      sha256: digest(bytes),
      filename: "synthetic.bin",
    },
    ...Object.fromEntries(
      Object.entries(patch).filter(([key]) => key !== "request_id"),
    ),
  };
}
export function fixture(t, patch = {}) {
  const dir = mkdtempSync(join(tmpdir(), "relay-attachment-")),
    path = join(dir, "uploads.sqlite"),
    stores = new Set();
  const contexts = {
    a: Symbol("synthetic-a"),
    b: Symbol("synthetic-b"),
    admin: Symbol("synthetic-maintenance"),
  };
  const mutable = { active: true, peer: true, denied: new Set() },
    calls = [];
  const authorization = {
    authorize(ctx, op, peer, kind) {
      calls.push({ op, peer, kind });
      if (op === "maintenance")
        return ctx === contexts.admin
          ? { agent_id: "administrator" }
          : undefined;
      if (
        !mutable.active ||
        mutable.denied.has(op) ||
        (peer && (!mutable.peer || peer !== "b" || kind !== "question"))
      )
        return undefined;
      const agent = Object.keys(contexts).find(
        (name) => contexts[name] === ctx && name !== "admin",
      );
      return agent ? { agent_id: agent } : undefined;
    },
  };
  const open = (extra = {}) => {
    const store = new SQLiteAttachmentStore(path, {
      ...options,
      ...patch,
      ...extra,
    });
    stores.add(store);
    return store;
  };
  const service = (store, auth = authorization) =>
    new AttachmentUploadService(store, { ...options, ...patch }, auth);
  const store = open();
  store.migrate();
  const api = service(store),
    raw = new DatabaseSync(path);
  t.after(() => {
    raw.close();
    for (const s of stores) s.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const close = (s) => {
    s.close();
    stores.delete(s);
  };
  const putAll = (
    id,
    bytes = payload,
    selected = api,
    context = contexts.a,
  ) => {
    for (
      let offset = 0;
      offset < bytes.byteLength;
      offset += options.chunk_bytes
    )
      selected.put(
        context,
        id,
        offset,
        bytes.subarray(offset, offset + options.chunk_bytes),
      );
  };
  return {
    dir,
    path,
    contexts,
    mutable,
    calls,
    authorization,
    open,
    close,
    service,
    store,
    api,
    raw,
    putAll,
    count: (table) =>
      Number(raw.prepare(`SELECT count(*) n FROM ${table}`).get().n),
  };
}
