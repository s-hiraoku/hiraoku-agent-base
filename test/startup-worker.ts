import { parentPort, workerData } from "node:worker_threads";
import { Hub } from "../src/sqlite.ts";

if (!parentPort) throw Error("startup worker requires a parent port");
const port = parentPort;
const { path } = workerData as { path: string };
port.postMessage("ready");
port.once("message", () => {
  const hub = new Hub(path);
  hub.close();
  port.postMessage("opened");
});
