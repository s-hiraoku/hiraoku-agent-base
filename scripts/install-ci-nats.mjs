/** Compatibility entry point; implementation and type checking live in TypeScript. */
import { pathToFileURL } from "node:url";
import { runCli } from "./install-ci-nats.ts";
export { installCiNats } from "./install-ci-nats.ts";
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await runCli();
}
