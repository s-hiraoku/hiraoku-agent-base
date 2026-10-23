/** Local durable handoff only; never calls Task Engine or sends a network request. */
import type { ReplyAdmission } from "../adapter-policy/contract.ts";
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
export type TaskReplyJournal = Pick<
  SQLiteTaskBridgeJournal,
  "receiverId" | "prepareReply" | "handoffReply"
>;
export class TaskReplies {
  readonly #journal: TaskReplyJournal;
  readonly #enqueue: BridgeReplyOutbox["enqueueGuarded"];
  readonly #authorize: BridgeAuthorization;
  readonly #admit?: ReplyAdmission["withReply"];
  constructor(
    journal: TaskReplyJournal,
    outbox: BridgeReplyOutbox,
    authorize: BridgeAuthorization = () => undefined,
    admission?: ReplyAdmission,
  ) {
    if (
      outbox?.agentId !== journal.receiverId ||
      typeof outbox?.enqueueGuarded !== "function" ||
      typeof authorize !== "function" ||
      (admission !== undefined &&
        (admission.agentId !== journal.receiverId ||
          typeof admission.withReply !== "function"))
    )
      throw new TaskBridgeError("invalid_bridge_composition");
    this.#journal = journal;
    this.#enqueue = outbox.enqueueGuarded.bind(outbox);
    this.#authorize = authorize;
    this.#admit = admission?.withReply.bind(admission);
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
      (message, check) => {
        const enqueue = () => this.#enqueue(message, check);
        return this.#admit
          ? this.#admit(
              {
                ...guard.key,
                recipient_id: this.#journal.receiverId,
                thread_id: message.thread_id,
                kind: "execution_request",
              },
              message,
              check,
              enqueue,
            )
          : enqueue();
      },
      guard.check,
    );
  }
}
