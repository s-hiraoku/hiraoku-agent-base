import { workerData, type MessagePort } from "node:worker_threads";
import {
  JetStreamRelay,
  type JetStreamRelayOptions,
} from "../packages/relay-nats/src/backend.ts";

type PumpCommand = "close" | { limit: number };
type PumpReply = { ok: true } | { ok: false; code: unknown };

const { port, signal, options } = workerData as {
  port: MessagePort;
  signal: SharedArrayBuffer;
  options: Omit<JetStreamRelayOptions, "authorization">;
};
const flag = new Int32Array(signal);
let backend: JetStreamRelay | undefined;
port.on("message", async (command: PumpCommand) => {
  let reply: PumpReply;
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
    reply = {
      ok: false,
      code:
        (error as { code?: unknown } | null | undefined)?.code ?? "pump_failed",
    };
  }
  port.postMessage(reply);
  Atomics.store(flag, 0, 1);
  Atomics.notify(flag, 0);
});
