import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { digest } from "../../src/generic-nats/protocol.ts";

export class EffectRuntime {
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
  admissionContract = "synthetic-independent-api-v1";
  constructor(root, product, options = {}) {
    this.product = product;
    this.options = options;
    this.boundaryId = `synthetic-${product}-runtime-v1`;
    this.external = new DatabaseSync(`${root}/${product}-external.sqlite`);
    this.local = new DatabaseSync(`${root}/${product}-runtime.sqlite`);
    for (const db of [this.external, this.local])
      db.exec(
        "PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000",
      );
    this.external.exec(
      "CREATE TABLE IF NOT EXISTS effects(key TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, run TEXT NOT NULL); CREATE TABLE IF NOT EXISTS calls(kind TEXT NOT NULL, key TEXT NOT NULL)",
    );
    this.local.exec(
      "CREATE TABLE IF NOT EXISTS runs(key TEXT PRIMARY KEY, run TEXT NOT NULL)",
    );
  }
  async create() {
    throw Error("fixed_prompt_forbidden");
  }
  async createText(input) {
    assert.deepEqual(input.tools, []);
    assert.equal(input.replay.contract, this.admissionContract);
    const key = input.idempotencyKey,
      fingerprint = digest(input.content);
    this.external.prepare("INSERT INTO calls VALUES('create',?)").run(key);
    this.external.exec("BEGIN IMMEDIATE");
    let run;
    try {
      const row = this.external
        .prepare("SELECT * FROM effects WHERE key=?")
        .get(key);
      if (row) {
        assert.equal(row.fingerprint, fingerprint);
        run = JSON.parse(row.run);
      } else {
        const text = this.options.echo
          ? input.content.text
          : this.product === "paper"
            ? `paper:${input.content.text}`
            : `mirror:${input.content.text.toUpperCase()}`;
        run = {
          id: `external-${this.product}-${digest(key).slice(0, 24)}`,
          state: this.options.running ? "running" : "succeeded",
          ...(this.options.running ? {} : { text }),
        };
        this.external
          .prepare("INSERT INTO effects VALUES(?,?,?)")
          .run(key, fingerprint, JSON.stringify(run));
      }
      this.external.exec("COMMIT");
    } catch (error) {
      this.external.exec("ROLLBACK");
      throw error;
    }
    await this.options.afterEffect?.(key, run);
    this.local
      .prepare("INSERT OR REPLACE INTO runs VALUES(?,?)")
      .run(key, JSON.stringify(run));
    return run;
  }
  async lookupText(key) {
    this.external.prepare("INSERT INTO calls VALUES('lookup',?)").run(key);
    const row = this.external
      .prepare("SELECT run FROM effects WHERE key=?")
      .get(key);
    return row ? JSON.parse(row.run) : null;
  }
  async get(id) {
    for (const row of this.external.prepare("SELECT run FROM effects").all()) {
      const run = JSON.parse(row.run);
      if (run.id === id) return run;
    }
    throw Error("unknown_external_run");
  }
  count() {
    return Number(
      this.external.prepare("SELECT count(*) n FROM effects").get().n,
    );
  }
  calls(kind) {
    return Number(
      this.external
        .prepare("SELECT count(*) n FROM calls WHERE kind=?")
        .get(kind).n,
    );
  }
  close() {
    this.local.close();
    this.external.close();
  }
}
