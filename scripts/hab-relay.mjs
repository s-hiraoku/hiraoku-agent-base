/** Operator-selected local service. No defaults, credential generation, enrollment or worker. */
import { pathToFileURL } from "node:url";
import {
  startConfiguredLocalRelay,
  LocalRelayStartError,
} from "../src/relay-host/configured.ts";
export async function main(args = process.argv.slice(2)) {
  if (args.length !== 2 || args[0] !== "--config")
    throw new LocalRelayStartError("config_required");
  const abort = new AbortController();
  const stop = () => abort.abort();
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  let host;
  try {
    host = await startConfiguredLocalRelay(args[1]);
    if (!abort.signal.aborted) {
      process.stdout.write(
        JSON.stringify({
          state: "ready",
          url: host.url,
          ...(host.ingress_url
            ? { ingress_url: host.ingress_url, ingress_port: host.ingress_port }
            : {}),
        }) + "\n",
      );
      await new Promise((resolve) => {
        if (abort.signal.aborted) resolve();
        else abort.signal.addEventListener("abort", resolve, { once: true });
      });
    }
  } finally {
    await host?.close();
    process.removeListener("SIGTERM", stop);
    process.removeListener("SIGINT", stop);
  }
  process.stdout.write(JSON.stringify({ state: "stopped" }) + "\n");
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error) => {
    // Fixed reason codes and config field paths only; never values or file paths.
    const reason =
      error instanceof LocalRelayStartError
        ? ` reason=${error.reason}${error.fields.length ? ` fields=${error.fields.join(",")}` : ""}`
        : "";
    process.stderr.write(`local_relay_start_rejected${reason}\n`);
    process.exitCode = 1;
  });
}
