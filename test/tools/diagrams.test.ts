import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test, type TestContext } from "node:test";

const repository = fileURLToPath(new URL("../../", import.meta.url));
const artifacts = [
  "README.md",
  "docs/hab-topology.md",
  "docs/diagrams/manifest.json",
  "docs/diagrams/hab-current.png",
  "docs/diagrams/hab-target.png",
];
function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "hab-diagram-ts-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const path of [
    ...artifacts,
    "docs/diagrams/render-mermaid.ts",
    "docs/diagrams/render-mermaid.mjs",
  ]) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    copyFileSync(join(repository, path), join(root, path));
  }
  return root;
}
const snapshot = (root: string) =>
  artifacts.map((path) => readFileSync(join(root, path)));
function run(
  root: string,
  extension: string,
  args = ["--check"],
  browser = "",
) {
  const result = spawnSync(
    process.execPath,
    [join(root, `docs/diagrams/render-mermaid.${extension}`), ...args],
    {
      cwd: root,
      encoding: "utf8",
      timeout: 5000,
      env: {
        PATH: process.env.PATH ?? "",
        NODE_OPTIONS: "--disable-warning=ExperimentalWarning",
        HAB_DIAGRAM_BROWSER: browser,
      },
    },
  );
  assert.equal(result.error, undefined);
  assert.equal(result.signal, null);
  return result;
}
function changeMarkdown(root: string, transform: (text: string) => string) {
  const path = join(root, "README.md");
  const before = readFileSync(path, "utf8");
  const after = transform(before);
  assert.notEqual(after, before);
  writeFileSync(path, after);
}
/** Applies a change to the authoritative block only; README may hold other Mermaid blocks. */
function changeAuthoritative(
  root: string,
  transform: (text: string) => string,
) {
  const marker = "<!-- hab-diagram: hab-current -->";
  changeMarkdown(root, (text) => {
    const at = text.indexOf(marker);
    assert.notEqual(at, -1);
    return text.slice(0, at) + transform(text.slice(at));
  });
}
function changeManifest(root: string, key: string, value: string) {
  const path = join(root, "docs/diagrams/manifest.json");
  const manifest = JSON.parse(readFileSync(path, "utf8")) as Record<
    string,
    unknown
  >;
  manifest[key] = value;
  writeFileSync(path, JSON.stringify(manifest));
}

test("diagram TypeScript and legacy entry points check the actual committed artifacts without writing", (t) => {
  const root = fixture(t);
  const before = snapshot(root);
  for (const extension of ["ts", "mjs"]) {
    const result = run(root, extension);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, "");
    assert.equal(
      result.stdout,
      "Markdown Mermaid / PNG manifest: matched (2 diagrams)\n",
    );
    assert.deepEqual(snapshot(root), before);
  }
});

const refusals = [
  {
    name: "duplicate authoritative marker",
    diagnostic: /diagram_marker_not_unique/,
    change: (root: string) =>
      changeMarkdown(
        root,
        (text) => text + "\n<!-- hab-diagram: hab-current -->\n",
      ),
  },
  {
    name: "missing authoritative Mermaid block",
    diagnostic: /diagram_mermaid_missing/,
    change: (root: string) =>
      changeAuthoritative(root, (text) =>
        text.replace("```mermaid", "```text"),
      ),
  },
  {
    name: "wrong renderer pin",
    diagnostic: /diagram_manifest_rejected/,
    change: (root: string) => changeManifest(root, "renderer", "unreviewed"),
  },
  {
    name: "wrong engine pin",
    diagnostic: /diagram_manifest_rejected/,
    change: (root: string) => changeManifest(root, "mermaid", "0.0.0"),
  },
  {
    name: "changed authoritative Mermaid bytes",
    diagnostic: /diagram_regeneration_required/,
    change: (root: string) =>
      changeAuthoritative(root, (text) =>
        text.replace("```mermaid\n", "```mermaid\n%% synthetic drift\n"),
      ),
  },
  {
    name: "changed image bytes",
    diagnostic: /diagram_regeneration_required/,
    change: (root: string) => {
      const path = join(root, "docs/diagrams/hab-current.png");
      writeFileSync(
        path,
        Buffer.concat([readFileSync(path), Buffer.from("drift")]),
      );
    },
  },
];
for (const { name, change, diagnostic } of refusals) {
  test(`diagram check refuses ${name} without rewriting evidence`, (t) => {
    for (const extension of ["ts", "mjs"]) {
      const root = fixture(t);
      change(root);
      const before = snapshot(root);
      const result = run(root, extension);
      assert.equal(result.status, 1);
      assert.equal(result.stdout, "");
      assert.match(result.stderr, diagnostic);
      assert.deepEqual(snapshot(root), before);
    }
  });
}

test("diagram render requires an explicit absolute local browser", (t) => {
  for (const extension of ["ts", "mjs"]) {
    const root = fixture(t);
    const before = snapshot(root);
    for (const browser of ["", "relative-browser"]) {
      const result = run(root, extension, [], browser);
      assert.equal(result.status, 1);
      assert.equal(result.stdout, "");
      assert.match(result.stderr, /absolute_diagram_browser_required/);
      assert.deepEqual(snapshot(root), before);
    }
  }
});

for (const wrong of ["@mermaid-js/mermaid-cli", "mermaid", "puppeteer"]) {
  test(`diagram render refuses wrong installed ${wrong} version before launching tools`, (t) => {
    for (const extension of ["ts", "mjs"]) {
      const root = fixture(t);
      const before = snapshot(root);
      for (const [name, version] of [
        ["@mermaid-js/mermaid-cli", "12.0.0"],
        ["mermaid", "12.1.0"],
        ["puppeteer", "25.13.0"],
      ]) {
        const path = join(
          root,
          "runtime/mermaid-renderer/node_modules",
          name,
          "package.json",
        );
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(
          path,
          JSON.stringify({ version: name === wrong ? "0.0.0" : version }),
        );
      }
      // No CLI or browser is installed in this owned fixture; the version gate must run first.
      const result = run(root, extension, [], "/synthetic/browser");
      assert.equal(result.status, 1);
      assert.equal(result.stdout, "");
      assert.match(
        result.stderr,
        wrong === "@mermaid-js/mermaid-cli"
          ? /diagram_renderer_version_rejected/
          : /diagram_engine_version_rejected/,
      );
      assert.deepEqual(snapshot(root), before);
    }
  });
}
