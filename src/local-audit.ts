import {
  constants,
  closeSync,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
export const CATEGORIES = [
  "request",
  "auth_denied",
  "access_denied",
  "rate_limited",
  "resource_rejected",
  "tool_started",
  "tool_succeeded",
  "tool_error",
  "transport_error",
  "anomaly",
] as const;
export type Category = (typeof CATEGORIES)[number];
export interface Audit {
  record(category: Category, correlation: string): void;
}
export class LocalAudit implements Audit {
  private count = 0;
  private window = 0;
  private errors = 0;
  private readonly directory: string;
  private readonly maxBytes: number;
  private readonly now: () => number;
  private readonly write: typeof writeSync;
  constructor(
    directory: string,
    maxBytes = 262144,
    now = Date.now,
    write: typeof writeSync = writeSync,
  ) {
    this.directory = directory;
    this.maxBytes = maxBytes;
    this.now = now;
    this.write = write;
    if (maxBytes < 256 || maxBytes > 1048576)
      throw new Error("Invalid audit limit");
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const stat = lstatSync(directory);
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      stat.uid !== process.getuid?.() ||
      stat.mode & 0o077
    )
      throw new Error("Audit unavailable");
    this.record("request", "00000000-0000-4000-8000-000000000000");
  }
  record(category: Category, correlation: string): void {
    if (!CATEGORIES.includes(category) || !/^[a-f0-9-]{36}$/.test(correlation))
      throw new Error("Invalid audit event");
    const time = this.now();
    if (time - this.window > 60000) {
      this.window = time;
      this.count = 0;
      this.errors = 0;
    }
    this.count = Math.min(this.count + 1, 65535);
    if (
      [
        "auth_denied",
        "access_denied",
        "resource_rejected",
        "tool_error",
        "rate_limited",
      ].includes(category)
    )
      this.errors = Math.min(this.errors + 1, 65535);
    this.append(category, correlation, time);
    if (this.errors === 20) {
      this.errors++;
      this.append("anomaly", correlation, time);
    }
  }
  private append(category: Category, correlation: string, time: number) {
    try {
      const path = join(this.directory, "audit.jsonl");
      for (const name of readdirSync(this.directory)) {
        if (/^audit\.jsonl\.[12]$/.test(name)) {
          const file = join(this.directory, name),
            stat = lstatSync(file);
          if (
            !stat.isFile() ||
            stat.isSymbolicLink() ||
            stat.nlink !== 1 ||
            stat.uid !== process.getuid?.() ||
            stat.mode & 0o077
          )
            throw new Error("Audit unavailable");
          if (time - stat.mtimeMs > 86400000) unlinkSync(file);
        }
      }
      const fd = openSync(
        path,
        constants.O_APPEND |
          constants.O_CREAT |
          constants.O_WRONLY |
          constants.O_NOFOLLOW,
        0o600,
      );
      let rotate = false;
      try {
        const stat = fstatSync(fd);
        if (
          !stat.isFile() ||
          stat.nlink !== 1 ||
          stat.uid !== process.getuid?.() ||
          stat.mode & 0o077
        )
          throw new Error("Audit unavailable");
        const line = `${JSON.stringify({ time: new Date(time).toISOString(), category, correlation })}\n`;
        if (stat.size + Buffer.byteLength(line) > this.maxBytes) rotate = true;
        else if (this.write(fd, line) !== Buffer.byteLength(line))
          throw new Error("Audit unavailable");
      } finally {
        closeSync(fd);
      }
      if (rotate) {
        if (existsSync(`${path}.2`)) unlinkSync(`${path}.2`);
        if (existsSync(`${path}.1`)) renameSync(`${path}.1`, `${path}.2`);
        renameSync(path, `${path}.1`);
        this.append(category, correlation, time);
      }
    } catch {
      throw new Error("Audit unavailable");
    }
  }
}
export class MemoryAudit implements Audit {
  readonly counts = new Map<Category, number>();
  record(category: Category, correlation: string) {
    void correlation;
    this.counts.set(
      category,
      Math.min(65535, (this.counts.get(category) ?? 0) + 1),
    );
  }
}
