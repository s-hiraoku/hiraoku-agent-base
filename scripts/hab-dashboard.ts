import { pathToFileURL } from "node:url";
import { startDashboard } from "../src/admin/server.ts";
import { hostAdminErrorCode } from "../src/host/admin.ts";

export async function main(args = process.argv.slice(2)) {
  const [option, configPath, mode] = args;
  if (
    option !== "--config" ||
    !configPath ||
    args.length > 3 ||
    (mode !== undefined && mode !== "--operator")
  ) {
    process.stderr.write(
      "使い方: npm run hab:dashboard -- --config <host-config> [--operator]\n",
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
    dashboard = await startDashboard(configPath, {
      operator: mode === "--operator",
    });
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
  main().catch((error) => {
    const detail =
      hostAdminErrorCode(error) === "operator_mail_not_configured"
        ? " operator_mail_not_configured"
        : "";
    process.stderr.write("dashboard_start_failed" + detail + "\n");
    process.exitCode = 1;
  });
}
