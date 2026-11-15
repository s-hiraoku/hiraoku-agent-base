/** Durable, owner-driven reply checks. No inbox, ACK, refresh or native wake capability. */
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { ensurePrivateFile } from "../agent-notify/private-file.ts";
import { replyWatchPlan } from "../hab/reply-watch.ts";
import { MessagingError } from "../messaging/delivery-service.ts";
import { authenticationRecoveryReason } from "../agent-sdk/authentication-recovery.ts";
import { sentSchema, statusSchema } from "./client.ts";
import type { SentMessage, ReplyStatus, SendInput } from "./client.ts";

export interface WatchScope {
  resource_url: string;
  connection_id: string;
  agent_id: string;
  session_id: string;
  as_address?: string;
}
export interface WatchRecord {
  message_id: string;
  accepted_at: string;
  expires_at: string;
  stop_at: number;
  next_at: number;
  state: "waiting" | "replied" | "stopped" | "auth_required";
  failures: number;
  reply_ids: string;
  lease_until: number;
  claim: string | null;
}
export interface WatchTransport {
  send(input: SendInput): Promise<SentMessage>;
  status(messageId: string): Promise<ReplyStatus>;
}
export class ReplyWatchAdapter {
  readonly #db: DatabaseSync;
  readonly #scope: string;
  readonly #transport: WatchTransport;
  readonly #now: () => number;
  constructor(
    path: string,
    scope: WatchScope,
    transport: WatchTransport,
    now = Date.now,
  ) {
    for (const key of [
      "resource_url",
      "connection_id",
      "agent_id",
      "session_id",
    ] as const)
      if (
        typeof scope[key] !== "string" ||
        !scope[key].length ||
        scope[key].length > 2048
      )
        throw Error("invalid_watch_scope");
    this.#scope = JSON.stringify([
      scope.resource_url,
      scope.connection_id,
      scope.agent_id,
      scope.session_id,
      scope.as_address ?? null,
    ]);
    this.#transport = transport;
    this.#now = now;
    ensurePrivateFile(path, "unsafe_watch_store");
    this.#db = new DatabaseSync(path);
    this.#db.exec(`PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS reply_watches (
        scope TEXT NOT NULL, message_id TEXT NOT NULL,
        accepted_at TEXT NOT NULL, expires_at TEXT NOT NULL,
        stop_at INTEGER NOT NULL, next_at INTEGER NOT NULL,
        state TEXT NOT NULL, failures INTEGER NOT NULL DEFAULT 0,
        reply_ids TEXT NOT NULL DEFAULT '[]', lease_until INTEGER NOT NULL DEFAULT 0,
        claim TEXT, PRIMARY KEY(scope, message_id));`);
  }
  close() {
    this.#db.close();
  }
  records(): WatchRecord[] {
    return this.#db
      .prepare(
        "SELECT * FROM reply_watches WHERE scope=? ORDER BY next_at, message_id",
      )
      .all(this.#scope) as unknown as WatchRecord[];
  }
  /** Call once: a lost send result is never automatically resent. */
  async send(input: SendInput) {
    const result = await this.#transport.send(input);
    if ((input.kind ?? "question") === "question") {
      try {
        this.watch(result);
      } catch {
        // Preserve the accepted ID even if the local disk cannot save the watch.
        return { ...result, monitoring: "save_failed" as const };
      }
    }
    return {
      ...result,
      monitoring:
        (input.kind ?? "question") === "question"
          ? ("saved" as const)
          : ("not_expected" as const),
    };
  }
  watch(value: SentMessage) {
    const sent = sentSchema.parse(value);
    if (Date.parse(sent.accepted_at) >= Date.parse(sent.expires_at))
      throw Error("invalid_watch_time");
    const plan = replyWatchPlan(
      sent.accepted_at,
      sent.expires_at,
      "waiting",
      this.#now(),
    );
    // Insert-only: duplicate registration cannot extend the deadline or revive a stopped watch.
    this.#db
      .prepare(
        `INSERT OR IGNORE INTO reply_watches
      (scope,message_id,accepted_at,expires_at,stop_at,next_at,state)
      VALUES (?,?,?,?,?,?,?)`,
      )
      .run(
        this.#scope,
        sent.message_id,
        sent.accepted_at,
        sent.expires_at,
        Date.parse(plan.stop_at),
        plan.action === "check_status"
          ? Date.parse(plan.next_check_at)
          : Date.parse(plan.stop_at),
        plan.action === "check_status" ? "waiting" : "stopped",
      );
  }
  cancel(messageId: string) {
    this.#db
      .prepare(
        "UPDATE reply_watches SET state='stopped', claim=NULL, lease_until=0 WHERE scope=? AND message_id=? AND state='waiting'",
      )
      .run(this.#scope, messageId);
  }
  /** Time for a resident owner's next cycle; idle means its normal cadence. */
  nextDelay(normalMs = 60_000) {
    const now = this.#now();
    const next = this.records()
      .filter((r) => r.state === "waiting")
      .map((r) => Math.min(r.stop_at, Math.max(r.next_at, r.lease_until)));
    return Math.max(0, Math.min(normalMs, ...next.map((at) => at - now)));
  }
  /** Bounded page, atomic claims across processes; always recomputes from the original times. */
  async checkDue(signal?: AbortSignal) {
    if (signal?.aborted) return;
    const now = this.#now();
    this.#db
      .prepare(
        "UPDATE reply_watches SET state='stopped', claim=NULL, lease_until=0 WHERE scope=? AND state='waiting' AND stop_at<=?",
      )
      .run(this.#scope, now);
    const due = this.records()
      .filter(
        (r) =>
          r.state === "waiting" && r.next_at <= now && r.lease_until <= now,
      )
      .slice(0, 50);
    for (const row of due) {
      if (signal?.aborted) break;
      const claim = randomUUID();
      const started = this.#now();
      if (started >= row.stop_at) {
        this.cancel(row.message_id);
        continue;
      }
      const claimed = this.#db
        .prepare(
          `UPDATE reply_watches SET claim=?, lease_until=?
        WHERE scope=? AND message_id=? AND state='waiting' AND next_at<=? AND lease_until<=?`,
        )
        .run(
          claim,
          started + 60_000,
          this.#scope,
          row.message_id,
          started,
          started,
        );
      if (!claimed.changes) continue;
      let state: WatchRecord["state"] = "waiting",
        next = row.stop_at,
        failures = 0,
        replies = "[]";
      try {
        const result = statusSchema.parse(
          await this.#transport.status(row.message_id),
        );
        if (
          result.message_id !== row.message_id ||
          result.accepted_at !== row.accepted_at ||
          result.expires_at !== row.expires_at
        )
          throw new MessagingError("transport_failed");
        const plan = replyWatchPlan(
          row.accepted_at,
          row.expires_at,
          result.reply_state,
          this.#now(),
        );
        state =
          this.#now() >= row.stop_at
            ? "stopped"
            : plan.action === "read_reply"
              ? "replied"
              : plan.action === "stop"
                ? "stopped"
                : "waiting";
        replies = JSON.stringify(result.replies.map((r) => r.message_id));
        if (plan.action === "check_status")
          next = Date.parse(plan.next_check_at);
      } catch (error) {
        const code = error instanceof MessagingError ? error.code : undefined;
        if (
          authenticationRecoveryReason(error) ||
          ["forbidden", "token_expired", "token_unavailable"].includes(
            code ?? "",
          )
        )
          state = "auth_required";
        else if (code !== "transport_failed" && code !== "client_busy")
          state = "stopped";
        else {
          failures = row.failures + 1;
          next =
            this.#now() +
            Math.min(300_000, 15_000 * 2 ** Math.min(failures, 5));
        }
      }
      if (this.#now() >= row.stop_at || next >= row.stop_at) {
        if (state === "waiting") state = "stopped";
        next = row.stop_at;
      }
      // A cancellation or a replacement claim wins over this late completion.
      this.#db
        .prepare(
          `UPDATE reply_watches SET state=?, next_at=?, failures=?, reply_ids=?, lease_until=0, claim=NULL
        WHERE scope=? AND message_id=? AND state='waiting' AND claim=?`,
        )
        .run(
          state,
          next,
          failures,
          replies,
          this.#scope,
          row.message_id,
          claim,
        );
    }
  }
}
