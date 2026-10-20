import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createHmac } from "node:crypto";
import { fixture as uploadFixture } from "./relay-upload-worker-fixtures.js";
import { limits } from "./relay-http-fixtures.js";
import { SQLiteReceiveCheckpoint } from "../src/relay/sqlite-receive-checkpoint.ts";
import { AttachmentReceiver } from "../src/relay/attachment-receiver.ts";
export async function fixture(t, patch = {}) {
  const f = await uploadFixture(t),
    path = join(f.dir, "receive-checkpoint.sqlite"),
    stores = new Set();
  const options = {
    agent_id: f.b.agent_id,
    fingerprint_key: new Uint8Array(32).fill(105),
    limits,
    max_payload_bytes: 65536,
    busy_timeout_ms: 50,
    lease_ms: 30000,
    max_attempts: 3,
    retry_base_ms: 1,
    retry_cap_ms: 10,
    ...patch,
  };
  const open = (extra = {}) => {
    const s = new SQLiteReceiveCheckpoint(path, { ...options, ...extra });
    stores.add(s);
    return s;
  };
  const checkpoint = open();
  checkpoint.migrate();
  const raw = new DatabaseSync(path),
    local = f.local();
  t.after(() => {
    raw.close();
    for (const s of stores) s.close();
  });
  const close = (s) => {
    s.close();
    stores.delete(s);
  };
  const rewrite = (action) => {
    const r = raw.prepare("SELECT * FROM receive_checkpoint").get();
    action(r);
    const hash = createHmac("sha256", options.fingerprint_key)
      .update("receive-checkpoint-v1\0")
      .update(
        JSON.stringify([
          options.agent_id,
          r.state,
          r.payload,
          r.expires_at,
          r.fence,
          r.lease_until,
          r.attempts,
          r.next_retry_at,
          r.reason,
        ]),
      )
      .digest("hex");
    raw
      .prepare(
        "UPDATE receive_checkpoint SET state=?,payload=?,expires_at=?,fence=?,lease_until=?,attempts=?,next_retry_at=?,reason=?,guard=? WHERE id=1",
      )
      .run(
        r.state,
        r.payload,
        r.expires_at,
        r.fence,
        r.lease_until,
        r.attempts,
        r.next_retry_at,
        r.reason,
        hash,
      );
  };
  const port = (patch = {}) => ({
    ...Object.fromEntries(
      ["claim", "save", "release", "complete", "fail"].map((k) => [
        k,
        checkpoint[k].bind(checkpoint),
      ]),
    ),
    ...patch,
  });
  const transport = (patch = {}) => {
    const c = f.client("b");
    return {
      ...Object.fromEntries(
        ["poll", "ack", "read"].map((k) => [k, c[k].bind(c)]),
      ),
      ...patch,
    };
  };
  const inbox = (patch = {}) => ({
    ...Object.fromEntries(
      ["save", "claimAck", "confirmAck", "rejectAck", "inbox"].map((k) => [
        k,
        local.body[k].bind(local.body),
      ]),
    ),
    ...patch,
  });
  const worker = (
    s = checkpoint,
    c = f.client("b"),
    body = local.body,
    files = local.files,
    policy = { timeout_ms: 1000 },
  ) => new AttachmentReceiver(s, body, files, c, limits, policy);
  const submitted = async () => {
    const r = await f.completeNative(),
      m = f.message(r);
    await f.client().submit(m);
    return { r, m };
  };
  return {
    ...f,
    uploadWorker: f.worker,
    deletionWorker: f.deletionWorker,
    local,
    checkpoint,
    checkpointRaw: raw,
    open,
    close,
    rewrite,
    port,
    transport,
    inbox,
    worker,
    submitted,
    due: () => {
      rewrite((r) => {
        r.next_retry_at = 0;
      });
      local.raw.exec("UPDATE relay_receiver_acks SET next_retry_at=0");
    },
    leaseExpired: () =>
      rewrite((r) => {
        r.lease_until = 0;
      }),
    staged: () =>
      local.raw.prepare("SELECT count(*) n FROM relay_inbox").get().n,
  };
}
export const waitPast = async (at) => {
  const ms = Date.parse(at) - Date.now() + 15;
  if (ms > 0) await new Promise((r) => setTimeout(r, ms));
};
