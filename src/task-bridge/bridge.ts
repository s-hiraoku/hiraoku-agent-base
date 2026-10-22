/** Explicit local calls only. One Task RPC per step; never claims or runs work. */
import { bridgeGuard } from "./authority.ts";
import { TaskBridgeError, keySchema, bindingSchema } from "./contract.ts";
import type {
  SourceKey,
  BridgeInbox,
  BridgeTasks,
  BridgeAuthorization,
  BridgeOperation,
} from "./contract.ts";
import type { SQLiteTaskBridgeJournal } from "./sqlite-journal.ts";
export class TaskBridge {
  readonly #journal: SQLiteTaskBridgeJournal;
  readonly #inbox: BridgeInbox;
  readonly #tasks: BridgeTasks;
  readonly #authorize: BridgeAuthorization;
  #running = false;
  constructor(
    journal: SQLiteTaskBridgeJournal,
    inbox: BridgeInbox,
    tasks: BridgeTasks,
    authorize: BridgeAuthorization = () => undefined,
  ) {
    if (
      typeof inbox?.withEntry !== "function" ||
      typeof tasks?.submit !== "function" ||
      typeof tasks?.get !== "function" ||
      typeof authorize !== "function" ||
      JSON.stringify(bindingSchema.parse(tasks.binding)) !==
        JSON.stringify(journal.binding)
    )
      throw new TaskBridgeError("invalid_bridge_composition");
    this.#journal = journal;
    this.#inbox = Object.freeze({ withEntry: inbox.withEntry.bind(inbox) });
    this.#tasks = Object.freeze({
      binding: Object.freeze(bindingSchema.parse(tasks.binding)),
      submit: tasks.submit.bind(tasks),
      get: tasks.get.bind(tasks),
    });
    this.#authorize = authorize;
  }
  #guard(context: unknown, operation: BridgeOperation, key: SourceKey) {
    return bridgeGuard(
      this.#authorize,
      context,
      operation,
      key,
      this.#journal.receiverId,
    );
  }

  accept(context: unknown, source: SourceKey) {
    const key = keySchema.parse(source),
      guard = this.#guard(context, "accept", key);
    return this.#inbox.withEntry(key.sender_id, key.message_id, (entry) =>
      this.#journal.prepare(entry, guard.actor, guard.check),
    );
  }
  async submitOnce(context: unknown, source: SourceKey, reconcile = false) {
    if (this.#running) throw new TaskBridgeError("bridge_busy");
    if (typeof reconcile !== "boolean")
      throw new TaskBridgeError("bridge_invalid_request");
    const key = keySchema.parse(source),
      guard = this.#guard(context, "submit", key);
    this.#running = true;
    try {
      const job = this.#journal.begin(key, reconcile, guard.check);
      if (!job) return this.#journal.get(key);
      try {
        guard.check();
        const task = await this.#tasks.submit(job.request_key);
        return this.#journal.confirm(job, task, guard.check);
      } catch {
        this.#journal.uncertain(job);
        return this.#journal.get(key);
      }
    } finally {
      this.#running = false;
    }
  }
  async observeOnce(context: unknown, source: SourceKey) {
    if (this.#running) throw new TaskBridgeError("bridge_busy");
    const key = keySchema.parse(source),
      guard = this.#guard(context, "observe", key),
      before = this.#journal.get(key);
    if (!before.task) throw new TaskBridgeError("bridge_not_linked");
    this.#running = true;
    try {
      guard.check();
      let task;
      try {
        task = await this.#tasks.get(before.task.id, before.request_key);
      } catch {
        throw new TaskBridgeError("bridge_task_unavailable");
      }
      return this.#journal.observe(key, task, guard.check);
    } finally {
      this.#running = false;
    }
  }
}
