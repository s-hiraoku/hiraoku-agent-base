/** Explicit one-shot synthetic MVP; no existing runtime or production configuration is loaded. */
import { writeFileSync } from "node:fs";
import { runLocalMvp } from "./lib/local-mvp.mjs";
if (process.argv.length !== 3 || process.argv[2] !== "--simulate") {
  process.stderr.write("Usage: node scripts/hab-mvp-demo.mjs --simulate\n");
  process.exitCode = 2;
} else {
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  const deadline = setTimeout(stop, 30000);
  deadline.unref();
  try {
    const report = await runLocalMvp(controller.signal);
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  } catch (error) {
    const failureReportPath = process.env.HAB_MVP_FAILURE_REPORT_PATH;
    if (failureReportPath) {
      const progress = error?.hab_mvp_progress ?? {
        passed_stages: [],
        failed_stage: null,
        total_stages: 13,
      };
      try {
        writeFileSync(
          failureReportPath,
          JSON.stringify(
            {
              scope: "synthetic-loopback-mvp",
              status: "failed",
              production_connected: false,
              passed_stages: progress.passed_stages,
              failed_stage: progress.failed_stage,
              total_stages: progress.total_stages,
              error_name: error?.name ?? "Error",
              error_code: error?.code ?? null,
            },
            null,
            2,
          ) + "\n",
          "utf8",
        );
      } catch {
        // Keep stderr contract intact even if failure report path is unwritable.
      }
    }
    process.stderr.write(
      "local_mvp_failed; no production connection attempted\n",
    );
    process.exitCode = 1;
  } finally {
    clearTimeout(deadline);
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
  }
}
