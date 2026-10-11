import { pathToFileURL } from "node:url";
import { readRuntimeConfig } from "./runtime-config.ts";
import { prepareReadbackFixture } from "./readback-fixture.ts";
export function readbackFixtureMain() {
  if (
    process.argv.length !== 2 ||
    !process.env.HAB_READBACK_CONFIG ||
    !process.env.HAB_READBACK_DIRECTORY
  )
    throw Error();
  process.umask(0o077);
  const result = prepareReadbackFixture(
    process.env.HAB_READBACK_DIRECTORY,
    readRuntimeConfig(process.env.HAB_READBACK_CONFIG),
  );
  process.stdout.write(
    JSON.stringify({
      id: result.id,
      state: result.state,
      result: result.result,
      synthetic: true,
    }) + "\n",
  );
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    readbackFixtureMain();
  } catch {
    process.stderr.write("readback_fixture_rejected\n");
    process.exitCode = 1;
  }
}
