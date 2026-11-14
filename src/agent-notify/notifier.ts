/**
 * The arrival notifier (ADR-021): shows each new HAB message in the recipient's own agent
 * screen, waits for the user's choice and hands the request to the same session only on
 * 対応する. Arrival alone never starts model work, and a request is handed off at most
 * once, whatever the clicks, restarts or reconnects.
 */
import { MessagingError } from "../messaging/delivery-service.ts";
import type {
  AgentScreen,
  IncomingChoice,
  NoticeRecord,
  NoticeState,
  NotifierHab,
} from "./contract.ts";
import type { SQLiteNotices } from "./sqlite-notices.ts";

export interface DecisionResult {
  /** Whether this call changed the record; false for a repeated or late choice. */
  changed: boolean;
  state: NoticeState;
}

export class ReceiptNotifier {
  readonly #hab: NotifierHab;
  readonly #screen: AgentScreen;
  readonly #store: SQLiteNotices;
  readonly #now: () => number;
  constructor(options: {
    hab: NotifierHab;
    screen: AgentScreen;
    store: SQLiteNotices;
    now?: () => number;
  }) {
    this.#hab = options.hab;
    this.#screen = options.screen;
    this.#store = options.store;
    this.#now = options.now ?? Date.now;
  }
  /**
   * One check: expire undecided notices past their deadline, then show every unread
   * message not shown before. Returns the IDs shown now. A notice the screen could not
   * show is forgotten, so the next check shows it again.
   */
  async check(): Promise<string[]> {
    const now = this.#now();
    for (const expired of this.#store.maintain(now))
      await this.#report(expired, "expired");
    const shown: string[] = [];
    let failure: unknown;
    for (const message of await this.#hab.peek(50)) {
      if (Date.parse(message.expires_at) <= now) continue;
      if (!this.#store.insertShown(message, now)) continue;
      try {
        await this.#screen.show(message);
        shown.push(message.message_id);
      } catch (error) {
        this.#store.forget(message.message_id);
        failure ??= error;
      }
    }
    if (failure !== undefined) throw failure;
    return shown;
  }
  /** Notices waiting for a choice (shown or later). */
  open(): NoticeRecord[] {
    return this.#store.open();
  }
  get(messageId: string): NoticeRecord | undefined {
    return this.#store.get(messageId);
  }
  /** Shows a notice the user put off again. */
  async showAgain(messageId: string): Promise<DecisionResult> {
    const record = this.#require(messageId);
    if (record.state !== "later" && record.state !== "shown")
      return { changed: false, state: record.state };
    await this.#screen.show(record.message);
    this.#store.transition(messageId, ["later"], "shown", this.#now());
    return { changed: true, state: "shown" };
  }
  /** Applies the user's choice for one message. */
  async decide(
    messageId: string,
    choice: IncomingChoice,
  ): Promise<DecisionResult> {
    const record = this.#require(messageId);
    const now = this.#now();
    if (
      (record.state === "shown" || record.state === "later") &&
      Date.parse(record.expires_at) <= now
    ) {
      this.#store.transition(messageId, ["shown", "later"], "expired", now);
      await this.#report(record, "expired");
      return { changed: true, state: "expired" };
    }
    switch (choice) {
      case "later":
        return this.#store.transition(messageId, ["shown"], "later", now)
          ? { changed: true, state: "later" }
          : this.#unchanged(messageId);
      case "decline":
        return this.#decided(record, "declined", async () => {
          await this.#hab.markRead(messageId);
          return "declined";
        });
      case "accept":
        return this.#decided(record, "accepting", async () => {
          await this.#hab.markRead(messageId);
          try {
            return await this.#screen.handoff(record.message);
          } catch {
            // The session may or may not have the request. Never send it again by itself.
            return "unknown";
          }
        });
    }
  }
  async #decided(
    record: NoticeRecord,
    claim: NoticeState,
    run: () => Promise<NoticeState>,
  ): Promise<DecisionResult> {
    const id = record.message_id;
    if (!this.#store.transition(id, ["shown", "later"], claim, this.#now()))
      return this.#unchanged(id);
    let state: NoticeState;
    try {
      state = await run();
    } catch (error) {
      // Marking read failed before anything started: the choice can be made again.
      this.#store.transition(id, [claim], record.state, this.#now());
      throw error;
    }
    if (state !== claim)
      this.#store.transition(id, [claim], state, this.#now());
    await this.#report(record, state);
    return { changed: true, state };
  }
  #unchanged(messageId: string): DecisionResult {
    return { changed: false, state: this.#require(messageId).state };
  }
  #require(messageId: string): NoticeRecord {
    const record = this.#store.get(messageId);
    if (!record)
      throw new MessagingError("invalid_request", {
        details: { field: "message_id", expected: "a notice that was shown" },
      });
    return record;
  }
  async #report(record: NoticeRecord, state: NoticeState) {
    try {
      await this.#screen.report?.(record.message, state);
    } catch {
      // A report is a courtesy; the decision record is the source of truth.
    }
  }
}
