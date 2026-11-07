import { workerData } from "node:worker_threads";
import { JetStreamRelay } from "../packages/relay-nats/src/backend.ts";

const { port, signal, options } = workerData;
const flag = new Int32Array(signal);
let backend;
port.on("message", async (command) => {
  let reply;
  try {
    if (command === "close") {
      await backend?.close();
      backend = undefined;
      reply = { ok: true };
    } else {
      backend ??= await JetStreamRelay.open({
        ...options,
        authorization: { authorize: () => undefined },
      });
      await backend.pumpOnce(command.limit);
      reply = { ok: true };
    }
  } catch (error) {
    reply = { ok: false, code: error?.code ?? "pump_failed" };
  }
  port.postMessage(reply);
  Atomics.store(flag, 0, 1);
  Atomics.notify(flag, 0);
});
