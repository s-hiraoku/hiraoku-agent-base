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
import type { NoticeKey, SQLiteNotices } from "./sqlite-notices.ts";

export interface DecisionResult {
  /** Whether this call changed the record; false for a repeated or late choice. */
  changed: boolean;
  state: NoticeState;
}

/** Messages per hab_peek page, and the most pages one check reads. */
const PAGE = 50;
const MAX_PAGES = 100;

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
    // The record and the screen must name the same session; otherwise a choice made for
    // one session could be handed to another.
    if (options.screen.target !== options.store.target)
      throw new MessagingError("notices_target_mismatch");
    this.#hab = options.hab;
    this.#screen = options.screen;
    this.#store = options.store;
    this.#now = options.now ?? Date.now;
  }
  /**
   * One check: expire undecided notices past their deadline, then page through every
   * unread message and show each one not shown before. Returns the IDs shown now. A
   * notice the screen did not finish showing stays `showing`, so the next check shows it again.
   */
  async check(): Promise<string[]> {
    const now = this.#now();
    for (const expired of this.#store.maintain(now))
      await this.#report(expired, "expired");
    // A handoff interrupted by a stop or crash: report it as unknown, never resend it.
    for (const abandoned of this.#store.abandon(now))
      await this.#report(abandoned, "unknown");
    const shown: string[] = [];
    let failure: unknown;
    let after: string | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      const { messages, next_cursor } = await this.#hab.peek(PAGE, after);
      for (const message of messages) {
        if (Date.parse(message.expires_at) <= now) continue;
        // `showing` is written before the screen is asked, and becomes `shown` after. A row
        // left `showing` (a failed or interrupted display) is shown again on the next check.
        const known = this.#store.get(message);
        if (
          known
            ? known.state !== "showing"
            : !this.#store.insertShowing(message, now)
        )
          continue;
        try {
          await this.#screen.show(message);
          this.#store.transition(message, ["showing"], "shown", now);
          shown.push(message.message_id);
        } catch (error) {
          failure ??= error;
        }
      }
      if (!messages.length || next_cursor === null) break;
      after = next_cursor;
    }
    if (failure !== undefined) throw failure;
    return shown;
  }
  /** Notices waiting for a choice (shown or later). */
  open(): NoticeRecord[] {
    return this.#store.open();
  }
  get(messageId: string, senderId?: string): NoticeRecord | undefined {
    const found = this.#find(messageId, senderId);
    return found.length === 1 ? found[0] : undefined;
  }
  /** Shows a notice the user put off again. */
  async showAgain(
    messageId: string,
    senderId?: string,
  ): Promise<DecisionResult> {
    const record = this.#require(messageId, senderId);
    if (record.state !== "later" && record.state !== "shown")
      return { changed: false, state: record.state };
    await this.#screen.show(record.message);
    this.#store.transition(record, ["later"], "shown", this.#now());
    return { changed: true, state: "shown" };
  }
  /**
   * Applies the user's choice for one message. `senderId` is needed only when two senders
   * used the same message ID.
   */
  async decide(
    messageId: string,
    choice: IncomingChoice,
    senderId?: string,
  ): Promise<DecisionResult> {
    const record = this.#require(messageId, senderId);
    const now = this.#now();
    if (
      (record.state === "shown" || record.state === "later") &&
      Date.parse(record.expires_at) <= now
    ) {
      this.#store.transition(record, ["shown", "later"], "expired", now);
      await this.#report(record, "expired");
      return { changed: true, state: "expired" };
    }
    switch (choice) {
      case "later":
        return this.#store.transition(record, ["shown"], "later", now)
          ? { changed: true, state: "later" }
          : this.#unchanged(record);
      case "decline":
        return this.#decided(record, "declined", async () => {
          await this.#hab.markRead(record.message_id, record.sender_id);
          return "declined";
        });
      case "accept":
        return this.#decided(record, "accepting", async () => {
          // HAB no longer offers it to this recipient: hand off nothing.
          if (!(await this.#hab.markRead(record.message_id, record.sender_id)))
            return "unavailable";
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
    if (!this.#store.transition(record, ["shown", "later"], claim, this.#now()))
      return this.#unchanged(record);
    let state: NoticeState;
    try {
      state = await run();
    } catch (error) {
      // Marking read failed before anything started: the choice can be made again.
      this.#store.transition(record, [claim], record.state, this.#now());
      throw error;
    }
    if (state !== claim)
      this.#store.transition(record, [claim], state, this.#now());
    await this.#report(record, state);
    return { changed: true, state };
  }
  #unchanged(key: NoticeKey): DecisionResult {
    return { changed: false, state: this.#store.get(key)!.state };
  }
  #find(messageId: string, senderId?: string) {
    return this.#store
      .find(messageId)
      .filter(
        (record) => senderId === undefined || record.sender_id === senderId,
      );
  }
  #require(messageId: string, senderId?: string): NoticeRecord {
    const found = this.#find(messageId, senderId);
    if (found.length > 1)
      throw new MessagingError("invalid_request", {
        details: { field: "sender_id", expected: "the sender of this message" },
      });
    if (!found.length)
      throw new MessagingError("invalid_request", {
        details: { field: "message_id", expected: "a notice that was shown" },
      });
    return found[0];
  }
  async #report(record: NoticeRecord, state: NoticeState) {
    try {
      await this.#screen.report?.(record.message, state);
    } catch {
      // A report is a courtesy; the decision record is the source of truth.
    }
  }
}
