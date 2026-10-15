import { pathToFileURL } from "node:url";
import { readRuntimeConfig } from "./runtime-config.ts";
import { startPingDiscovery } from "./ping-discovery.ts";
export async function pingDiscoveryMain() {
  if (process.argv.length !== 2 || !process.env.HAB_PING_DISCOVERY_CONFIG)
    throw Error("ping_discovery_config_required");
  const runner = await startPingDiscovery(
    readRuntimeConfig(process.env.HAB_PING_DISCOVERY_CONFIG),
  );
  const stop = () => {
    void runner.close().catch(() => {});
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  process.stdout.write("ping_discovery_ready\n");
  try {
    await runner.closed;
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  void pingDiscoveryMain().catch((error) => {
    process.stderr.write(
      error instanceof Error &&
        error.message === "ping_discovery_stop_uncertain"
        ? "ping_discovery_stop_uncertain\n"
        : "ping_discovery_rejected\n",
    );
    process.exitCode = 1;
  });
