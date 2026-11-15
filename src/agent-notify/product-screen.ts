/**
 * The shared part of the screens for agent products whose own window has no place for an
 * outside notice (Codex, Claude Code, ChatGPT connectors such as Dots). The notice is kept in
 * the same owner-only JSON Lines file as `JsonlScreen` writes, and an optional trusted
 * display command shows it (for example a desktop notification). Only the product-specific
 * handoff differs. The file never gets a `handoff` line: nothing that reads it may start work.
 */
import { INCOMING_CHOICES } from "../messaging/incoming-notice.ts";
import { runCommand } from "./command.ts";
import type { TrustedCommand } from "./command.ts";
import type {
  AgentScreen,
  HandoffResult,
  NoticeState,
  PeekedMessage,
} from "./contract.ts";
import { JsonlScreen } from "./jsonl-screen.ts";

export interface ProductScreenOptions {
  /** The owner-only notice file. */
  path: string;
  /** The one session this screen serves, such as `codex:<thread id>`. */
  target: string;
  /**
   * Optional: run once per notice and per state change, with one JSON object on stdin
   * (`type` is `notice` or `state`). A failed run leaves the notice to be shown again.
   */
  display_command?: TrustedCommand;
  /** Gives the user-approved request to the bound session. */
  handoff: (message: PeekedMessage) => Promise<HandoffResult>;
  now?: () => number;
}

export class ProductScreen implements AgentScreen {
  readonly target: string;
  readonly #file: JsonlScreen;
  readonly #display: TrustedCommand | undefined;
  readonly #handoff: (message: PeekedMessage) => Promise<HandoffResult>;
  constructor(options: ProductScreenOptions) {
    this.target = options.target;
    this.#file = new JsonlScreen(options.path, options.target, options.now);
    this.#display = options.display_command;
    this.#handoff = options.handoff;
  }
  async #run(event: Record<string, unknown>) {
    if (this.#display)
      await runCommand(
        this.#display,
        JSON.stringify({ ...event, target: this.target }),
      );
  }
  async show(message: PeekedMessage) {
    await this.#file.show(message);
    await this.#run({
      type: "notice",
      message_id: message.message_id,
      sender_id: message.sender_id,
      from: message.from,
      expires_at: message.expires_at,
      display: message.display,
      choices: INCOMING_CHOICES.map((item) => ({ ...item })),
    });
  }
  handoff(message: PeekedMessage): Promise<HandoffResult> {
    return this.#handoff(message);
  }
  async report(message: PeekedMessage, state: NoticeState) {
    await this.#file.report(message, state);
    await this.#run({
      type: "state",
      message_id: message.message_id,
      sender_id: message.sender_id,
      state,
    });
  }
}
