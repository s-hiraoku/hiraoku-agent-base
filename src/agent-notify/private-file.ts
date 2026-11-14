/**
 * Owner-only files for the notifier. A file that holds message text is opened without
 * following a link, created 0600, and refused when it already exists with group or other
 * access, because the creation mode never changes an existing file.
 */
import {
  closeSync,
  constants,
  fstatSync,
  ftruncateSync,
  openSync,
  writeSync,
} from "node:fs";
import { MessagingError } from "../messaging/delivery-service.ts";

function openPrivate(path: string, flags: number, code: string) {
  const fd = openSync(
    path,
    flags | constants.O_CREAT | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    const info = fstatSync(fd);
    if (!info.isFile() || (info.mode & 0o077) !== 0)
      throw new MessagingError(code);
  } catch (error) {
    closeSync(fd);
    throw error;
  }
  return fd;
}

/** Checks (and creates) an owner-only file, then closes it. */
export function ensurePrivateFile(path: string, code: string) {
  closeSync(openPrivate(path, constants.O_RDWR, code));
}

/** Appends `text` to an owner-only file; an unsafe existing file is refused first. */
export function appendPrivate(path: string, text: string, code: string) {
  const fd = openPrivate(path, constants.O_WRONLY | constants.O_APPEND, code);
  try {
    // A full disk or a file-size limit can write only part of a line without throwing.
    // Write the whole line or none of it, so a reader never meets a broken line.
    const size = fstatSync(fd).size;
    const bytes = Buffer.from(text, "utf8");
    try {
      for (let done = 0; done < bytes.length;) {
        const wrote = writeSync(fd, bytes, done, bytes.length - done);
        if (wrote <= 0) throw new MessagingError("screen_write_failed");
        done += wrote;
      }
    } catch (error) {
      ftruncateSync(fd, size);
      throw error;
    }
  } finally {
    closeSync(fd);
  }
}
