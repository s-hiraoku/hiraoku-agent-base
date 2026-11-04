import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";

export function identities(product = "paper") {
  const binding = {
    ownerScope: "synthetic-owner-scope",
    senderAgent: "synthetic-sender",
    recipientAgent: `synthetic-${product}`,
    recipientOwner: `synthetic-${product}-owner`,
    conversationBinding: "trusted-conversation-1",
  };
  return {
    sender: {
      subject: "synthetic-sender-owner",
      clientId: "synthetic-sender-client",
      destination: binding.recipientAgent,
      operations: ["submit", "get", "cancel", "events"],
      taskTypes: ["generic_text"],
      textBinding: binding,
    },
    worker: {
      subject: `synthetic-${product}-worker`,
      clientId: `synthetic-${product}-client`,
      worker: binding.recipientAgent,
      runnerScope: `synthetic-${product}-runtime-v1`,
      operations: ["claim", "get", "heartbeat", "complete", "reconcile"],
      taskTypes: ["generic_text"],
      textBinding: binding,
    },
  };
}
export const request = (messageId = "synthetic-message-1", text = "hello") => ({
  messageId,
  contextId: `context-${messageId}`,
  text,
  workDeadline: Date.now() + 3_600_000,
});

export class SyntheticTextRuns {
  supportedTaskTypes = ["generic_text"];
  textBoundary = Object.freeze({
    version: 1,
    inputAuthority: "external_agent",
    effects: "none",
    automaticReply: false,
  });
  toolIsolationVerified = true;
  durableIdempotency = true;
  retentionMs = 86_400_000;
  admissionContract = "synthetic-text-v1";
  constructor(path, product = "paper", mode = "complete") {
    assert.ok(["paper", "mirror"].includes(product));
    assert.ok(["complete", "lose-response", "running"].includes(mode));
    this.product = product;
    this.mode = mode;
    this.boundaryId = `synthetic-${product}-runtime-v1`;
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS runs (
        key TEXT PRIMARY KEY, id TEXT NOT NULL UNIQUE,
        input TEXT NOT NULL, text TEXT NOT NULL, state TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS calls (kind TEXT NOT NULL);
    `);
  }
  async create() {
    throw Error("synthetic_fixed_prompt_path_forbidden");
  }
  async createText(input) {
    assert.deepEqual(input.tools, []);
    assert.equal(input.content.origin, "external_agent");
    assert.deepEqual(Object.keys(input.content).sort(), [
      "contextId",
      "messageId",
      "origin",
      "recipientAgent",
      "senderAgent",
      "text",
    ]);
    this.db.prepare("INSERT INTO calls VALUES('create')").run();
    const fingerprint = JSON.stringify(input.content);
    const old = this.db
      .prepare("SELECT * FROM runs WHERE key=?")
      .get(input.idempotencyKey);
    if (old) {
      assert.equal(old.input, fingerprint);
      return { id: old.id, state: old.state, text: old.text };
    }
    const id = `run-${this.product}-${this.count() + 1}`;
    const text =
      this.product === "paper"
        ? `paper:${input.content.text}`
        : `mirror:${input.content.text.toUpperCase()}`;
    const state = this.mode === "running" ? "running" : "succeeded";
    this.db
      .prepare("INSERT INTO runs VALUES(?,?,?,?,?)")
      .run(input.idempotencyKey, id, fingerprint, text, state);
    if (this.mode === "lose-response")
      throw Error("synthetic_admission_response_lost");
    return { id, state, text };
  }
  async get(id) {
    this.db.prepare("INSERT INTO calls VALUES('get')").run();
    const row = this.db.prepare("SELECT * FROM runs WHERE id=?").get(id);
    if (!row) throw Error("synthetic_run_not_found");
    return { id, state: row.state, text: row.text };
  }
  finish() {
    this.db.exec("UPDATE runs SET state='succeeded'");
  }
  count() {
    return Number(this.db.prepare("SELECT count(*) AS n FROM runs").get().n);
  }
  calls(kind) {
    return Number(
      this.db.prepare("SELECT count(*) AS n FROM calls WHERE kind=?").get(kind)
        .n,
    );
  }
  close() {
    this.db.close();
  }
}
