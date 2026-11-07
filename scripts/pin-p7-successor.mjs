import process from "node:process";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { createHash } from "node:crypto";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2),
  includes = [];
let source,
  write = false;
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--source-ref" && !source) source = args[++i];
  else if (args[i] === "--include") includes.push(args[++i]);
  else if (args[i] === "--write" && !write) write = true;
  else
    throw Error("Expected --source-ref COMMITTED_SHA --write [--include PATH]");
}
if (!write || !/^[a-f0-9]{40}$/.test(source ?? ""))
  throw Error("A fixed committed source ref and --write are required");
const git = (...args) =>
  execFileSync("git", args, { cwd: root, maxBuffer: 16 * 1024 * 1024 });
if (git("rev-parse", `${source}^{commit}`).toString().trim() !== source)
  throw Error("Source must be a commit");
const pinBytes = readFileSync(join(root, "test/p7/source-pin.json")),
  pin = JSON.parse(pinBytes);
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const safePath = (path) =>
  typeof path === "string" &&
  !path.includes("\\") &&
  path.split("/").every((part) => part && part !== "." && part !== "..");
if (!includes.every(safePath)) throw Error("Unsafe include path");
if (
  hash(pinBytes) !==
  "f93a14e6a04fac4d722d8c20d86500b45d47dfa758ec8e4619a3e20e7835a2d7"
)
  throw Error("Historical source pin mismatch");
const tree = git("ls-tree", "-rz", "--full-tree", source)
  .toString()
  .split("\0")
  .filter(Boolean);
const entries = new Map(
  tree.map((row) => {
    const [metadata, path] = row.split("\t");
    return [path, metadata.split(" ")];
  }),
);
const selected = new Set([...Object.keys(pin.inputs), ...includes]);
for (const path of entries.keys())
  if (
    path.startsWith("src/") ||
    path.startsWith("packages/relay-nats/") ||
    /^drizzle\/[^/]+\.sql$/.test(path) ||
    /^test\/a2a-.*\.js$/.test(path)
  )
    selected.add(path);
for (const path of includes)
  if (!entries.has(path)) throw Error(`Missing committed include: ${path}`);
const previous = JSON.parse(
  readFileSync(join(root, "test/p7/successor-source-pin.json"), "utf8"),
);
for (const path of Object.keys(previous.inputs)) selected.add(path);
const inputs = {},
  blobs = {};
const baseline = "028b3754175f47668cc3f787a0a149926351f752";
try {
  execFileSync("git", ["cat-file", "-e", `${baseline}^{commit}`], {
    cwd: root,
    stdio: "pipe",
  });
} catch {
  throw Error(
    `Historical P7 baseline unavailable: ${baseline}; fetch full Git history before generating successor sources`,
  );
}
for (const path of [...selected].sort()) {
  const old = pin.inputs[path]?.sha256 ?? null,
    entry = entries.get(path);
  if (entry && !["100644", "100755"].includes(entry[0]))
    throw Error(`Nonregular source: ${path}`);
  const current = entry ? hash(git("cat-file", "blob", entry[2])) : null;
  if (current === old) continue;
  inputs[path] = { previous_sha256: old, sha256: current };
  if (old) {
    const bytes = git("show", `${baseline}:${path}`);
    if (hash(bytes) !== old) throw Error(`Historical source mismatch: ${path}`);
    blobs[old] = { gzip_base64: gzipSync(bytes).toString("base64") };
  }
}
const sourcePackage = JSON.parse(git("show", `${source}:package.json`));
const projection = Object.fromEntries(
  Object.entries(pin.root_package_projection)
    .filter(
      ([field, value]) =>
        JSON.stringify(sourcePackage[field]) !== JSON.stringify(value),
    )
    .map(([field]) => [field, sourcePackage[field]]),
);
const manifest = {
  version: 1,
  base_ref: baseline,
  base_pin_sha256: hash(pinBytes),
  source_ref: source,
  ...(Object.keys(projection).length
    ? { root_package_projection: projection }
    : {}),
  inputs,
};
const canonical = (value) =>
  Array.isArray(value)
    ? value.map(canonical)
    : value && typeof value === "object"
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((key) => [key, canonical(value[key])]),
        )
      : value;
writeFileSync(
  join(root, "test/p7/successor-source-pin.json"),
  JSON.stringify(manifest, null, 2) + "\n",
);
writeFileSync(
  join(root, "test/p7/predecessor-source-fixtures.json"),
  JSON.stringify({ blobs }, null, 2) + "\n",
);
process.stdout.write(
  `Set successorManifestSha256 in scripts/lib/p7-provenance.mjs to ${hash(JSON.stringify(canonical(manifest)))}\n`,
);
