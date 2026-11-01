import assert from "node:assert/strict";
import { test } from "node:test";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  unlinkSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  verifyA2aSource,
  observedCases,
  assessA2aAcceptance,
} from "../../scripts/lib/a2a-acceptance.mjs";
import { a2aAcceptance } from "./a2a-acceptance.js";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
function sourceFixture(t) {
  const root = mkdtempSync(join(tmpdir(), "a2a-source-guard-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const file of [
    ...Object.keys(a2aAcceptance.source.source_sha256),
    "package.json",
    "test/delivery-lab/contracts.test.js",
  ]) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), readFileSync(join(repo, file)));
  }
  return root;
}
function validGroups() {
  return a2aAcceptance.groups.map((definition) => ({
    id: definition.id,
    exit_code: 0,
    totals: {
      tests: definition.cases.length,
      pass: definition.cases.length,
      fail: 0,
      skipped: 0,
      cancelled: 0,
      todo: 0,
    },
    cases: [...definition.cases],
  }));
}

test("P01 exact f19 content validates without any Git object or ancestry", (t) => {
  const root = sourceFixture(t);
  const result = verifyA2aSource(root);
  assert.equal(result.pinned_files, 168);
  assert.equal(result.pinned_content_match, true);
  assert.equal(result.ancestry_required, false);
});

test("P02 missing, modified, added and symlinked product inputs cannot pass source provenance", (t) => {
  for (const fault of ["missing", "modified", "added", "symlink"]) {
    const root = sourceFixture(t),
      path = join(root, "src/a2a/adapter.ts");
    if (fault === "missing") unlinkSync(path);
    if (fault === "modified") writeFileSync(path, "wrong product source");
    if (fault === "added")
      writeFileSync(join(root, "src/unpinned-product.ts"), "export {};");
    if (fault === "symlink") {
      unlinkSync(path);
      symlinkSync(join(repo, "src/a2a/adapter.ts"), path);
    }
    assert.throws(() => verifyA2aSource(root), undefined, fault);
  }
});

test("P03 dependency, transitive fixture, producer inventory and common-contract drift fail closed", (t) => {
  for (const fault of ["dependency", "fixture", "producer", "contract"]) {
    const root = sourceFixture(t);
    if (fault === "dependency") {
      const path = join(root, "package.json"),
        pkg = JSON.parse(readFileSync(path, "utf8"));
      pkg.dependencies["@a2a-js/sdk"] = "unreviewed";
      writeFileSync(path, JSON.stringify(pkg));
    }
    if (fault === "fixture")
      writeFileSync(
        join(root, "test/hab-http-fixtures.js"),
        "unreviewed fixture",
      );
    if (fault === "producer")
      writeFileSync(join(root, "test/a2a-unpinned.test.js"), "unreviewed test");
    if (fault === "contract")
      writeFileSync(
        join(root, "test/delivery-lab/contracts.test.js"),
        "changed contract",
      );
    assert.throws(() => verifyA2aSource(root), undefined, fault);
  }
});

test("P04 mandatory native evidence rejects missing, duplicate, skipped, malformed and mismatched cases", () => {
  assert.equal(assessA2aAcceptance(validGroups()).state, "passed");
  const mutations = [
    (g) => g.pop(),
    (g) => g.push(g[0]),
    (g) => {
      g[0].exit_code = 1;
    },
    (g) => {
      delete g[0].totals;
    },
    (g) => {
      g[0].totals.tests = 0;
    },
    (g) => {
      g[0].totals.tests--;
    },
    (g) => {
      g[0].cases = [];
    },
    (g) => {
      g[1].cases[0] = "A99 unexpected native case";
    },
    (g) => {
      g[1].cases[0] = g[1].cases[1];
    },
    ...["fail", "skipped", "cancelled", "todo"].map((field) => (g) => {
      g[1].totals[field] = 1;
    }),
  ];
  for (const mutate of mutations) {
    const groups = validGroups();
    mutate(groups);
    const result = assessA2aAcceptance(groups);
    assert.equal(result.state, "unverified");
    assert.ok(
      result.reclassified.every((row) => row.execution_state === "unverified"),
    );
  }
});

test("P05 top-level observed TAP cases exclude nested rows and preserve duplicates for rejection", () => {
  assert.deepEqual(
    observedCases(
      "ok 1 - A01 native\n    ok 1 - inner\nnot ok 2 - A02 failed\nok 3 - A01 native\n",
    ),
    ["A01 native", "A02 failed", "A01 native"],
  );
  const result = assessA2aAcceptance(validGroups());
  assert.equal(result.reclassified.length, 8);
  assert.equal(result.reclassified_generic_passes, 0);
  assert.ok(
    result.reclassified.every(
      (row) => row.generic_requirement_verified === false,
    ),
  );
  assert.equal(result.reclassified[0].relationship, "outside_fixed_route");
});

test("P06 runtime SQL migration inventory and bytes reject missing, modified, added and symlinked inputs", (t) => {
  for (const fault of ["missing", "modified", "added", "symlink"]) {
    const root = sourceFixture(t),
      path = join(root, "drizzle/0000_acoustic_magma.sql");
    if (fault === "missing") unlinkSync(path);
    if (fault === "modified")
      writeFileSync(path, "synthetic changed SQL, never executed");
    if (fault === "added")
      writeFileSync(
        join(root, "drizzle/9999_unpinned.sql"),
        "synthetic added SQL, never executed",
      );
    if (fault === "symlink") {
      unlinkSync(path);
      symlinkSync(join(repo, "drizzle/0000_acoustic_magma.sql"), path);
    }
    assert.throws(() => verifyA2aSource(root), undefined, fault);
  }
});
