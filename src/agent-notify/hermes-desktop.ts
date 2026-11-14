/**
 * The Hermes Desktop screen (ADR-021). Hermes Desktop shows display-only "external
 * messages" in a saved conversation. It runs a configured reader command
 * (`external_messages.readers` in the profile config, paging `cursor-v1`) and shows each
 * event whose `stored_session_id` is that conversation. The card is outside the model
 * conversation, so showing it starts no model work.
 *
 * `HermesDesktopScreen.show` appends the notice to a private JSON Lines file.
 * `hermesDesktopPage` is that reader: it turns the file into the event pages Hermes
 * accepts. Nothing here talks to HAB or to Hermes over the network.
 *
 * Handing the request to the conversation after 対応する is not wired yet. `handoff`
 * returns `unsupported` and never falls back to another session.
 */
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import type {
  AgentScreen,
  HandoffResult,
  NoticeState,
  PeekedMessage,
} from "./contract.ts";

export interface HermesDesktopBinding {
  /** The saved Hermes conversation (session) ID shown in Desktop. */
  session_id: string;
  /** The Hermes profile that owns it, such as `local-lab`. */
  profile: string;
  /** Must equal the reader's `backend_namespace` in the profile config. */
  backend_namespace: string;
  /** Must equal the reader's `profile_scope` in the profile config. */
  profile_scope: string;
  /** The recipient's HAB agent ID. */
  receiver_id: string;
}

export const hermesDesktopTarget = (binding: HermesDesktopBinding) =>
  `hermes-desktop:${binding.profile}:${binding.session_id}`;

interface NoticeLine {
  type: "notice";
  message_id: string;
  sender_id: string;
  from: string | null;
  display: string;
  at: string;
}

export class HermesDesktopScreen implements AgentScreen {
  readonly target: string;
  readonly #path: string;
  readonly #now: () => number;
  constructor(
    path: string,
    binding: HermesDesktopBinding,
    now: () => number = Date.now,
  ) {
    this.#path = path;
    this.target = hermesDesktopTarget(binding);
    this.#now = now;
  }
  #write(line: Record<string, unknown>) {
    appendFileSync(
      this.#path,
      JSON.stringify({ ...line, at: new Date(this.#now()).toISOString() }) +
        "\n",
      { mode: 0o600 },
    );
  }
  async show(message: PeekedMessage) {
    this.#write({
      type: "notice",
      message_id: message.message_id,
      sender_id: message.sender_id,
      from: message.from,
      display: message.display,
    });
  }
  async handoff(): Promise<HandoffResult> {
    return "unsupported";
  }
  async report(message: PeekedMessage, state: NoticeState) {
    this.#write({
      type: "state",
      message_id: message.message_id,
      sender_id: message.sender_id,
      state,
    });
  }
}

/** The cursor is the number of notices already returned, as decimal digits. */
const cursorPattern = /^[0-9]{1,15}$/;

/**
 * One cursor-v1 page for the Hermes Desktop reader. Each displayed notice is one event;
 * showing a message again adds another event. Hermes needs `handoff_state` to be
 * `pending`, so a card stays as it was shown after the user decides.
 */
export function hermesDesktopPage(
  path: string,
  binding: HermesDesktopBinding,
  options: { after?: string; limit: number },
) {
  if (options.after !== undefined && !cursorPattern.test(options.after))
    throw new Error("invalid_cursor");
  if (!Number.isInteger(options.limit) || options.limit < 1)
    throw new Error("invalid_limit");
  const start = options.after === undefined ? 0 : Number(options.after);
  const notices = existsSync(path)
    ? readFileSync(path, "utf8")
        .split("\n")
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as { type?: unknown })
        .filter((line): line is NoticeLine => line.type === "notice")
    : [];
  const page = notices.slice(start, start + options.limit);
  const target = hermesDesktopTarget(binding);
  return {
    source: "external_agent",
    events: page.map((notice, index) => ({
      event_id: `${notice.sender_id}:${notice.message_id}:${start + index}`,
      source: "external_agent",
      format: "plain_text",
      sender_id: notice.sender_id,
      receiver_id: binding.receiver_id,
      message_id: notice.message_id,
      address: notice.from ?? notice.sender_id,
      backend_namespace: binding.backend_namespace,
      profile_scope: binding.profile_scope,
      owner_kind: "session",
      received_at: notice.at,
      text: notice.display,
      binding_id: target,
      binding_generation: 1,
      logical_target: target,
      stored_session_id: binding.session_id,
      handoff_state: "pending",
    })),
    next_cursor: String(start + page.length),
    has_more: start + page.length < notices.length,
  };
}
