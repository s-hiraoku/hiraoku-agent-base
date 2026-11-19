/**
 * In-process signal for hab_inbox's wait (ADR-028). The host service calls `notify` with
 * the recipient of every message it accepted; a waiting hab_inbox wakes and reads its
 * inbox again through the normal authorized path. The signal carries no body, sender or
 * message ID, and a wake is only a hint: the waiter always re-reads to find out.
 *
 * One waiter per agent: a newer wait for the same agent ends the older one, so a client
 * that retries cannot pile up held requests.
 */
export type InboxWake = "arrived" | "timeout" | "superseded" | "aborted";
type Waiter = { finish: (wake: InboxWake) => void };
export class InboxArrivals {
  readonly #waiters = new Map<string, Waiter>();
  /** A message for `recipientId` was accepted. Wakes after the current call stack, i.e. after the commit. */
  notify(recipientId: string) {
    const waiter = this.#waiters.get(recipientId);
    if (waiter) setImmediate(() => waiter.finish("arrived"));
  }
  /** Waits until a message for `agentId` is accepted, `ms` passes, a newer wait starts or `signal` aborts. */
  wait(agentId: string, ms: number, signal?: AbortSignal): Promise<InboxWake> {
    this.#waiters.get(agentId)?.finish("superseded");
    if (signal?.aborted) return Promise.resolve("aborted");
    return new Promise((resolve) => {
      let done = false;
      const waiter: Waiter = {
        finish: (wake) => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
          if (this.#waiters.get(agentId) === waiter)
            this.#waiters.delete(agentId);
          resolve(wake);
        },
      };
      const onAbort = () => waiter.finish("aborted");
      const timer = setTimeout(() => waiter.finish("timeout"), Math.max(0, ms));
      signal?.addEventListener("abort", onAbort, { once: true });
      this.#waiters.set(agentId, waiter);
    });
  }
  /** Ends the open wait for `agentId`, if any, as superseded. Returns whether there was one. */
  supersede(agentId: string): boolean {
    const waiter = this.#waiters.get(agentId);
    waiter?.finish("superseded");
    return waiter !== undefined;
  }
  /** How many waits are open, for tests and operators. */
  get waiting() {
    return this.#waiters.size;
  }
}
