import { parentPort, workerData } from "node:worker_threads";
import { Hub } from "../src/sqlite.ts";
import type { Principal } from "../src/types.ts";

if (!parentPort) throw Error("claim worker requires a parent port");
const port = parentPort;
const { path, principal } = workerData as {
  path: string;
  principal: Principal;
};
const h = new Hub(path);
port.postMessage("ready");
port.once("message", async () => {
  try {
    port.postMessage(await h.claim(principal, {}));
  } finally {
    h.close();
  }
});
