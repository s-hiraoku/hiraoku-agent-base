import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { setTimeout } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import process from "node:process";

const installer = fileURLToPath(
  new URL("../packages/relay-nats/scripts/install-server.mjs", import.meta.url),
);
const transientHttpError =
  /^Error: official server download failed (408|429|500|502|503|504)\r?$/m;

export type InstallerResult = Pick<SpawnSyncReturns<string>, "status"> &
  Partial<
    Pick<SpawnSyncReturns<string>, "stdout" | "stderr" | "error" | "signal">
  >;

class InstallerError extends Error {
  override readonly cause: InstallerResult;
  constructor(result: InstallerResult) {
    super("pinned NATS installation failed", { cause: result });
    this.cause = result;
  }
}

// Keep the pinned installer as the only downloader and integrity authority.
export async function installCiNats(
  attempt: () => InstallerResult = () =>
    spawnSync(process.execPath, [installer], {
      encoding: "utf8",
      maxBuffer: 64 * 1024,
    }),
  wait: (milliseconds: number) => Promise<unknown> = setTimeout,
  report: (message: string) => unknown = (message) =>
    process.stderr.write(message),
) {
  for (let index = 0; index < 4; index += 1) {
    const result = attempt();
    if (!result.error && result.status === 0) return result.stdout ?? "";
    if (
      result.error ||
      result.signal ||
      index === 3 ||
      !transientHttpError.test(result.stderr ?? "")
    ) {
      throw new InstallerError(result);
    }
    const delay = 1000 * 2 ** index;
    report(`NATS download temporarily unavailable; retrying in ${delay}ms\n`);
    await wait(delay);
  }
  throw Error("NATS installation attempts exhausted");
}

export async function runCli() {
  try {
    if (process.argv.length !== 2) throw Error("no arguments accepted");
    process.stdout.write(await installCiNats());
  } catch (error) {
    process.stderr.write(
      error instanceof InstallerError
        ? error.cause.stderr || `${error.cause.error ?? error.message}\n`
        : `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  await runCli();
}
