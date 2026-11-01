import { createHash } from "node:crypto";
import { readFileSync, readdirSync, lstatSync } from "node:fs";
import { join } from "node:path";
import { a2aAcceptance } from "../../test/delivery-lab/a2a-acceptance.js";

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
function sourcePaths(root, prefix) {
  return readdirSync(join(root, prefix), { withFileTypes: true })
    .flatMap((entry) => {
      const path = `${prefix}/${entry.name}`;
      return entry.isDirectory() ? sourcePaths(root, path) : [path];
    })
    .sort();
}

export function verifyA2aSource(root) {
  const pin = a2aAcceptance.source;
  const expected = Object.keys(pin.source_sha256).sort();
  const selected = [
    ...sourcePaths(root, "src"),
    ...readdirSync(join(root, "test"))
      .filter((p) => /^a2a-.*\.js$/.test(p))
      .map((p) => `test/${p}`),
    ...readdirSync(join(root, "drizzle"))
      .filter((p) => p.endsWith(".sql"))
      .map((p) => `drizzle/${p}`),
    ...expected.filter(
      (p) =>
        !p.startsWith("src/") &&
        !/^test\/a2a-.*\.js$/.test(p) &&
        !/^drizzle\/[^/]+\.sql$/.test(p),
    ),
  ].sort();
  if (JSON.stringify(selected) !== JSON.stringify(expected))
    throw Error("A2A pinned source inventory mismatch");
  for (const file of expected) {
    if (
      !lstatSync(join(root, file)).isFile() ||
      hash(readFileSync(join(root, file))) !== pin.source_sha256[file]
    )
      throw Error(`A2A pinned source mismatch: ${file}`);
  }
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  for (const [field, value] of Object.entries(pin.package_projection))
    if (JSON.stringify(pkg[field]) !== JSON.stringify(value))
      throw Error(`A2A dependency projection mismatch: ${field}`);
  if (
    hash(readFileSync(join(root, "test/delivery-lab/contracts.test.js"))) !==
    pin.common_contract_sha256
  )
    throw Error("shared delivery contract source mismatch");
  return {
    expected_producer_ref: pin.commit,
    expected_producer_tree: pin.tree,
    pinned_files: expected.length,
    pinned_content_match: true,
    lock_sha256: pin.source_sha256["package-lock.json"],
    common_contract_sha256: pin.common_contract_sha256,
    ancestry_required: false,
  };
}

export function observedCases(tap) {
  return [...tap.matchAll(/^(?:not )?ok \d+ - (.+)$/gm)].map((m) => m[1]);
}

export function assessA2aAcceptance(groups) {
  const required = a2aAcceptance.groups.map((definition) => {
    const found = groups.filter((group) => group.id === definition.id);
    const group = found[0];
    const totals = group?.totals;
    const cases = group?.cases ?? [];
    const accepted =
      found.length === 1 &&
      group.exit_code === 0 &&
      totals?.tests === definition.cases.length &&
      totals.pass === definition.cases.length &&
      totals.fail === 0 &&
      totals.skipped === 0 &&
      totals.cancelled === 0 &&
      totals.todo === 0 &&
      cases.length === definition.cases.length &&
      new Set(cases).size === cases.length &&
      JSON.stringify([...cases].sort()) ===
        JSON.stringify([...definition.cases].sort());
    return {
      id: definition.id,
      state: accepted ? "passed" : "unverified",
      expected_cases: definition.cases.length,
      observed_cases: cases,
    };
  });
  const passed = required.every((group) => group.state === "passed");
  return {
    scope: a2aAcceptance.scope,
    state: passed ? "passed" : "unverified",
    required_groups: required,
    reclassified_generic_passes: 0,
    reclassified: a2aAcceptance.reclassified.map((row) => ({
      ...row,
      execution_state: passed
        ? "mapped-native-cases-passed-with-scope-limit"
        : "unverified",
      generic_requirement_verified: false,
      evidence_group: "a2a-relay-acceptance",
    })),
  };
}
