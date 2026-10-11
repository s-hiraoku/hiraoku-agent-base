import { parentPort, workerData } from "node:worker_threads";
import { LocalAudit } from "./local-audit.ts";
try {
  if (Object.keys(process.env).length !== 0)
    throw new Error("Audit unavailable");
  const audit = new LocalAudit(workerData.directory);
  parentPort?.on("message", ({ id, event }) => {
    try {
      if (event.aggregate)
        audit.aggregate(
          event.aggregate.counts,
          event.aggregate.dropped,
          event.aggregate.saturated,
        );
      else audit.record(event.category, event.correlation);
      parentPort?.postMessage({ kind: "ack", id });
    } catch {
      parentPort?.postMessage({ kind: "failed" });
      parentPort?.close();
    }
  });
  parentPort?.postMessage({ kind: "ready" });
} catch {
  parentPort?.postMessage({ kind: "failed" });
  parentPort?.close();
}
