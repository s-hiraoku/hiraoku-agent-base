/** Compatibility entry point; implementation and type checking live in TypeScript. */
import { pathToFileURL } from "node:url";
import { runCli } from "./hab-admin.ts";
export { main } from "./hab-admin.ts";
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  runCli();
}
