/**
 * A product-neutral AgentScreen: appends one JSON line per event to a file that the agent
 * product's own integration reads (for example a display-only message panel). The product
 * shows `display` in the bound session, sends the user's choice back with
 * `hab-notify decide`, and, on a `handoff` line, gives `prompt` to that same session.
 * Because the file cannot confirm a start, a handoff is reported as `queued`.
 */
import { INCOMING_CHOICES } from "../messaging/incoming-notice.ts";
import type {
  AgentScreen,
  HandoffResult,
  NoticeState,
  PeekedMessage,
} from "./contract.ts";
import { appendPrivate } from "./private-file.ts";

export class JsonlScreen implements AgentScreen {
  readonly target: string;
  readonly #path: string;
  readonly #now: () => number;
  constructor(path: string, target: string, now: () => number = Date.now) {
    this.#path = path;
    this.target = target;
    this.#now = now;
  }
  #write(event: Record<string, unknown>) {
    appendPrivate(
      this.#path,
      JSON.stringify({
        ...event,
        target: this.target,
        at: new Date(this.#now()).toISOString(),
      }) + "\n",
      "insecure_screen_file",
    );
  }
  async show(message: PeekedMessage) {
    this.#write({
      type: "notice",
      message_id: message.message_id,
      sender_id: message.sender_id,
      from: message.from,
      kind: message.kind,
      expires_at: message.expires_at,
      display: message.display,
      choices: INCOMING_CHOICES.map((item) => ({ ...item })),
    });
  }
  async handoff(message: PeekedMessage): Promise<HandoffResult> {
    this.#write({
      type: "handoff",
      message_id: message.message_id,
      sender_id: message.sender_id,
      thread_id: message.thread_id,
      prompt: message.handoff_prompt,
    });
    return "queued";
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
