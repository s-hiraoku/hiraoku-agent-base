import { spawnSync } from "node:child_process";
import { setTimeout } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import process from "node:process";

const installer = fileURLToPath(
  new URL("../packages/relay-nats/scripts/install-server.mjs", import.meta.url),
);
const transientHttpError =
  /^Error: official server download failed (408|429|500|502|503|504)\r?$/m;
const transientDownloadError = (stderr = "") =>
  transientHttpError.test(stderr) ||
  (/\bTypeError: fetch failed\b/.test(stderr) &&
    /\bcode:\s*['"]ERR_HTTP2_STREAM_ERROR['"]/.test(stderr) &&
    /\bhttp2ErrorCode:\s*7\b/.test(stderr));

// Keep the pinned installer as the only downloader and integrity authority.
export async function installCiNats(
  attempt = () =>
    spawnSync(process.execPath, [installer], {
      encoding: "utf8",
      maxBuffer: 64 * 1024,
    }),
  wait = setTimeout,
  report = (message) => process.stderr.write(message),
) {
  for (let index = 0; index < 4; index += 1) {
    const result = attempt();
    if (!result.error && result.status === 0) return result.stdout;
    if (
      result.error ||
      result.signal ||
      index === 3 ||
      !transientDownloadError(result.stderr)
    ) {
      throw Error("pinned NATS installation failed", { cause: result });
    }
    const delay = 1000 * 2 ** index;
    report(`NATS download temporarily unavailable; retrying in ${delay}ms\n`);
    await wait(delay);
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    if (process.argv.length !== 2) throw Error("no arguments accepted");
    process.stdout.write(await installCiNats());
  } catch (error) {
    process.stderr.write(
      error.cause?.stderr || `${error.cause?.error ?? error.message}\n`,
    );
    process.exitCode = 1;
  }
}
