import { createHash } from "node:crypto";
import { readFileSync, readdirSync, lstatSync } from "node:fs";
import { join } from "node:path";
import pin from "../../test/p7/source-pin.json" with { type: "json" };
import successor from "../../test/p7/successor-source-pin.json" with { type: "json" };

export const sha256 = (bytes) =>
  createHash("sha256").update(bytes).digest("hex");
export function validateOrigins(value) {
  const refs = {
    a2a: "e9e19f6e49cff4a468175380055e9b83ca368ac7",
    nats: "ee101e3514546fba9df99564ac9c8a3a2612494b",
    lab: "6c92deea85855450549f886d30e2bdf02e44912e",
    synthesized: "5461ff3869f18b06daa8333ac81a9a79eb4dbcdb",
  };
  if (JSON.stringify(value.refs) !== JSON.stringify(refs))
    throw Error("P7 fixed component refs mismatch");
  const overrides = [
    "src/relay-host/local.ts",
    "src/relay-host/configured.ts",
    "src/relay/sqlite-store.ts",
  ];
  if (
    JSON.stringify(value.authorized_core_overrides) !==
      JSON.stringify(overrides) ||
    Object.keys(value.inputs).length !== 218
  )
    throw Error("P7 component declaration mismatch");
  for (const [path, input] of Object.entries(value.inputs)) {
    const origin =
      path === overrides[1]
        ? "synthesized"
        : overrides.includes(path) || path.startsWith("packages/relay-nats/")
          ? "nats"
          : path.startsWith("test/delivery-lab/") ||
              path.startsWith("scripts/lib/") ||
              path === "scripts/delivery-lab.mjs"
            ? "lab"
            : "a2a";
    if (input.origin !== origin || !/^[a-f0-9]{64}$/.test(input.sha256))
      throw Error(`P7 invalid component origin: ${path}`);
  }
}
export const successorManifestSha256 =
  "791e5af85a98b0c116de27f9ce25b45f635f8d972c4de9543e56a4470c9020d2";
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
const safePath = (path) =>
  typeof path === "string" &&
  !path.includes("\\") &&
  path.split("/").every((part) => part && part !== "." && part !== "..");
const validProjection = (value) =>
  value === undefined ||
  (value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length > 0 &&
    Object.keys(value).every((field) =>
      Object.hasOwn(pin.root_package_projection, field),
    ));
export function p7PackageProjection(profile = "current") {
  if (profile === "historical") return pin.root_package_projection;
  if (profile !== "current") throw Error("P7 source profile unknown");
  validateSuccessor(successor);
  return {
    ...pin.root_package_projection,
    ...successor.root_package_projection,
  };
}
export function validateSuccessor(value) {
  if (
    value?.version !== 1 ||
    value.base_ref !== "028b3754175f47668cc3f787a0a149926351f752" ||
    value.base_pin_sha256 !==
      sha256(
        readFileSync(new URL("../../test/p7/source-pin.json", import.meta.url)),
      ) ||
    !/^[a-f0-9]{40}$/.test(value.source_ref) ||
    !value.inputs ||
    typeof value.inputs !== "object" ||
    Array.isArray(value.inputs) ||
    !validProjection(value.root_package_projection) ||
    sha256(JSON.stringify(canonical(value))) !== successorManifestSha256
  )
    throw Error("P7 successor fixed manifest mismatch");
  for (const [path, input] of Object.entries(value.inputs)) {
    const previous = pin.inputs[path]?.sha256 ?? null;
    if (
      !safePath(path) ||
      path === "package.json" ||
      input.previous_sha256 !== previous ||
      (input.sha256 !== null && !/^[a-f0-9]{64}$/.test(input.sha256)) ||
      input.sha256 === previous
    )
      throw Error(`P7 successor component declaration mismatch: ${path}`);
  }
  return value;
}
export function p7ExpectedInputs(profile = "current") {
  if (profile === "historical") return pin.inputs;
  if (profile !== "current") throw Error("P7 source profile unknown");
  validateSuccessor(successor);
  const inputs = { ...pin.inputs };
  for (const [path, input] of Object.entries(successor.inputs)) {
    if (input.sha256 === null) delete inputs[path];
    else inputs[path] = { sha256: input.sha256 };
  }
  return inputs;
}
function regularPath(root, path) {
  for (const part of ["", ...path.split("/")]) {
    root = part ? join(root, part) : root;
    if (lstatSync(root).isSymbolicLink())
      throw Error(`P7 component symlink: ${path}`);
  }
  if (!lstatSync(root).isFile())
    throw Error(`P7 component not regular: ${path}`);
}
function walk(root, path) {
  return readdirSync(join(root, path), { withFileTypes: true }).flatMap(
    (entry) => {
      if (
        path === "packages/relay-nats" &&
        ["node_modules", ".runtime"].includes(entry.name)
      )
        return [];
      const name = `${path}/${entry.name}`;
      if (entry.isSymbolicLink()) throw Error(`P7 component symlink: ${name}`);
      return entry.isDirectory() ? walk(root, name) : [name];
    },
  );
}
export function selectedP7Paths(root, expected = Object.keys(pin.inputs)) {
  return [
    ...walk(root, "src"),
    ...readdirSync(join(root, "drizzle"))
      .filter((p) => p.endsWith(".sql"))
      .map((p) => `drizzle/${p}`),
    ...readdirSync(join(root, "test"))
      .filter((p) => /^a2a-.*\.js$/.test(p))
      .map((p) => `test/${p}`),
    ...walk(root, "packages/relay-nats"),
    ...expected.filter(
      (p) =>
        !p.startsWith("src/") &&
        !p.startsWith("packages/relay-nats/") &&
        !/^drizzle\/[^/]+\.sql$/.test(p) &&
        !/^test\/a2a-.*\.js$/.test(p),
    ),
  ].sort();
}
export function verifyP7Source(root, profile = "current") {
  validateOrigins(pin);
  if (!lstatSync(root).isDirectory() || lstatSync(root).isSymbolicLink())
    throw Error("P7 source requires a regular directory");
  const inputs = p7ExpectedInputs(profile);
  const expected = Object.keys(inputs).sort();
  const selected = selectedP7Paths(root, expected);
  if (JSON.stringify(expected) !== JSON.stringify(selected))
    throw Error("P7 component inventory mismatch");
  for (const path of expected) {
    regularPath(root, path);
    if (sha256(readFileSync(join(root, path))) !== inputs[path].sha256)
      throw Error(`P7 component source mismatch: ${path}`);
  }
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  for (const [field, expectedValue] of Object.entries(
    p7PackageProjection(profile),
  ))
    if (JSON.stringify(pkg[field]) !== JSON.stringify(expectedValue))
      throw Error(`P7 dependency mismatch: ${field}`);
  return {
    source_profile: profile,
    ...(profile === "current"
      ? {
          successor_ref: successor.source_ref,
          successor_manifest_sha256: successorManifestSha256,
        }
      : {}),
    refs: pin.refs,
    a2a_core_ref: pin.a2a_core_ref,
    inputs: expected.length,
    contents_match: true,
    authorized_core_overrides: pin.authorized_core_overrides,
    synthesized_inputs: pin.synthesized_inputs,
    common_contract_sha256: pin.common_contract_sha256,
    ancestry_required: false,
  };
}
