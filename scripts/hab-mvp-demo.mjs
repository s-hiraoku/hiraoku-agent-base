/** Explicit one-shot synthetic MVP; no existing runtime or production configuration is loaded. */
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
  } catch {
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
