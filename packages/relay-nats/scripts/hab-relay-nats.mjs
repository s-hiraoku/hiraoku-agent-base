import { pathToFileURL } from "node:url";
import { startConfiguredJetStreamRelay } from "../src/configured.ts";
import { LocalRelayStartError } from "../../../src/relay-host/configured.ts";

export async function main(args = process.argv.slice(2)) {
  if (
    args.length !== 4 ||
    args[0] !== "--config" ||
    args[2] !== "--jetstream-config"
  )
    throw new LocalRelayStartError("jetstream_config_required");
  const abort = new AbortController();
  const stop = () => abort.abort();
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  let host;
  try {
    host = await startConfiguredJetStreamRelay(args[1], args[3]);
    if (!abort.signal.aborted) {
      process.stdout.write(
        JSON.stringify({ state: "ready", url: host.url }) + "\n",
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
    const reason =
      error instanceof LocalRelayStartError
        ? error.reason
        : "jetstream_start_failed";
    process.stderr.write(`local_relay_start_rejected reason=${reason}\n`);
    process.exitCode = 1;
  });
}
