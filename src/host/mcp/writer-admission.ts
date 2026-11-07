/** Optional in-process writer scheduler. No IO, DB lock, MCP dependency or identity grant. */
export type WriterOperation = "submit" | "status" | "poll" | "ack" | "resolve";
export interface WriterAdmissionPolicy {
  max_individuals: number;
  max_waiting_per_individual: number;
  requests_per_window: number;
  window_ms: number;
  max_wait_ms: number;
}
/** Resolve a currently verified binding, never a name or ID supplied by an RPC argument. */
export type WriterIdentity = (
  context: unknown,
  operation: WriterOperation,
) => string | undefined;
type Failure =
  | "writer_forbidden"
  | "writer_rate_limited"
  | "writer_busy"
  | "writer_queue_expired"
  | "writer_aborted"
  | "writer_closed"
  | "writer_unavailable";
export class WriterAdmissionError extends Error {
  readonly code: Failure;
  constructor(code: Failure) {
    super(code);
    this.code = code;
  }
}
type Job = {
  context: unknown;
  operation: WriterOperation;
  signal: AbortSignal;
  deadline: number;
  action: () => unknown | Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
  cleanup: () => void;
};
type Individual = {
  credits: number;
  at: number;
  active: boolean;
  queue: Job[];
};
const operations = new Set(["submit", "status", "poll", "ack", "resolve"]);
export class WriterAdmission {
  readonly #policy: Readonly<WriterAdmissionPolicy>;
  readonly #identify: WriterIdentity;
  readonly #now: () => number;
  readonly #individuals = new Map<string, Individual>();
  readonly #ready: string[] = [];
  #active = false;
  #scheduled = false;
  #closed = false;
  #last: string | undefined;
  #clock = -1;
  constructor(
    policy: WriterAdmissionPolicy,
    identify: WriterIdentity = () => undefined,
    now: () => number = () => Math.floor(performance.now()),
  ) {
    try {
      for (const key of [
        "max_individuals",
        "max_waiting_per_individual",
        "requests_per_window",
        "window_ms",
        "max_wait_ms",
      ] as const)
        if (!Number.isSafeInteger(policy[key]) || policy[key] < 1)
          throw Error();
      if (
        policy.max_individuals > 256 ||
        policy.max_waiting_per_individual > 64 ||
        policy.max_individuals * policy.max_waiting_per_individual > 4096 ||
        policy.requests_per_window > 1000000 ||
        policy.window_ms > 3600000 ||
        policy.max_wait_ms > 30000 ||
        typeof identify !== "function" ||
        typeof now !== "function"
      )
        throw Error();
    } catch {
      throw Error("invalid_writer_admission_policy");
    }
    this.#policy = Object.freeze({
      max_individuals: policy.max_individuals,
      max_waiting_per_individual: policy.max_waiting_per_individual,
      requests_per_window: policy.requests_per_window,
      window_ms: policy.window_ms,
      max_wait_ms: policy.max_wait_ms,
    });
    this.#identify = identify;
    this.#now = now;
  }
  #time() {
    let now: number;
    try {
      now = this.#now();
    } catch {
      throw new WriterAdmissionError("writer_unavailable");
    }
    if (
      !Number.isSafeInteger(now) ||
      now < this.#clock ||
      now < 0 ||
      now > Number.MAX_SAFE_INTEGER - this.#policy.max_wait_ms
    )
      throw new WriterAdmissionError("writer_unavailable");
    this.#clock = now;
    return now;
  }
  #identity(context: unknown, operation: WriterOperation) {
    try {
      const id = this.#identify(context, operation);
      if (id && typeof id === "object" && "then" in id)
        void Promise.resolve(id).catch(() => {});
      if (
        typeof id !== "string" ||
        !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$(?![\s\S])/.test(id)
      )
        throw Error();
      return id;
    } catch {
      throw new WriterAdmissionError("writer_forbidden");
    }
  }
  #refill(entry: Individual, now: number) {
    const capacity = this.#policy.requests_per_window * this.#policy.window_ms;
    entry.credits = Math.min(
      capacity,
      entry.credits +
        Math.min(now - entry.at, this.#policy.window_ms) *
          this.#policy.requests_per_window,
    );
    entry.at = now;
    return entry.credits === capacity;
  }
  #collect(now: number) {
    for (const [id, entry] of this.#individuals) {
      const full = this.#refill(entry, now);
      if (full && !entry.active && !entry.queue.length)
        this.#individuals.delete(id);
    }
  }
  #removeReady(id: string) {
    const index = this.#ready.indexOf(id);
    if (index >= 0) this.#ready.splice(index, 1);
  }
  #schedule() {
    if (this.#scheduled || this.#closed) return;
    this.#scheduled = true;
    queueMicrotask(() => {
      this.#scheduled = false;
      this.#drain();
    });
  }
  /** All accepted attempts share one token bucket per verified individual, including retries. */
  run<T>(
    context: unknown,
    operation: WriterOperation,
    signal: AbortSignal,
    action: () => T | Promise<T>,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      try {
        if (this.#closed) throw new WriterAdmissionError("writer_closed");
        if (
          !operations.has(operation) ||
          typeof action !== "function" ||
          !(signal instanceof AbortSignal)
        )
          throw new WriterAdmissionError("writer_forbidden");
        if (signal.aborted) throw new WriterAdmissionError("writer_aborted");
        const now = this.#time(),
          id = this.#identity(context, operation);
        this.#collect(now);
        let entry = this.#individuals.get(id);
        if (!entry) {
          if (this.#individuals.size >= this.#policy.max_individuals)
            throw new WriterAdmissionError("writer_busy");
          entry = {
            credits: this.#policy.requests_per_window * this.#policy.window_ms,
            at: now,
            active: false,
            queue: [],
          };
          this.#individuals.set(id, entry);
        }
        this.#refill(entry, now);
        if (entry.credits < this.#policy.window_ms)
          throw new WriterAdmissionError("writer_rate_limited");
        if (entry.queue.length >= this.#policy.max_waiting_per_individual)
          throw new WriterAdmissionError("writer_busy");
        entry.credits -= this.#policy.window_ms;
        const selected = entry;
        const job: Job = {
          context,
          operation,
          signal,
          deadline: now + this.#policy.max_wait_ms,
          action,
          resolve: (value) => resolve(value as T),
          reject,
          cleanup: () => {
            clearTimeout(timer);
            signal.removeEventListener("abort", aborted);
          },
        };
        const remove = (code: Failure) => {
          const index = selected.queue.indexOf(job);
          if (index < 0) return; // An active action owns the slot until its actual settlement.
          selected.queue.splice(index, 1);
          job.cleanup();
          if (!selected.queue.length) this.#removeReady(id);
          reject(new WriterAdmissionError(code));
          this.#schedule();
        };
        const aborted = () => remove("writer_aborted");
        const timer = setTimeout(
          () => remove("writer_queue_expired"),
          this.#policy.max_wait_ms,
        );
        signal.addEventListener("abort", aborted, { once: true });
        selected.queue.push(job);
        if (!this.#ready.includes(id)) this.#ready.push(id);
        this.#schedule();
      } catch (error) {
        reject(error);
      }
    });
  }
  #drain() {
    if (this.#active || this.#closed) return;
    while (this.#ready.length) {
      // Do not immediately give the previous individual another turn while peers wait.
      if (this.#ready.length > 1 && this.#ready[0] === this.#last)
        this.#ready.push(this.#ready.shift()!);
      const id = this.#ready.shift()!,
        entry = this.#individuals.get(id)!;
      const job = entry.queue.shift()!;
      if (entry.queue.length) this.#ready.push(id);
      job.cleanup();
      try {
        if (job.signal.aborted)
          throw new WriterAdmissionError("writer_aborted");
        if (this.#time() >= job.deadline)
          throw new WriterAdmissionError("writer_queue_expired");
        if (this.#identity(job.context, job.operation) !== id)
          throw new WriterAdmissionError("writer_forbidden");
      } catch (error) {
        job.reject(error);
        continue;
      }
      this.#active = true;
      entry.active = true;
      this.#last = id;
      // Recheck at the actual callback boundary, after any caller microtasks.
      void Promise.resolve()
        .then(() => {
          if (job.signal.aborted)
            throw new WriterAdmissionError("writer_aborted");
          if (this.#time() >= job.deadline)
            throw new WriterAdmissionError("writer_queue_expired");
          if (this.#identity(job.context, job.operation) !== id)
            throw new WriterAdmissionError("writer_forbidden");
          if (this.#closed) throw new WriterAdmissionError("writer_closed");
          if (job.signal.aborted)
            throw new WriterAdmissionError("writer_aborted");
          if (this.#time() >= job.deadline)
            throw new WriterAdmissionError("writer_queue_expired");
          return job.action();
        })
        .then(job.resolve, job.reject)
        .finally(() => {
          entry.active = false;
          this.#active = false;
          this.#schedule();
        });
      return;
    }
  }
  /** Reject waiting work; active work retains its slot until it settles. */
  close() {
    if (this.#closed) return;
    this.#closed = true;
    this.#ready.length = 0;
    for (const entry of this.#individuals.values())
      for (const job of entry.queue.splice(0)) {
        job.cleanup();
        job.reject(new WriterAdmissionError("writer_closed"));
      }
  }
}
