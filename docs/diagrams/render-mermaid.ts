// Markdown Mermaid is authoritative. Optional CLI/browser tools are local-only.
import { readFile, writeFile, mkdtemp, rm } from "node:fs/promises";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const root = fileURLToPath(new URL("../../", import.meta.url));
const entries = [
  {
    source: "README.md",
    id: "hab-current",
    image: "docs/diagrams/hab-current.png",
  },
  {
    source: "docs/history/hab-topology.md",
    id: "hab-target",
    image: "docs/diagrams/hab-target.png",
  },
];
interface DiagramEntry {
  source: string;
  id: string;
  image: string;
}
interface DiagramDefinition extends DiagramEntry {
  mermaid: string;
}
interface DiagramRecord extends DiagramEntry {
  mermaidSHA256: string;
  imageSHA256: string;
}
interface DiagramManifest {
  renderer: string;
  mermaid: string;
  puppeteer: string;
  diagrams: DiagramRecord[];
}
const sha = (bytes: string | Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
const definitions: DiagramDefinition[] = [];
for (const entry of entries) {
  const markdown = await readFile(join(root, entry.source), "utf8");
  const marker = `<!-- hab-diagram: ${entry.id} -->`;
  if (markdown.split(marker).length !== 2)
    throw Error("diagram_marker_not_unique");
  const match = markdown
    .split(marker)[1]
    .match(/^\s*```mermaid\r?\n([\s\S]*?)\r?\n```/);
  if (!match) throw Error("diagram_mermaid_missing");
  definitions.push({ ...entry, mermaid: `${match[1]}\n` });
}
const engineVersions = { mermaid: "12.1.0", puppeteer: "25.13.0" } as const;
const manifestPath = join(root, "docs/diagrams/manifest.json");
if (process.argv.slice(2).includes("--check")) {
  const manifest = JSON.parse(
    await readFile(manifestPath, "utf8"),
  ) as DiagramManifest;
  if (
    manifest.renderer !== "@mermaid-js/mermaid-cli@12.0.0" ||
    Object.entries(engineVersions).some(
      ([name, version]) =>
        manifest[name as keyof typeof engineVersions] !== version,
    ) ||
    manifest.diagrams.length !== definitions.length
  )
    throw Error("diagram_manifest_rejected");
  for (const [index, diagram] of definitions.entries()) {
    const recorded = manifest.diagrams[index];
    if (
      recorded.source !== diagram.source ||
      recorded.id !== diagram.id ||
      recorded.image !== diagram.image ||
      recorded.mermaidSHA256 !== sha(diagram.mermaid) ||
      recorded.imageSHA256 !== sha(await readFile(join(root, diagram.image)))
    )
      throw Error("diagram_regeneration_required");
  }
  console.log("Markdown Mermaid / PNG manifest: matched (2 diagrams)");
} else {
  const browser = process.env.HAB_DIAGRAM_BROWSER;
  if (!browser || !browser.startsWith("/"))
    throw Error("absolute_diagram_browser_required");
  const cli = resolve(root, "runtime/mermaid-renderer/node_modules/.bin/mmdc");
  const packageJSON = JSON.parse(
    await readFile(
      join(
        root,
        "runtime/mermaid-renderer/node_modules/@mermaid-js/mermaid-cli/package.json",
      ),
      "utf8",
    ),
  ) as { version?: string };
  if (packageJSON.version !== "12.0.0")
    throw Error("diagram_renderer_version_rejected");
  for (const [name, version] of Object.entries(engineVersions)) {
    const installed = JSON.parse(
      await readFile(
        join(
          root,
          `runtime/mermaid-renderer/node_modules/${name}/package.json`,
        ),
        "utf8",
      ),
    ) as { version?: string };
    if (installed.version !== version)
      throw Error("diagram_engine_version_rejected");
  }
  const temporary = await mkdtemp(join(tmpdir(), "hab-mermaid-"));
  try {
    const config = join(temporary, "browser.json");
    await writeFile(
      config,
      JSON.stringify({
        executablePath: browser,
        userDataDir: join(temporary, "profile"),
        pipe: true,
        headless: true,
        args: [
          "--disable-background-networking",
          "--disable-component-update",
          "--disable-sync",
          "--no-first-run",
          "--no-default-browser-check",
          "--disable-extensions",
          "--host-resolver-rules=MAP * ~NOTFOUND",
        ],
      }),
      { mode: 0o600 },
    );
    const rendered: DiagramRecord[] = [];
    for (const diagram of definitions) {
      const input = join(temporary, `${diagram.id}.mmd`);
      await writeFile(input, diagram.mermaid, { mode: 0o600 });
      await promisify(execFile)(
        cli,
        [
          "-i",
          input,
          "-o",
          join(root, diagram.image),
          "-p",
          config,
          "-b",
          "white",
          "-s",
          "2",
        ],
        {
          cwd: root,
          timeout: 60000,
          maxBuffer: 1048576,
          env: {
            PATH: process.env.PATH ?? "",
            TMPDIR: temporary,
            LANG: "en_US.UTF-8",
          },
        },
      );
      rendered.push({
        source: diagram.source,
        id: diagram.id,
        image: diagram.image,
        mermaidSHA256: sha(diagram.mermaid),
        imageSHA256: sha(await readFile(join(root, diagram.image))),
      });
    }
    await writeFile(
      manifestPath,
      `${JSON.stringify({ renderer: "@mermaid-js/mermaid-cli@12.0.0", ...engineVersions, diagrams: rendered }, null, 2)}\n`,
    );
    console.log("Rendered and parsed both authoritative Markdown diagrams");
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
