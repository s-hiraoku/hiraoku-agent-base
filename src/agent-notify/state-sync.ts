/** Product-independent card state synchronization. This module performs no IO and never
 * executes an incoming message. Poll this separately from the immutable event cursor. */
import type { NoticeState, PeekedMessage } from "./contract.ts";
import { peekedMessageSchema } from "./contract.ts";

export interface NoticeStateSnapshot {
  sender_id: string;
  message_id: string;
  state: NoticeState;
  /** Durable monotonically increasing revision, not a wall-clock timestamp. */
  revision: number;
}
export interface NoticeStates {
  /** Exact connection/recipient/product-session binding of the decision store. */
  binding_id: string;
  states: NoticeStateSnapshot[];
}
const key = (value: { sender_id: string; message_id: string }) =>
  JSON.stringify([value.sender_id, value.message_id]);
const states = new Set<NoticeState>([
  "showing",
  "shown",
  "later",
  "declining",
  "declined",
  "accepting",
  "accept_waiting",
  "started",
  "queued",
  "unsupported",
  "unknown",
  "unavailable",
  "expired",
]);

/** A reusable UI-side projection for any product adapter (including a future Gemini
 * adapter). Pending button/network state belongs outside this projection and must never
 * mask newer authoritative state. Create a NEW projection when the binding changes.
 * Missing snapshots do not mean 'undecided'; keep known state and surface fetch failures. */
export class NoticeStateProjection {
  readonly #binding: string;
  readonly #notices = new Map<string, Readonly<PeekedMessage>>();
  readonly #states = new Map<string, Readonly<NoticeStateSnapshot>>();
  constructor(bindingId: string) {
    if (!bindingId) throw new Error("invalid_binding");
    this.#binding = bindingId;
  }
  /** Immutable payload repeat is harmless; changed payload for the same identity is not. */
  notice(bindingId: string, input: PeekedMessage): void {
    this.#checkBinding(bindingId);
    const value = peekedMessageSchema.parse(input);
    const id = key(value);
    const previous = this.#notices.get(id);
    if (previous && JSON.stringify(previous) !== JSON.stringify(value))
      throw new Error("notice_payload_conflict");
    this.#notices.set(id, Object.freeze(value));
  }
  /** Validate a whole response before applying it. Old polls cannot regress a newer POST. */
  merge(response: NoticeStates): void {
    this.#checkBinding(response.binding_id);
    const next = new Map(this.#states);
    for (const value of response.states) {
      if (
        !Number.isSafeInteger(value.revision) ||
        value.revision < 0 ||
        !value.sender_id ||
        !value.message_id ||
        !states.has(value.state)
      )
        throw new Error("invalid_notice_state");
      const id = key(value);
      const previous = next.get(id);
      if (previous && previous.revision > value.revision) continue;
      if (
        previous &&
        previous.revision === value.revision &&
        previous.state !== value.state
      )
        throw new Error("notice_state_conflict");
      next.set(id, Object.freeze({ ...value }));
    }
    this.#states.clear();
    for (const [id, value] of next) this.#states.set(id, value);
  }
  state(
    senderId: string,
    messageId: string,
  ): Readonly<NoticeStateSnapshot> | undefined {
    return this.#states.get(
      key({ sender_id: senderId, message_id: messageId }),
    );
  }
  #checkBinding(bindingId: string) {
    if (bindingId !== this.#binding) throw new Error("notices_target_mismatch");
  }
}
