import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createHmac } from "node:crypto";
import {
  fixture as uploadsFixture,
  intent,
  payload,
} from "./relay-attachment-fixtures.js";
import { SQLiteUploadJournal } from "../src/relay/sqlite-upload-journal.ts";
import { makeUploadRequestId } from "../src/relay/attachments.ts";
import { makeReplayBoundMessageId } from "../src/relay/contract.ts";
export const journalOptions = {
  agent_id: "a",
  fingerprint_key: new Uint8Array(32).fill(103),
  chunk_bytes: 4,
  max_attachment_bytes: 4096,
  max_records: 10,
  max_live_bytes: 10000,
  max_clock_skew_ms: 1000,
  busy_timeout_ms: 50,
  lease_ms: 30000,
  max_attempts: 3,
  retry_base_ms: 1000,
  retry_cap_ms: 60000,
};
const hash = (domain, data, key = journalOptions.fingerprint_key) =>
  createHmac("sha256", key)
    .update(domain + "\0")
    .update(data)
    .digest("hex");
export function guard(r, key = journalOptions.fingerprint_key) {
  return hash(
    "entry-v1",
    JSON.stringify([
      r.request_id,
      r.fingerprint,
      r.state,
      r.source_bytes,
      r.source_retained,
      r.remote_id,
      r.remote_offset,
      r.operation,
      r.receipt,
      r.fence,
      r.lease_until,
      r.attempts,
      r.total_attempts,
      r.next_retry_at,
      r.reason,
      r.terminal_at,
      r.retain_until,
    ]),
    key,
  );
}
export function fixture(t, patch = {}) {
  const f = uploadsFixture(t),
    path = join(f.dir, "upload-journal.sqlite"),
    stores = new Set(),
    config = { ...journalOptions, ...patch };
  const open = (changes = {}) => {
    const s = new SQLiteUploadJournal(path, { ...config, ...changes });
    stores.add(s);
    return s;
  };
  const store = open();
  store.migrate();
  const raw = new DatabaseSync(path);
  t.after(() => {
    raw.close();
    for (const s of stores) s.close();
  });
  const close = (s) => {
    s.close();
    stores.delete(s);
  };
  const fill = (v = intent(), bytes = payload, s = store) => {
    s.prepare(v);
    for (let n = 0; n < bytes.length; n += config.chunk_bytes)
      s.putSource(v.request_id, n, bytes.subarray(n, n + config.chunk_bytes));
    return s.seal(v.request_id);
  };
  const reply = (job) => {
    switch (job.operation) {
      case "begin":
        return f.api.begin(f.contexts.a, job.intent);
      case "put":
        return f.api.put(f.contexts.a, job.attachment_id, job.offset, job.data);
      case "finalize":
        return f.api.finalize(f.contexts.a, job.attachment_id);
    }
  };
  const finish = (v, s = store) => {
    for (let n = 0; n < 12; n++) {
      const job = s.claim();
      if (!job) throw Error("synthetic claim unavailable");
      const result = s.accept(job, reply(job));
      if (result.state === "finalized") return result;
    }
    throw Error("finite synthetic operation budget exceeded");
  };
  const signedUpdate = (id, changes) => {
    const r = raw
      .prepare("SELECT * FROM upload_journal_entries WHERE request_id=?")
      .get(id);
    Object.assign(r, changes);
    r.guard = guard(r, config.fingerprint_key);
    const keys = [...Object.keys(changes), "guard"];
    raw
      .prepare(
        "UPDATE upload_journal_entries SET " +
          keys.map((k) => k + "=?").join(",") +
          " WHERE request_id=?",
      )
      .run(...keys.map((k) => r[k]), id);
  };
  let sequence = 1;
  const seed = (age = 32 * 86400000, state = "released", retained = false) => {
    const now = Date.now(),
      first = new Date(now - age).toISOString(),
      entropy = (++sequence).toString(16).padStart(32, "0"),
      v = intent(payload, {
        first_sent_at: first,
        expires_at: new Date(now - age + 3600000).toISOString(),
        message_id: makeReplayBoundMessageId(first, entropy),
      });
    v.request_id = makeUploadRequestId(first, entropy);
    const text = JSON.stringify(v),
      created = now - age,
      r = {
        request_id: v.request_id,
        intent: text,
        fingerprint: hash(
          "intent-v1",
          JSON.stringify([config.agent_id, created, text]),
          config.fingerprint_key,
        ),
        created_at: created,
        expires_at: Date.parse(v.expires_at),
        size_bytes: payload.length,
        state,
        source_bytes: payload.length,
        source_retained: retained ? 1 : 0,
        remote_id: null,
        remote_offset: 0,
        operation: "begin",
        receipt: null,
        fence: 0,
        lease_until: null,
        attempts: 0,
        total_attempts: 0,
        next_retry_at: 0,
        reason: state === "released" ? "released" : null,
        terminal_at: state === "preparing" ? null : created,
        retain_until:
          state === "preparing"
            ? null
            : Math.max(created, Date.parse(v.expires_at)) + 30 * 86400000,
        guard: "",
      };
    r.guard = guard(r, config.fingerprint_key);
    raw
      .prepare(
        "INSERT INTO upload_journal_entries VALUES(" +
          Array(22).fill("?").join(",") +
          ")",
      )
      .run(...Object.values(r));
    if (retained)
      for (let n = 0; n < payload.length; n += 4) {
        const data = payload.subarray(n, n + 4),
          tag = hash(
            "source-v1",
            r.request_id +
              "\0" +
              n +
              "\0" +
              Buffer.from(data).toString("base64"),
            config.fingerprint_key,
          );
        raw
          .prepare("INSERT INTO upload_journal_chunks VALUES(?,?,?,?)")
          .run(r.request_id, n, data, tag);
      }
    return v;
  };
  return {
    ...f,
    journalPath: path,
    journal: store,
    journalRaw: raw,
    journalOpen: open,
    journalClose: close,
    fill,
    reply,
    finish,
    signedUpdate,
    seed,
    sourceChunks: () =>
      raw.prepare("SELECT count(*) n FROM upload_journal_chunks").get().n,
  };
}
