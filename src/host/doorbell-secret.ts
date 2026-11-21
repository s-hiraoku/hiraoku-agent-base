import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readFileSync,
} from "node:fs";

/**
 * Read an operator doorbell's secret (ADR-029) from its own file: a regular file, not a
 * link, owner-only, at most 1 KiB. The config and registration take the file path.
 */
export function readDoorbellSecretFile(path: string): string {
  try {
    const fd = openSync(
      path,
      // O_NONBLOCK: a FIFO with no writer must be refused, not hang the caller.
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const info = fstatSync(fd);
      if (!info.isFile() || (info.mode & 0o077) !== 0 || info.size > 1024)
        throw Error();
      return readFileSync(fd, "utf8").trim();
    } finally {
      closeSync(fd);
    }
  } catch {
    throw Error("unsafe_doorbell_secret");
  }
}
