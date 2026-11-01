import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join } from "node:path";
import { parseArgs } from "node:util";

const release = JSON.parse(
  readFileSync(new URL("./nats-server-pins.json", import.meta.url), "utf8"),
);

export class NatsInputError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

function absoluteCandidate(path) {
  if (typeof path !== "string" || !isAbsolute(path) || path.includes("\0"))
    throw new NatsInputError("invalid_nats_server_path");
}

export function parseLabOptions(args) {
  let parsed;
  try {
    parsed = parseArgs({
      args,
      options: {
        full: { type: "boolean" },
        release: { type: "boolean" },
        "nats-server": { type: "string" },
      },
      allowPositionals: false,
      strict: true,
      tokens: true,
    });
  } catch {
    throw new NatsInputError("invalid_lab_arguments");
  }
  const seen = new Set();
  for (const token of parsed.tokens) {
    if (token.kind !== "option" || seen.has(token.name))
      throw new NatsInputError("invalid_lab_arguments");
    seen.add(token.name);
  }
  const natsServer = parsed.values["nats-server"];
  if (natsServer !== undefined) absoluteCandidate(natsServer);
  const releaseRequested = parsed.values.release ?? false;
  return {
    full: (parsed.values.full ?? false) || releaseRequested,
    release: releaseRequested,
    natsServer,
  };
}

export function selectNatsPin(
  platform = process.platform,
  arch = process.arch,
) {
  const key = `${platform}-${arch}`;
  const pin = release.platforms[key];
  if (!pin) throw new NatsInputError("unsupported_nats_platform");
  return Object.freeze({ version: release.version, platform: key, ...pin });
}

function verifiedBytes(sourcePath, pin) {
  absoluteCandidate(sourcePath);
  let fd;
  try {
    fd = openSync(
      sourcePath,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    const info = fstatSync(fd);
    if (!info.isFile()) throw new NatsInputError("nats_source_not_regular");
    if (info.size !== pin.binary_bytes)
      throw new NatsInputError("nats_binary_size_mismatch");
    const bytes = Buffer.alloc(pin.binary_bytes);
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (count === 0) throw new NatsInputError("nats_source_changed");
      offset += count;
    }
    if (fstatSync(fd).size !== bytes.length)
      throw new NatsInputError("nats_source_changed");
    const digest = createHash("sha256").update(bytes).digest("hex");
    if (digest !== pin.binary_sha256)
      throw new NatsInputError("nats_binary_sha256_mismatch");
    return bytes;
  } catch (error) {
    if (error instanceof NatsInputError) throw error;
    throw new NatsInputError("nats_source_unreadable");
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export function stagePinnedBytes(sourcePath, scratch, trustedPin) {
  const bytes = verifiedBytes(sourcePath, trustedPin);
  let fixtureCwd;
  try {
    fixtureCwd = mkdtempSync(join(scratch, "nats-input-"));
    const bin = join(fixtureCwd, "bin");
    mkdirSync(bin, { mode: 0o700 });
    const stagedPath = join(bin, "nats-server");
    const fd = openSync(stagedPath, "wx", 0o500);
    try {
      writeFileSync(fd, bytes);
      fchmodSync(fd, 0o500);
    } finally {
      closeSync(fd);
    }
    return Object.freeze({
      stagedPath,
      fixtureCwd,
      evidence: Object.freeze({
        state: "verified-input",
        version: trustedPin.version,
        platform: trustedPin.platform,
        archive_url: trustedPin.url,
        archive_sha256: trustedPin.archive_sha256,
        binary_sha256: trustedPin.binary_sha256,
        binary_bytes: trustedPin.binary_bytes,
        source_path: sourcePath,
        staged_path: stagedPath,
        fixture_cwd: fixtureCwd,
        backend_executed: false,
      }),
    });
  } catch {
    if (fixtureCwd) rmSync(fixtureCwd, { recursive: true, force: true });
    throw new NatsInputError("nats_staging_failed");
  }
}

export function prepareNatsServer(sourcePath, scratch) {
  return stagePinnedBytes(sourcePath, scratch, selectNatsPin());
}
