/** Operator-selected local service. No defaults, credential generation, enrollment or worker. */
import { pathToFileURL } from "node:url";
import { HostStartError } from "../src/host/config.ts";
import { startHost } from "../src/host/start.ts";
export async function main(args = process.argv.slice(2)) {
  if (args.length !== 2 || args[0] !== "--config")
    throw new HostStartError("config_required");
  const abort = new AbortController();
  const stop = () => abort.abort();
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  let host;
  try {
    host = await startHost(args[1]);
    if (!abort.signal.aborted) {
      process.stdout.write(
        JSON.stringify({
          state: "ready",
          url: host.url,
          delivery_url: host.delivery_url,
          ...(host.ingress_url
            ? { ingress_url: host.ingress_url, ingress_port: host.ingress_port }
            : {}),
          ...(host.a2a_url ? { a2a_url: host.a2a_url } : {}),
        }) + "\n",
      );
      await new Promise<void>((resolve) => {
        if (abort.signal.aborted) resolve();
        else
          abort.signal.addEventListener("abort", () => resolve(), {
            once: true,
          });
      });
    }
  } finally {
    await host?.close();
    process.removeListener("SIGTERM", stop);
    process.removeListener("SIGINT", stop);
  }
  process.stdout.write(JSON.stringify({ state: "stopped" }) + "\n");
}
export function runCli() {
  main().catch((error) => {
    // Fixed reason codes and config field paths only; never values or file paths.
    const reason =
      error instanceof HostStartError
        ? ` reason=${error.reason}${error.fields.length ? ` fields=${error.fields.join(",")}` : ""}`
        : "";
    process.stderr.write(`host_start_rejected${reason}\n`);
    process.exitCode = 1;
  });
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  runCli();
}
