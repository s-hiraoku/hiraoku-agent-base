import { pathToFileURL } from "node:url";
import { readRuntimeConfig } from "./runtime-config.ts";
import {
  inspectWorkerIdentity,
  workerIdentitySettings,
} from "./worker-identity.ts";
import { z } from "zod";
export async function workerIdentityMain() {
  if (!process.env.HAB_WORKER_IDENTITY_CONFIG) throw Error();
  const config = workerIdentitySettings(
    readRuntimeConfig(process.env.HAB_WORKER_IDENTITY_CONFIG),
  );
  if (process.argv[2] === "--check-config" && process.argv.length === 3) {
    process.stdout.write("worker_identity_config_valid\n");
    return;
  }
  if (process.argv.length !== 2) throw Error();
  let bytes = Buffer.alloc(0);
  const timer = setTimeout(
    () => process.stdin.destroy(Error("input_timeout")),
    3000,
  );
  try {
    for await (const chunk of process.stdin) {
      bytes = Buffer.concat([bytes, chunk]);
      if (bytes.length > 17000) throw Error();
    }
    const input = z
      .object({ authorization: z.string().max(16384) })
      .strict()
      .parse(JSON.parse(bytes.toString("utf8")));
    const result = await inspectWorkerIdentity(config, input.authorization);
    process.stdout.write(JSON.stringify(result) + "\n");
  } finally {
    clearTimeout(timer);
    bytes.fill(0);
  }
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  void workerIdentityMain().catch(() => {
    process.stderr.write("worker_identity_rejected\n");
    process.exitCode = 1;
  });
}
