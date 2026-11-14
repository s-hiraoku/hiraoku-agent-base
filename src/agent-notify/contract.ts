/**
 * The arrival notifier's contract (ADR-021). HAB owns everything that is the same for every
 * agent: finding new mail without reading it (hab_peek), the texts, the user's decision and
 * the guard against acting twice. Each agent product supplies one small adapter, an
 * `AgentScreen`: where the notice appears and how its own existing session takes the
 * request after the user chose 対応する.
 */
import { z } from "zod";
import type { IncomingChoice } from "../messaging/incoming-notice.ts";

const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$(?![\s\S])/);
const time = z.string().refine((value) => Number.isFinite(Date.parse(value)));

/** One unread message as hab_peek returns it. */
export const peekedMessageSchema = z.object({
  message_id: id,
  /** The sender's immutable ID; (sender_id, message_id) names one message. */
  sender_id: id,
  from: z.string().nullable(),
  kind: z.string(),
  thread_id: z.string(),
  in_reply_to: z.string().nullable(),
  sent_at: time,
  expires_at: time,
  /** Shown to the user as soon as the message arrives. */
  display: z.string().min(1),
  /** Given to the user's own session only after they chose 対応する. */
  handoff_prompt: z.string().min(1),
});
export type PeekedMessage = z.infer<typeof peekedMessageSchema>;
export const peekResultSchema = z.object({
  messages: z.array(peekedMessageSchema),
  next_cursor: z.string().nullable(),
});
export interface PeekPage {
  messages: PeekedMessage[];
  /** Pass as `after` for the next page; null when nothing follows. */
  next_cursor: string | null;
}

/** What the notifier needs from HAB, with the recipient's own credential. */
export interface NotifierHab {
  /** One page of unread messages, left unread, after the given cursor. */
  peek(limit: number, after?: string): Promise<PeekPage>;
  /**
   * Marks one message read once the user decided on it (hab_mark_read), named by sender
   * and ID: two senders may use the same message_id.
   */
  markRead(messageId: string, senderId: string): Promise<void>;
}

/**
 * How the user's own session took the request:
 * - `started`: the session accepted it and began working on it.
 * - `queued`: the product took it into the session's input, but did not confirm a start.
 * - `unsupported`: the product has no official way into that session. Never fall back to
 *   another session or a CLI run under the same address.
 */
export type HandoffResult = "started" | "queued" | "unsupported";

/** The per-agent adapter. Both calls address the one session this notifier is bound to. */
export interface AgentScreen {
  /** A label for logs and the decision record, such as `hermes-desktop:<session>`. */
  readonly target: string;
  /** Shows the notice in that session. Must not start model work. */
  show(message: PeekedMessage): Promise<void>;
  /** Gives the user-approved request to that session. */
  handoff(message: PeekedMessage): Promise<HandoffResult>;
  /** Optional: tells the user what happened after a decision (for example `unsupported`). */
  report?(message: PeekedMessage, state: NoticeState): Promise<void>;
}

/**
 * Where one message stands:
 * - `shown`: on the user's screen, waiting for a choice (still unread in HAB).
 * - `later`: the user chose あとで; it stays unread and can be shown again.
 * - `declined`: the user chose 対応しない; marked read, nothing started.
 * - `accepting`: the user chose 対応する and the handoff is under way.
 * - `started` / `queued` / `unsupported`: the handoff result (marked read).
 * - `unknown`: the handoff failed or timed out and may or may not have reached the session.
 *   It is never retried automatically, so the request cannot run twice.
 * - `expired`: the reply deadline passed before a decision.
 */
export type NoticeState =
  | "shown"
  | "later"
  | "declined"
  | "accepting"
  | "started"
  | "queued"
  | "unsupported"
  | "unknown"
  | "expired";

export interface NoticeRecord {
  message_id: string;
  sender_id: string;
  target: string;
  state: NoticeState;
  from: string | null;
  expires_at: string;
  shown_at: string;
  decided_at: string | null;
  message: PeekedMessage;
}

export type { IncomingChoice };
