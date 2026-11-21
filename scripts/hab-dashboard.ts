import { pathToFileURL } from "node:url";
import { startDashboard } from "../src/admin/server.ts";

export async function main(args = process.argv.slice(2)) {
  if (args.length !== 2 || args[0] !== "--config" || !args[1]) {
    process.stderr.write(
      "使い方: npm run hab:dashboard -- --config <host-config>\n",
    );
    process.exitCode = 2;
    return;
  }

  const abort = new AbortController();
  const stop = () => abort.abort();
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  let dashboard;
  try {
    dashboard = await startDashboard(args[1]);
    if (abort.signal.aborted) return;
    process.stdout.write(dashboard.launcherPath + "\n");
    await new Promise<void>((resolve) => {
      abort.signal.addEventListener("abort", () => resolve(), { once: true });
    });
  } finally {
    process.removeListener("SIGTERM", stop);
    process.removeListener("SIGINT", stop);
    await dashboard?.close();
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch(() => {
    process.stderr.write("dashboard_start_failed\n");
    process.exitCode = 1;
  });
}
