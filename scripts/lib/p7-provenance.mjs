import { createHash } from "node:crypto";
import { readFileSync, readdirSync, lstatSync } from "node:fs";
import { join } from "node:path";
import pin from "../../test/p7/source-pin.json" with { type: "json" };

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
function walk(root, path) {
  return readdirSync(join(root, path), { withFileTypes: true }).flatMap(
    (entry) => {
      if (
        path === "packages/relay-nats" &&
        ["node_modules", ".runtime"].includes(entry.name)
      )
        return [];
      const name = `${path}/${entry.name}`;
      return entry.isDirectory() ? walk(root, name) : [name];
    },
  );
}
export function verifyP7Source(root) {
  validateOrigins(pin);
  const expected = Object.keys(pin.inputs).sort();
  const selected = [
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
  if (JSON.stringify(expected) !== JSON.stringify(selected))
    throw Error("P7 component inventory mismatch");
  for (const path of expected) {
    if (
      !lstatSync(join(root, path)).isFile() ||
      sha256(readFileSync(join(root, path))) !== pin.inputs[path].sha256
    )
      throw Error(`P7 component source mismatch: ${path}`);
  }
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  for (const [field, expectedValue] of Object.entries(
    pin.root_package_projection,
  ))
    if (JSON.stringify(pkg[field]) !== JSON.stringify(expectedValue))
      throw Error(`P7 dependency mismatch: ${field}`);
  return {
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
