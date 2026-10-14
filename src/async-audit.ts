import { Worker } from "node:worker_threads";
import { CATEGORIES, type Audit, type Category } from "./local-audit.ts";

export interface AuditPort {
  postMessage(value: unknown): void;
  on(event: "message", listener: (value: unknown) => void): unknown;
  on(event: "error", listener: () => void): unknown;
  on(event: "exit", listener: (code: number) => void): unknown;
  terminate(): Promise<number>;
}
const MAX_COUNT = 65535;
/** One isolated writer, bounded acknowledged queue, fixed-memory rejection aggregation. */
export class AsyncAudit implements Audit {
  private readonly port: AuditPort;
  private termination?: Promise<number>;
  private readonly pending = new Map<
    number,
    { resolve(): void; reject(error: Error): void; timer: NodeJS.Timeout }
  >();
  private readonly counts = new Map<Category, number>();
  private dropped = 0;
  private saturated = false;
  private sequence = 0;
  private state: "starting" | "ready" | "failed" | "closed" = "starting";
  private readonly readiness: Promise<void>;
  private readyResolve!: () => void;
  private readyReject!: (error: Error) => void;
  private readonly timer: NodeJS.Timeout;
  private readonly options: {
    maxPending?: number;
    timeoutMs?: number;
    flushMs?: number;
    port?: AuditPort;
  };
  constructor(
    directory: string,
    options: {
      maxPending?: number;
      timeoutMs?: number;
      flushMs?: number;
      port?: AuditPort;
    } = {},
  ) {
    this.options = options;
    if (
      !Number.isSafeInteger(options.maxPending ?? 32) ||
      (options.maxPending ?? 32) < 1 ||
      (options.maxPending ?? 32) > 64 ||
      !Number.isSafeInteger(options.timeoutMs ?? 5000) ||
      (options.timeoutMs ?? 5000) < 1 ||
      (options.timeoutMs ?? 5000) > 5000 ||
      !Number.isSafeInteger(options.flushMs ?? 10000) ||
      (options.flushMs ?? 10000) < 10000 ||
      (options.flushMs ?? 10000) > 60000
    )
      throw new Error("Invalid audit limit");
    this.readiness = new Promise((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
    });
    void this.readiness.catch(() => {});
    this.port =
      options.port ??
      new Worker(
        new URL(
          import.meta.url.endsWith(".ts")
            ? "./audit-worker.ts"
            : "./audit-worker.js",
          import.meta.url,
        ),
        { workerData: { directory }, env: {}, execArgv: [] },
      );
    this.port.on("message", (value) => {
      if (!value || typeof value !== "object" || !("kind" in value)) {
        this.fail();
        return;
      }
      if (value.kind === "ready" && this.state === "starting") {
        this.state = "ready";
        this.readyResolve();
        return;
      }
      if (
        value.kind === "ack" &&
        "id" in value &&
        typeof value.id === "number"
      ) {
        const entry = this.pending.get(value.id);
        if (!entry) {
          this.fail();
          return;
        }
        clearTimeout(entry.timer);
        this.pending.delete(value.id);
        entry.resolve();
        return;
      }
      this.fail();
    });
    this.port.on("error", () => this.fail());
    this.port.on("exit", () => {
      if (this.state !== "closed") this.fail();
    });
    this.timer = setInterval(() => {
      void this.flush().catch(() => {});
    }, options.flushMs ?? 10000);
    this.timer.unref();
    const startup = setTimeout(() => {
      if (this.state === "starting") this.fail();
    }, options.timeoutMs ?? 5000);
    startup.unref();
    void this.readiness.then(
      () => clearTimeout(startup),
      () => clearTimeout(startup),
    );
  }
  ready(): Promise<void> {
    return this.readiness;
  }
  check(): void {
    if (this.state !== "ready") throw new Error("Audit unavailable");
  }
  snapshot() {
    return {
      state: this.state,
      pending: this.pending.size,
      dropped: this.dropped,
      saturated: this.saturated,
      counts: Object.fromEntries(this.counts),
    };
  }
  /** Suppressed/rejected events perform no filesystem or worker-message I/O. */
  note(category: Category): void {
    if (!CATEGORIES.includes(category)) throw new Error("Invalid audit event");
    const count = this.counts.get(category) ?? 0;
    if (count === MAX_COUNT || this.dropped === MAX_COUNT)
      this.saturated = true;
    this.counts.set(category, Math.min(MAX_COUNT, count + 1));
    this.dropped = Math.min(MAX_COUNT, this.dropped + 1);
  }
  async record(category: Category, correlation: string): Promise<void> {
    if (!CATEGORIES.includes(category) || !/^[a-f0-9-]{36}$/.test(correlation))
      throw new Error("Invalid audit event");
    return this.send({ category, correlation });
  }
  /** At most one aggregate write per cooldown, regardless of rejection volume. */
  private lastFlush = 0;
  async flush(now = Date.now()): Promise<void> {
    this.check();
    if (
      !this.dropped ||
      now - this.lastFlush < (this.options.flushMs ?? 10000) ||
      this.pending.size >= (this.options.maxPending ?? 32)
    )
      return;
    this.lastFlush = now;
    const counts = Object.fromEntries(this.counts),
      dropped = this.dropped,
      saturated = this.saturated;
    this.counts.clear();
    this.dropped = 0;
    this.saturated = false;
    try {
      await this.send({ aggregate: { counts, dropped, saturated } });
    } catch (error) {
      for (const [category, count] of Object.entries(counts)) {
        const total = (this.counts.get(category as Category) ?? 0) + count;
        if (total > MAX_COUNT) this.saturated = true;
        this.counts.set(category as Category, Math.min(MAX_COUNT, total));
      }
      if (this.dropped + dropped > MAX_COUNT) this.saturated = true;
      this.dropped = Math.min(MAX_COUNT, this.dropped + dropped);
      this.saturated ||= saturated;
      throw error;
    }
  }
  private send(event: object): Promise<void> {
    this.check();
    if (this.pending.size >= (this.options.maxPending ?? 32)) {
      this.note("resource_rejected");
      return Promise.reject(new Error("Audit unavailable"));
    }
    if (this.sequence >= Number.MAX_SAFE_INTEGER) {
      this.fail();
      return Promise.reject(new Error("Audit unavailable"));
    }
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => this.fail(),
        this.options.timeoutMs ?? 5000,
      );
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.port.postMessage({ id, event });
      } catch {
        this.fail();
      }
    });
  }
  private fail() {
    if (this.state === "failed" || this.state === "closed") return;
    this.state = "failed";
    clearInterval(this.timer);
    this.readyReject(new Error("Audit unavailable"));
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(new Error("Audit unavailable"));
    }
    this.pending.clear();
    void this.terminate().catch(() => {});
  }
  private terminate(): Promise<number> {
    if (!this.termination) {
      try {
        this.termination = this.port.terminate();
      } catch {
        this.termination = Promise.reject(
          new Error("Audit termination unconfirmed"),
        );
      }
    }
    return this.termination;
  }
  async close() {
    if (this.state !== "closed") this.fail();
    this.state = "closed";
    clearInterval(this.timer);
    await this.terminate().catch(() => {
      throw new Error("Audit termination unconfirmed");
    });
  }
}
