/**
 * Automatic 対応する for senders the owner allowed (ADR-023). Off unless the notifier config
 * has `auto_accept`. A message that matches a rule is handed to the same session without a
 * click, with a prompt that says nobody chose it and that anything beyond reading and
 * hab_reply still needs the user. Everything else waits for the user as before.
 *
 * The rules match only what HAB itself vouches for: the sender's authenticated address (and,
 * optionally, its immutable sender_id), the kind, whether it answers the recipient's own
 * message, and the body's size. Body keywords are not matched: a sender could copy them.
 * Two agents that both auto-answer could go on forever, so each sender and each thread has
 * a cap; past it the message falls back to the card.
 */
import { z } from "zod";
import { appendPrivate, ensurePrivateFile } from "./private-file.ts";
import type { PeekedMessage } from "./contract.ts";

const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/);

export const autoAcceptRuleSchema = z.strictObject({
  /** Written to the audit log, so a decision names the rule that made it. */
  name: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,47}$/),
  /** Sender addresses as HAB reports them in `from`. */
  from: z.array(z.string().min(1).max(512)).min(1).max(32),
  /** Optional: also require one of these immutable sender IDs (survives an address reuse). */
  sender_ids: z.array(id).min(1).max(32).optional(),
  /** Message kinds this rule accepts, such as question, notice, answer. */
  kinds: z.array(z.string().min(1).max(64)).min(1).max(16),
  /**
   * Whether a reply to the recipient's own message (in_reply_to set) matches. Default true:
   * the answer to a question this agent asked is the usual next step of a conversation.
   */
  replies: z.boolean().default(true),
  /** Whether a new message (not a reply) matches. Default true. */
  new_messages: z.boolean().default(true),
  /** Larger bodies wait for the user. Measured on the handoff prompt, in UTF-8 bytes. */
  max_text_bytes: z
    .number()
    .int()
    .min(1)
    .max(512 * 1024)
    .default(16 * 1024),
});
export type AutoAcceptRule = z.infer<typeof autoAcceptRuleSchema>;

export const autoAcceptConfigSchema = z.strictObject({
  rules: z.array(autoAcceptRuleSchema).min(1).max(32),
  /** Automatic handoffs per sender in any rolling hour. */
  max_per_sender_per_hour: z.number().int().min(1).max(1000).default(10),
  /** Automatic handoffs in one sender's HAB thread, ever (while the records are kept). */
  max_per_thread: z.number().int().min(1).max(1000).default(6),
  /** The notifier's own audit file (JSON Lines, 0600, no message text). */
  audit: z.string().min(1),
});
export type AutoAcceptConfig = z.infer<typeof autoAcceptConfigSchema>;

/** What the policy needs to know about earlier automatic handoffs. */
export interface AutoAcceptCounts {
  bySenderSince(senderId: string, since: number): number;
  /** In the thread this sender shares with the recipient (HAB scopes thread_id per agent pair). */
  byThread(senderId: string, threadId: string): number;
}

export type AutoAcceptVerdict =
  | { accept: true; rule: string }
  | {
      accept: false;
      rule: string;
      reason: "sender_rate_limited" | "thread_limited" | "too_long";
    }
  /** No rule names this message: the card waits for the user, nothing is logged. */
  | undefined;

/** The rolling window of `max_per_sender_per_hour`. */
export const AUTO_ACCEPT_WINDOW_MS = 60 * 60 * 1000;

export class AutoAcceptPolicy {
  readonly #config: AutoAcceptConfig;
  constructor(config: AutoAcceptConfig) {
    this.#config = config;
  }
  get config() {
    return this.#config;
  }
  /** Which rule, if any, lets this message be handed off without a click right now. */
  evaluate(
    message: PeekedMessage,
    counts: AutoAcceptCounts,
    now: number,
  ): AutoAcceptVerdict {
    const reply =
      typeof message.in_reply_to === "string" && message.in_reply_to.length > 0;
    const rule = this.#config.rules.find(
      (candidate) =>
        message.from !== null &&
        candidate.from.includes(message.from) &&
        (candidate.sender_ids === undefined ||
          candidate.sender_ids.includes(message.sender_id)) &&
        candidate.kinds.includes(message.kind) &&
        (reply ? candidate.replies : candidate.new_messages),
    );
    if (!rule) return undefined;
    if (Buffer.byteLength(message.handoff_prompt) > rule.max_text_bytes)
      return { accept: false, rule: rule.name, reason: "too_long" };
    if (
      counts.bySenderSince(message.sender_id, now - AUTO_ACCEPT_WINDOW_MS) >=
      this.#config.max_per_sender_per_hour
    )
      return { accept: false, rule: rule.name, reason: "sender_rate_limited" };
    if (
      counts.byThread(message.sender_id, message.thread_id) >=
      this.#config.max_per_thread
    )
      return { accept: false, rule: rule.name, reason: "thread_limited" };
    return { accept: true, rule: rule.name };
  }
}

/** The first line HAB writes into every handoff prompt says the user chose; for an automatic handoff that is not true. */
const USER_CHOSE =
  /^利用者が、HAB で届いた次の(?:メッセージに「対応する」を選びました|返事を会話に渡しました)。\n/;

/**
 * The prompt for an automatic handoff: HAB's handoff prompt with its first line (which says
 * the user chose) replaced by one that says nobody did, and what may and may not be done
 * without the user. A prompt in an unexpected shape is not rewritten but refused, so the
 * message waits for the user instead.
 */
export function autoHandoffPrompt(
  message: PeekedMessage,
  rule: string,
): string | undefined {
  if (!USER_CHOSE.test(message.handoff_prompt)) return undefined;
  const header = [
    `HAB で届いた次のメッセージを、利用者が事前に許可した送信元のルール「${rule}」により自動で受け付けました。利用者はこのメッセージを見ておらず、選んでもいません。`,
    "確認なしで行ってよいのは、内容を読むことと hab_reply で返信することだけです。ファイルの変更、コマンドの実行、HAB の返信以外の外部への送信、設定や認証情報の操作が必要なときは、実行せずに利用者に確認してください。必要なら、確認待ちであることを hab_reply で相手に伝えてください。",
  ].join("\n");
  return message.handoff_prompt.replace(USER_CHOSE, `${header}\n`);
}

/** One line of the notifier's audit file. Never the message text. */
export interface AutoAuditEvent {
  /**
   * auto_accept: written before the claim; if it cannot be written, nothing is accepted.
   * auto_handoff: how the handoff ended. auto_skip: a rule matched but the message waits.
   */
  event: "auto_accept" | "auto_handoff" | "auto_skip";
  rule: string;
  sender_id: string;
  from: string | null;
  message_id: string;
  thread_id: string;
  kind: string;
  reply: boolean;
  /** auto_accept: "accepting". auto_handoff: the notice state it ended in. auto_skip: why it waits. */
  result: string;
}

/** Above this size the file is moved to `<path>.1` (replacing an older one) and restarted. */
export const AUTO_AUDIT_BYTES = 1024 * 1024;

export class AutoAudit {
  readonly #path: string;
  readonly #now: () => number;
  readonly #maxBytes: number;
  readonly #rename: (from: string, to: string) => void;
  readonly #size: (path: string) => number | undefined;
  constructor(
    path: string,
    options: {
      now?: () => number;
      maxBytes?: number;
      rename: (from: string, to: string) => void;
      size: (path: string) => number | undefined;
    },
  ) {
    this.#path = path;
    this.#now = options.now ?? Date.now;
    this.#maxBytes = options.maxBytes ?? AUTO_AUDIT_BYTES;
    this.#rename = options.rename;
    this.#size = options.size;
  }
  write(event: AutoAuditEvent) {
    const line = `${JSON.stringify({ time: new Date(this.#now()).toISOString(), ...event })}\n`;
    const size = this.#size(this.#path);
    if (size !== undefined && size + Buffer.byteLength(line) > this.#maxBytes) {
      // Refuse an unsafe file before moving it aside, not only the fresh one after.
      ensurePrivateFile(this.#path, "insecure_audit_file");
      this.#rename(this.#path, `${this.#path}.1`);
    }
    appendPrivate(this.#path, line, "insecure_audit_file");
  }
}
