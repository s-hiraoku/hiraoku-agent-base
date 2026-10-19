import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createHmac } from "node:crypto";
import { RelayService } from "../src/relay/service.ts";
import {
  makeReplayBoundMessageId,
  comparisonMaterial,
} from "../src/relay/contract.ts";
import { SQLiteRelayStore } from "../src/relay/sqlite-store.ts";
import { limits } from "./relay-http-fixtures.js";
export const options = {
  fingerprint_key: new Uint8Array(32).fill(98),
  max_pending: 100,
  max_records: 100,
  max_pending_per_recipient: 100,
  max_body_bytes: 100000,
  max_clock_skew_ms: 1000,
  lease_ms: 30000,
  max_attempts: 3,
  retry_base_ms: 10,
  retry_cap_ms: 100,
  poll_scan_limit: 20,
};
export const deletionPolicy = {
  lease_ms: 30000,
  max_attempts: 2,
  retry_base_ms: 1000,
  retry_cap_ms: 60000,
};
export function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "attachment-deletion-")),
    path = join(dir, "relay.sqlite"),
    stores = new Set();
  let n = 0;
  const open = () => {
      const s = new SQLiteRelayStore(path, options, { check() {} });
      stores.add(s);
      return s;
    },
    store = open();
  store.migrate();
  const raw = new DatabaseSync(path),
    context = { active: true };
  const authorize = () => {
    if (!context.active) throw Error("synthetic-private-denial");
  };
  const service = new RelayService(store, limits, {
    authorize(ctx, op) {
      return (ctx === "operator" && op === "maintenance") ||
        ["a", "b"].includes(ctx)
        ? { agent_id: ctx }
        : undefined;
    },
  });
  t.after(() => {
    raw.close();
    for (const s of stores) s.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const message = (at = Date.now() - 100, attached = true) => {
    const first = new Date(at).toISOString(),
      id = makeReplayBoundMessageId(
        first,
        (++n).toString(16).padStart(32, "0"),
      );
    return {
      version: 1,
      message_id: id,
      recipient_id: "b",
      kind: "question",
      first_sent_at: first,
      expires_at: new Date(at + 3600000).toISOString(),
      thread_id: "synthetic-delete-thread",
      in_reply_to: null,
      body: {
        parts: [
          { type: "text", text: "Synthetic private caption" },
          ...(attached
            ? [
                {
                  type: "attachment",
                  attachment_id: "synthetic-file-" + n,
                  media_type: "application/octet-stream",
                  size_bytes: 4,
                  sha256: "1".repeat(64),
                  filename: "synthetic.bin",
                },
              ]
            : []),
        ],
      },
    };
  };
  const seed = (age = 3601000) => {
    const m = message(Date.now() - age),
      accepted = Date.parse(m.first_sent_at) + 10,
      expires = Date.parse(m.expires_at),
      receiptId = "historical-receipt-" + n,
      body = JSON.stringify(m);
    raw.exec(
      "INSERT OR IGNORE INTO relay_threads VALUES('synthetic-delete-thread','a','b')",
    );
    raw
      .prepare(
        "INSERT INTO relay_messages(sender_id,message_id,recipient_id,receipt_id,thread_id,fingerprint,accepted_at,expires_at,state,body,body_bytes,kind) VALUES(?,?,'b',?,?,?, ?,?,'pending',?,?,'question')",
      )
      .run(
        "a",
        m.message_id,
        receiptId,
        m.thread_id,
        createHmac("sha256", options.fingerprint_key)
          .update(comparisonMaterial("a", m, limits))
          .digest("hex"),
        accepted,
        expires,
        body,
        Buffer.byteLength(body),
      );
    raw
      .prepare(
        "INSERT INTO relay_deliveries(sender_id,message_id,recipient_id,state) VALUES(?,?,'b','pending')",
      )
      .run("a", m.message_id);
    const ids = m.body.parts
      .filter((p) => p.type === "attachment")
      .map((p) => p.attachment_id);
    raw.prepare("INSERT INTO relay_message_attachments VALUES(?,?,?,?)").run(
      "a",
      m.message_id,
      JSON.stringify(ids),
      createHmac("sha256", options.fingerprint_key)
        .update(
          "attachment-refs-v1:" +
            JSON.stringify([
              "a",
              m.message_id,
              "b",
              receiptId,
              accepted,
              expires,
              ids,
            ]),
        )
        .digest("hex"),
    );
    return m;
  };
  const expired = (age) => {
    const m = seed(age);
    service.maintain("operator", 10);
    return m;
  };
  return {
    dir,
    path,
    raw,
    store,
    service,
    open,
    authorize,
    context,
    message,
    seed,
    expired,
    count: (table) =>
      Number(raw.prepare("SELECT count(*) n FROM " + table).get().n),
    close(s) {
      s.close();
      stores.delete(s);
    },
  };
}
