/** Local durable handoff only; never calls Task Engine or sends a network request. */
import { TaskBridgeError, keySchema } from "./contract.ts";
import type { BridgeAuthorization, SourceKey } from "./contract.ts";
import { bridgeGuard } from "./authority.ts";
import { replyKindSchema } from "./reply-contract.ts";
import type { ReplyKind } from "./reply-contract.ts";
import type { SQLiteTaskBridgeJournal } from "./sqlite-journal.ts";
import type { OutboxRecord } from "../relay/sender.ts";
export interface BridgeReplyOutbox {
  readonly agentId: string;
  enqueueGuarded(input: unknown, guard: () => void): OutboxRecord;
}
export class TaskReplies {
  readonly #journal: SQLiteTaskBridgeJournal;
  readonly #enqueue: BridgeReplyOutbox["enqueueGuarded"];
  readonly #authorize: BridgeAuthorization;
  constructor(
    journal: SQLiteTaskBridgeJournal,
    outbox: BridgeReplyOutbox,
    authorize: BridgeAuthorization = () => undefined,
  ) {
    if (
      outbox?.agentId !== journal.receiverId ||
      typeof outbox?.enqueueGuarded !== "function" ||
      typeof authorize !== "function"
    )
      throw new TaskBridgeError("invalid_bridge_composition");
    this.#journal = journal;
    this.#enqueue = outbox.enqueueGuarded.bind(outbox);
    this.#authorize = authorize;
  }
  #guard(context: unknown, source: SourceKey) {
    const key = keySchema.parse(source);
    return {
      key,
      ...bridgeGuard(
        this.#authorize,
        context,
        "reply",
        key,
        this.#journal.receiverId,
      ),
    };
  }
  prepare(context: unknown, source: SourceKey, kind: ReplyKind) {
    const guard = this.#guard(context, source);
    return this.#journal.prepareReply(
      guard.key,
      replyKindSchema.parse(kind),
      guard.check,
    );
  }
  enqueueOnce(context: unknown, source: SourceKey, kind: ReplyKind) {
    const guard = this.#guard(context, source);
    return this.#journal.handoffReply(
      guard.key,
      replyKindSchema.parse(kind),
      (message, check) => this.#enqueue(message, check),
      guard.check,
    );
  }
}
