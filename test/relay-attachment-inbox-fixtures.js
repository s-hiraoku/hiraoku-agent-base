import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { SQLiteAttachmentInbox } from "../src/relay/sqlite-attachment-inbox.ts";
import { makeReplayBoundMessageId } from "../src/relay/contract.ts";
import { limits } from "./relay-http-fixtures.js";
import { payload } from "./relay-attachment-fixtures.js";
export const inboxOptions = {
  agent_id: "b",
  fingerprint_key: new Uint8Array(32).fill(96),
  limits,
  chunk_bytes: 4,
  max_attachment_bytes: 4096,
  max_records: 10,
  max_live_bytes: 10000,
  max_clock_skew_ms: 1000,
  busy_timeout_ms: 50,
};
let sequence = 0;
export function message(bytes = payload, extra = []) {
  const first = new Date(Date.now() - 100).toISOString(),
    id = makeReplayBoundMessageId(
      first,
      (++sequence).toString(16).padStart(32, "0"),
    );
  const part = (data, index) => ({
    type: "attachment",
    attachment_id: "synthetic-file-" + sequence + "-" + index,
    media_type: "application/octet-stream",
    size_bytes: data.length,
    sha256: createHash("sha256").update(data).digest("hex"),
    filename: "synthetic.bin",
  });
  return {
    version: 1,
    message_id: id,
    recipient_id: "b",
    kind: "question",
    first_sent_at: first,
    expires_at: new Date(Date.parse(first) + 3600000).toISOString(),
    thread_id: "synthetic-local-inbox",
    in_reply_to: null,
    body: {
      parts: [
        { type: "text", text: "Synthetic caption" },
        part(bytes, 0),
        ...extra.map((b, i) => part(b, i + 1)),
      ],
    },
  };
}
export function packet(m, offset = 0, bytes = payload, index = 0) {
  const {
    type: _type,
    attachment_id,
    ...descriptor
  } = m.body.parts.filter((p) => p.type === "attachment")[index];
  void _type;
  const data = bytes.slice(offset, offset + 4);
  return {
    version: 1,
    sender_id: "a",
    recipient_id: m.recipient_id,
    message_id: m.message_id,
    attachment_id,
    expires_at: m.expires_at,
    ...descriptor,
    offset,
    next_offset: offset + data.length,
    chunk_bytes: 4,
    eof: offset + data.length === descriptor.size_bytes,
    data,
  };
}
export function fixture(t, patch = {}) {
  const dir = mkdtempSync(join(tmpdir(), "attachment-inbox-")),
    path = join(dir, "inbox.sqlite"),
    stores = new Set();
  const open = (config = {}) => {
    const s = new SQLiteAttachmentInbox(path, {
      ...inboxOptions,
      ...patch,
      ...config,
    });
    stores.add(s);
    return s;
  };
  const store = open();
  store.migrate();
  const raw = new DatabaseSync(path);
  t.after(() => {
    raw.close();
    for (const s of stores) s.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const fill = (m, all = [payload], selected = store) => {
    selected.prepare("a", m);
    all.forEach((bytes, index) => {
      for (let offset = 0; offset < bytes.length; offset += 4)
        selected.put("a", m.message_id, packet(m, offset, bytes, index));
    });
    return selected.verify("a", m.message_id);
  };
  return {
    dir,
    path,
    store,
    raw,
    open,
    fill,
    close(s) {
      s.close();
      stores.delete(s);
    },
    count: (table) =>
      Number(raw.prepare("SELECT count(*) n FROM " + table).get().n),
  };
}
