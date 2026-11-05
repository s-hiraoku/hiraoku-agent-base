import {
  cpSync,
  mkdirSync,
  readdirSync,
  lstatSync,
  readFileSync,
  writeFileSync,
  existsSync,
  chmodSync,
} from "node:fs";
import { resolve, join, isAbsolute, relative, sep } from "node:path";
import { sha256 } from "../../scripts/lib/p7-provenance.mjs";

export const requiredFiles = [
  "fixture.json",
  "broker.conf",
  "host/owner.sqlite",
  "host/registry.sqlite",
  "host/relay.sqlite",
  "host/jetstream-journal.sqlite",
  "host/service-extension.local.json",
  "host/volume.local.json",
  ...[
    "a2a",
    "engine",
    "bridge",
    "submission-receipts",
    "inbox-a",
    "inbox-b",
    "outbox-a",
    "outbox-b",
  ].map((n) => `app/${n}.sqlite`),
];
function outside(root, target) {
  const value = relative(resolve(root), resolve(target));
  return value === ".." || value.startsWith(".." + sep);
}
function assertRoot(root) {
  const info = lstatSync(root);
  if (!info.isDirectory() || info.isSymbolicLink())
    throw Error("P7 image root must be a regular directory");
  return info;
}
function safePath(path) {
  if (
    typeof path !== "string" ||
    !path ||
    isAbsolute(path) ||
    path.includes("\\") ||
    path.split("/").some((p) => !p || p === "." || p === "..")
  )
    throw Error("P7 unsafe image path");
}
function inventory(root, prefix = "") {
  return readdirSync(join(root, prefix), { withFileTypes: true })
    .flatMap((entry) => {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      safePath(path);
      const info = lstatSync(join(root, path));
      if (info.isSymbolicLink()) throw Error("P7 image symlink rejected");
      if (info.isDirectory()) return inventory(root, path);
      if (!info.isFile() || info.nlink !== 1)
        throw Error("P7 image nonregular file rejected");
      return [
        {
          path,
          bytes: info.size,
          mode: info.mode & 0o777,
          sha256: sha256(readFileSync(join(root, path))),
        },
      ];
    })
    .sort((a, b) => a.path.localeCompare(b.path));
}
function directories(root, prefix = "") {
  return readdirSync(join(root, prefix), { withFileTypes: true })
    .flatMap((entry) => {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      const info = lstatSync(join(root, path));
      if (info.isSymbolicLink()) throw Error("P7 image symlink rejected");
      return info.isDirectory()
        ? [{ path, mode: info.mode & 0o777 }, ...directories(root, path)]
        : [];
    })
    .sort((a, b) => a.path.localeCompare(b.path));
}
function copyImage(source, target, manifest) {
  mkdirSync(target, { mode: manifest.root_mode });
  for (const name of readdirSync(source))
    cpSync(join(source, name), join(target, name), {
      recursive: true,
      errorOnExist: true,
      force: false,
    });
  chmodSync(target, manifest.root_mode);
  for (const entry of manifest.directories)
    chmodSync(join(target, entry.path), entry.mode);
}
export function validateImage(root, manifest) {
  assertRoot(root);
  if (
    manifest?.version !== 1 ||
    manifest.root_mode !== 0o700 ||
    !Array.isArray(manifest.files) ||
    !Array.isArray(manifest.directories)
  )
    throw Error("P7 invalid image manifest");
  for (const entry of manifest.directories) {
    safePath(entry.path);
    if (!Number.isInteger(entry.mode) || entry.mode < 0 || entry.mode > 0o777)
      throw Error("P7 invalid image directory mode");
  }
  if (
    new Set(manifest.directories.map((entry) => entry.path)).size !==
    manifest.directories.length
  )
    throw Error("P7 duplicate image directory");
  if (
    (lstatSync(root).mode & 0o777) !== manifest.root_mode ||
    JSON.stringify(directories(root)) !== JSON.stringify(manifest.directories)
  )
    throw Error("P7 image directory mode mismatch");
  const paths = manifest.files.map((file) => {
    safePath(file.path);
    return file.path;
  });
  if (
    new Set(paths).size !== paths.length ||
    requiredFiles.some((path) => !paths.includes(path)) ||
    !paths.some((p) => p.startsWith("broker/store/") && p.endsWith(".blk"))
  )
    throw Error("P7 incomplete image manifest");
  if (JSON.stringify(inventory(root)) !== JSON.stringify(manifest.files))
    throw Error("P7 image inventory or bytes mismatch");
  return true;
}
export function coldBackup(closed, destination) {
  if (
    closed?.phase !== "closed" ||
    !closed.closure.stores_closed ||
    !closed.closure.brokers.length ||
    closed.closure.brokers.some((b) => !b.exited) ||
    closed.closure.http_ports.some((p) => !p.closed)
  )
    throw Error("P7 backup requires observed closed system");
  const source = resolve(closed.root),
    target = resolve(destination);
  if (target === source || !outside(source, target) || existsSync(target))
    throw Error("P7 independent new backup path required");
  assertRoot(source);
  const manifest = {
    version: 1,
    root_mode: lstatSync(source).mode & 0o777,
    directories: directories(source),
    files: inventory(source),
  };
  validateImage(source, manifest);
  copyImage(source, target, manifest);
  validateImage(target, manifest);
  return { root: target, manifest, source_root: source };
}
export function restoreImage(image, destination) {
  validateImage(image.root, image.manifest);
  if (
    !outside(image.root, destination) ||
    !outside(image.source_root, destination) ||
    existsSync(destination)
  )
    throw Error("P7 independent new restore path required");
  copyImage(image.root, destination, image.manifest);
  validateImage(destination, image.manifest);
  return destination;
}
export function sealOracle(path, facts, protectedRoots) {
  const absolute = resolve(path);
  if (
    protectedRoots.some((root) => {
      return !outside(root, absolute);
    })
  )
    throw Error("P7 oracle must be external");
  const bytes = JSON.stringify(facts, null, 2) + "\n";
  writeFileSync(absolute, bytes, { flag: "wx", mode: 0o600 });
  chmodSync(absolute, 0o400);
  return { path: absolute, sha256: sha256(bytes) };
}
export function readOracle(sealed) {
  const bytes = readFileSync(sealed.path);
  if (sha256(bytes) !== sealed.sha256) throw Error("P7 oracle changed");
  return JSON.parse(bytes);
}
