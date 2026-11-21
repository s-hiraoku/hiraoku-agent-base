import {
  closeSync,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
  constants,
} from "node:fs";
import { resolve } from "node:path";

/** Explicit operator-selected private JSON, never .env, credential discovery or fallback. */
/** The largest private config file the host reads; anything bigger is refused whole. */
export const RUNTIME_CONFIG_MAX_BYTES = 65536;
export function readRuntimeConfig(path: string): unknown {
  let fd: number | undefined;
  try {
    const absolute = resolve(path);
    if (
      !absolute.endsWith(".local.json") ||
      realpathSync(absolute) !== absolute
    )
      throw Error();
    const before = lstatSync(absolute);
    if (
      !before.isFile() ||
      before.uid !== process.getuid?.() ||
      before.mode & 0o077 ||
      before.size > RUNTIME_CONFIG_MAX_BYTES
    )
      throw Error();
    fd = openSync(absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
    const opened = fstatSync(fd);
    const buffer = Buffer.alloc(RUNTIME_CONFIG_MAX_BYTES + 1);
    const length = readSync(fd, buffer, 0, buffer.length, 0);
    const data = buffer.subarray(0, length).toString("utf8");
    const after = lstatSync(absolute);
    if (
      Buffer.byteLength(data) > RUNTIME_CONFIG_MAX_BYTES ||
      [opened, after].some(
        (value) =>
          value.dev !== before.dev ||
          value.ino !== before.ino ||
          value.ctimeMs !== before.ctimeMs ||
          value.size !== before.size,
      )
    )
      throw Error();
    return JSON.parse(data);
  } catch {
    throw Error("runtime_config_file_rejected");
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
