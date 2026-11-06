import type { Adapter } from "./adapter.ts";
/** Explicit invocation only. Refresh the verified runner boundary each cycle. */
export async function workerLoop(options: {
  adapter: () => Promise<Adapter>;
  signal: AbortSignal;
  idleMs?: number;
  maxCycles?: number;
  wait?: (ms: number, signal: AbortSignal) => Promise<void>;
}) {
  const idle = options.idleMs ?? 1000;
  const limit = options.maxCycles ?? 100;
  if (
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 10000 ||
    !Number.isFinite(idle) ||
    idle < 100 ||
    idle > 60000
  )
    throw Error("invalid_worker_budget");
  const wait =
    options.wait ??
    ((ms, signal) =>
      new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(timer);
          signal.removeEventListener("abort", done);
          resolve();
        };
        const timer = setTimeout(done, ms);
        signal.addEventListener("abort", done, { once: true });
        if (signal.aborted) done();
      }));
  let cycles = 0;
  while (!options.signal.aborted && cycles < limit) {
    const adapter = await options.adapter();
    if (options.signal.aborted) break;
    await adapter.run(options.signal); // Errors preserve receipt and stop; no speculative retry.
    cycles++;
    if (!options.signal.aborted && cycles < limit)
      await wait(idle, options.signal);
  }
  return cycles;
}
