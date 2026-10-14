import { pathToFileURL } from "node:url";
import { readRuntimeConfig } from "./runtime-config.ts";
import { startPingRunner } from "./ping-runner.ts";
export async function pingRunnerMain() {
  if (
    process.argv.length !== 2 ||
    !process.env.HAB_PING_CONFIG ||
    !process.env.HAB_PING_DIRECTORY
  )
    throw Error("ping_runner_config_required");
  const runner = await startPingRunner(
    readRuntimeConfig(process.env.HAB_PING_CONFIG),
    process.env.HAB_PING_DIRECTORY,
  );
  const stop = () => {
    void runner.close().catch(() => {});
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  process.stdout.write("ping_runner_ready\n");
  try {
    await runner.closed;
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  void pingRunnerMain().catch((error) => {
    process.stderr.write(
      error instanceof Error && error.message === "ping_runner_stop_uncertain"
        ? "ping_runner_stop_uncertain\n"
        : "ping_runner_rejected\n",
    );
    process.exitCode = 1;
  });
