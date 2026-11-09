/** Internal clean-env child entry. The supervisor owns timeout and forced-stop evidence. */
import { pathToFileURL } from "node:url";
import { isAbsolute } from "node:path";
import { startExternalOwner } from "./external-owner.ts";
import type { ExternalOwnerOptions } from "./external-owner.ts";

const controller = new AbortController();
const abort = () => controller.abort();
process.once("disconnect", abort);
process.once("SIGTERM", abort);
process.once("SIGINT", abort);
process.on("message", message => {
  if (message && typeof message === "object" && "type" in message && message.type === "stop") abort();
});
const send = (message: object) => new Promise<void>(resolve => {
  if (!process.connected || !process.send) { resolve(); return; }
  process.send(message, () => resolve());
});
try {
  if (!process.connected || process.argv.length !== 3 || !isAbsolute(process.argv[2])) throw Error("owner_process_invalid");
  const factory = await import(pathToFileURL(process.argv[2]).href) as {
    createOwnerOptions(signal: AbortSignal): Promise<Omit<ExternalOwnerOptions, "ownerSignal">>;
  };
  if (typeof factory.createOwnerOptions !== "function" || controller.signal.aborted) throw Error("owner_process_invalid");
  const options = await factory.createOwnerOptions(controller.signal);
  if (controller.signal.aborted) throw Error("owner_process_stopping");
  const owner = await startExternalOwner({ ...options, ownerSignal: controller.signal });
  void owner.ready.then(result => send({ type: "ready", url: result.url }), () => {});
  await owner.completion;
  await send({ type: "stopped" });
  // A factory may leave handles behind. Confirm termination instead of waiting indefinitely.
  process.exit(0);
} catch {
  // Never serialize native errors, tokens, profile configuration or returned session objects.
  await send({ type: "failed" });
  process.exit(1);
}
