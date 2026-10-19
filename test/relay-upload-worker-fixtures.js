import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fixture as clientFixture } from "./relay-attachment-client-fixtures.js";
import { journalOptions, guard } from "./relay-upload-journal-fixtures.js";
import { payload } from "./relay-attachment-fixtures.js";
import { SQLiteUploadJournal } from "../src/relay/sqlite-upload-journal.ts";
import { AttachmentUploadSender } from "../src/relay/upload-sender.ts";
export async function fixture(t, patch = {}) {
  const f = await clientFixture(t),
    path = join(f.dir, "worker-source.sqlite"),
    stores = new Set(),
    config = {
      ...journalOptions,
      agent_id: f.a.agent_id,
      retry_base_ms: 1,
      retry_cap_ms: 10,
      ...patch,
    };
  const open = (extra = {}) => {
    const s = new SQLiteUploadJournal(path, { ...config, ...extra });
    s.migrate();
    stores.add(s);
    return s;
  };
  const journal = open(),
    raw = new DatabaseSync(path);
  t.after(() => {
    raw.close();
    for (const s of stores) s.close();
  });
  const close = (s) => {
    s.close();
    stores.delete(s);
  };
  const fill = (v = f.beginInput(), bytes = payload, s = journal) => {
    s.prepare(v);
    for (let n = 0; n < bytes.length; n += config.chunk_bytes)
      s.putSource(v.request_id, n, bytes.subarray(n, n + config.chunk_bytes));
    s.seal(v.request_id);
    return v;
  };
  const worker = (
    store = journal,
    transport = f.client(),
    policy = { timeout_ms: 1000 },
  ) => new AttachmentUploadSender(store, transport, policy);
  const port = (patch = {}) => ({
    ...Object.fromEntries(
      ["claim", "accept", "fail"].map((k) => [k, journal[k].bind(journal)]),
    ),
    ...patch,
  });
  const transport = (changes = {}) => {
    const client = f.client();
    return {
      ...Object.fromEntries(
        ["beginUpload", "putUploadChunk", "finalizeUpload"].map((k) => [
          k,
          client[k].bind(client),
        ]),
      ),
      ...changes,
    };
  };
  const due = (id) => {
    const r = raw
      .prepare("SELECT * FROM upload_journal_entries WHERE request_id=?")
      .get(id);
    r.next_retry_at = 0;
    r.guard = guard(r, config.fingerprint_key);
    raw
      .prepare(
        "UPDATE upload_journal_entries SET next_retry_at=0,guard=? WHERE request_id=?",
      )
      .run(r.guard, id);
  };
  const finish = async (w = worker()) => {
    for (let n = 0; n < 12; n++) {
      const r = await w.workOnce();
      if (r.state === "finalized") return r;
      if (["closed", "deferred", "idle"].includes(r.state))
        throw Error("synthetic finite worker stopped");
    }
    throw Error("finite synthetic worker budget exceeded");
  };
  return {
    ...f,
    deletionWorker: f.worker,
    journal,
    journalRaw: raw,
    journalOpen: open,
    journalClose: close,
    source: fill,
    worker,
    port,
    transport,
    due,
    finish,
    sourceChunks: () =>
      raw.prepare("SELECT count(*) n FROM upload_journal_chunks").get().n,
  };
}
export const afterLease = (job) => {
  const until = Date.parse(job.lease_until) + 15;
  while (Date.now() < until)
    Atomics.wait(
      new Int32Array(new SharedArrayBuffer(4)),
      0,
      0,
      until - Date.now(),
    );
};
