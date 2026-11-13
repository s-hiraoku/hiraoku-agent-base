#!/usr/bin/env node
// HAB-owned dependency-boundary check. Run from any working directory.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import {
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";

const [targetArg, mode] = process.argv.slice(2);
assert(
  targetArg && (!mode || mode === "--self-test") && process.argv.length <= 4,
  "usage: node communication-boundary.mjs TARGET [--self-test]",
);
const target = resolve(targetArg);
const ts = createRequire(join(target, "package.json"))("typescript");
const shared = new Set(["src/protocol.ts", "src/security.ts"]);
const slash = (path) => path.split(sep).join("/");
const sdkPath = (name) => `src/agent-sdk/${name}`;
const messagingPath = (name) => `src/messaging/${name}`;
const hostMcpPath = (name) => `src/host/mcp/${name}`;
// Registry-owned sender capacity policy, used by the SQLite delivery store.
const registryCore = ["src/hab/agent-capacity.ts"];
// The host's delivery store (ADR-018): durable storage, no MCP/OAuth/HTTP.
const deliveryCore = ["src/delivery/sqlite-delivery.ts"];
// docs/hab-messaging-spec.md section 3.1: domain/durable storage must not depend
// inward on MCP/OAuth/HTTP composition. Keep these roles explicit for review.
const coreModules = new Set([
  ...["index.ts", "contract.ts", "delivery-service.ts", "tool-errors.ts"].map(
    messagingPath,
  ),
  ...[
    "index.ts",
    "sender.ts",
    "receiver.ts",
    "authentication-recovery.ts",
    "sqlite-outbox.ts",
    "sqlite-inbox.ts",
    // Agent-side receive host, its stop/epoch control and process owner (ADR-017).
    "guard.ts",
    "sqlite-host-control.ts",
    "sqlite-host-owner.ts",
    "receive-host.ts",
  ].map(sdkPath),
  hostMcpPath("writer-admission.ts"),
  ...registryCore,
  ...deliveryCore,
]);
const outerModules = new Set([
  sdkPath("mcp-client.ts"),
  // Timer-driven scheduling over a receive host; no MCP/HTTP of its own.
  sdkPath("receive-supervisor.ts"),
  ...["server.ts", "http.ts", "http-node.ts", "oauth-resource.ts"].map(
    hostMcpPath,
  ),
]);
const corePackages = new Set([
  "node:buffer",
  "node:crypto",
  "node:fs",
  "node:path",
  "node:sqlite",
  "zod",
]);
const communicationPolicy = {
  name: "communication",
  allowsModule: (name) =>
    name.startsWith("src/agent-sdk/") ||
    name.startsWith("src/messaging/") ||
    name.startsWith("src/host/mcp/") ||
    registryCore.includes(name) ||
    deliveryCore.includes(name) ||
    shared.has(name),
  allowsPackage: (name) =>
    name.startsWith("node:") ||
    name === "zod" ||
    name.startsWith("@modelcontextprotocol/"),
};
const corePolicy = {
  name: "core",
  allowsModule: (name) => coreModules.has(name),
  allowsPackage: (name) => corePackages.has(name),
};

function inspect(root, entries, policy = communicationPolicy) {
  const pending = [...entries],
    seen = new Set(),
    edges = [];
  while (pending.length) {
    const name = pending.pop();
    if (seen.has(name)) continue;
    assert(
      policy.allowsModule(name),
      `forbidden ${policy.name} dependency: ${name}`,
    );
    assert(
      !lstatSync(join(root, name)).isSymbolicLink(),
      `source symlink requires review: ${name}`,
    );
    seen.add(name);
    const source = ts.createSourceFile(
      name,
      readFileSync(join(root, name), "utf8"),
      ts.ScriptTarget.Latest,
      true,
    );
    assert.equal(source.parseDiagnostics.length, 0, `cannot parse: ${name}`);
    assert.equal(
      source.referencedFiles.length,
      0,
      `triple-slash path reference requires review: ${name}`,
    );
    const dependency = (specifier) => {
      assert(
        specifier && ts.isStringLiteralLike(specifier),
        `computed module path requires review: ${name}`,
      );
      const value = specifier.text;
      edges.push({ from: name, to: value });
      if (value.startsWith(".")) {
        const next = slash(relative(root, resolve(root, dirname(name), value)));
        assert(next.endsWith(".ts"), `unresolved project module: ${next}`);
        pending.push(next);
      } else {
        assert(
          policy.allowsPackage(value),
          `unreviewed ${policy.name} package dependency: ${value}`,
        );
      }
    };
    const visit = (node) => {
      if (
        (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
        node.moduleSpecifier
      )
        dependency(node.moduleSpecifier);
      if (
        ts.isImportEqualsDeclaration(node) &&
        ts.isExternalModuleReference(node.moduleReference)
      )
        dependency(node.moduleReference.expression);
      if (ts.isImportTypeNode(node)) {
        assert(
          ts.isLiteralTypeNode(node.argument),
          `computed import type requires review: ${name}`,
        );
        dependency(node.argument.literal);
      }
      if (
        ts.isCallExpression(node) &&
        (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
          (ts.isIdentifier(node.expression) &&
            node.expression.text === "require"))
      ) {
        assert.equal(node.arguments.length, 1, `unknown loader shape: ${name}`);
        dependency(node.arguments[0]);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return { files: [...seen].sort(), edges };
}

function sourceEntries(root, directory = "src/agent-sdk") {
  return readdirSync(join(root, directory), { withFileTypes: true }).flatMap(
    (entry) => {
      const name = `${directory}/${entry.name}`;
      assert(
        !entry.isSymbolicLink(),
        `source symlink requires review: ${name}`,
      );
      return entry.isDirectory()
        ? sourceEntries(root, name)
        : entry.isFile() && name.endsWith(".ts")
          ? [name]
          : [];
    },
  );
}

if (mode === "--self-test") {
  const scratch = mkdtempSync(join(tmpdir(), "hab-boundary-"));
  try {
    mkdirSync(join(scratch, "src/agent-sdk"), { recursive: true });
    mkdirSync(join(scratch, "src/messaging"), { recursive: true });
    mkdirSync(join(scratch, "src/host/mcp"), { recursive: true });
    const entry = join(scratch, "src/agent-sdk/index.ts");
    // A deliberately isolated optional adapter must not contaminate the communication closure.
    writeFileSync(
      join(scratch, "src/optional-hermes.ts"),
      'import OpenAI from "openai";\n',
    );
    writeFileSync(
      entry,
      "// Hermes and Task are allowed words in comments.\nexport const text = 'openai';\n",
    );
    assert.deepEqual(inspect(scratch, sourceEntries(scratch)).files, [
      "src/agent-sdk/index.ts",
    ]);
    const controls = [
      ["direct product import", 'import "../hermes-run-driver.ts";'],
      ["task re-export", 'export * from "../generic-jobs.ts";'],
      ["model SDK import", 'import OpenAI from "openai";'],
      ["computed import", "const x = import(process.env.PRODUCT);"],
      ["import equals", 'import X = require("../hermes-run-driver.ts");'],
      ["require", 'const x = require("../hermes-run-driver.ts");'],
      ["type import", 'type X = import("../generic-jobs.ts").X;'],
      [
        "triple slash reference",
        '/// <reference path="../generic-jobs.ts" />\nexport {};',
      ],
      ["syntax error", "export const = ;"],
    ];
    for (const [name, text] of controls) {
      writeFileSync(entry, text);
      assert.throws(
        () => inspect(scratch, ["src/agent-sdk/index.ts"]),
        undefined,
        name,
      );
    }
    writeFileSync(entry, 'import "./helper.ts";');
    writeFileSync(
      join(scratch, "src/agent-sdk/helper.ts"),
      'export * from "../generic-jobs.ts";',
    );
    assert.throws(
      () => inspect(scratch, ["src/agent-sdk/index.ts"]),
      /forbidden communication dependency/,
    );
    const service = join(scratch, "src/messaging/delivery-service.ts");
    const coreCheck = () =>
      inspect(scratch, ["src/messaging/delivery-service.ts"], corePolicy);
    writeFileSync(
      service,
      'import { McpServer } from "@modelcontextprotocol/server";',
    );
    assert.throws(coreCheck, /unreviewed core package dependency/);
    writeFileSync(service, 'import "../host/mcp/server.ts";');
    writeFileSync(
      join(scratch, "src/host/mcp/server.ts"),
      'import { McpServer } from "@modelcontextprotocol/server";',
    );
    assert.throws(coreCheck, /forbidden core dependency/);
    writeFileSync(service, 'import "../agent-sdk/sender.ts";');
    writeFileSync(
      join(scratch, "src/agent-sdk/sender.ts"),
      'export * from "../host/mcp/server.ts";',
    );
    assert.throws(coreCheck, /forbidden core dependency/);
    writeFileSync(service, 'import "../host/mcp/oauth-resource.ts";');
    assert.throws(coreCheck, /forbidden core dependency/);
    writeFileSync(service, 'import "../host/mcp/http.ts";');
    assert.throws(coreCheck, /forbidden core dependency/);
    writeFileSync(service, 'import type { AuditSink } from "../security.ts";');
    assert.throws(coreCheck, /forbidden core dependency/);
    writeFileSync(service, 'import "node:http";');
    assert.throws(coreCheck, /unreviewed core package dependency/);
    assert.deepEqual(inspect(scratch, ["src/host/mcp/server.ts"]).files, [
      "src/host/mcp/server.ts",
    ]);
    console.log(
      JSON.stringify({
        status: "pass",
        negativeControls: [
          ...controls.map(([name]) => name),
          "indirect dependency",
          "core direct MCP SDK",
          "core to MCP wrapper to SDK",
          "core indirect outer dependency",
          "core OAuth outer",
          "core HTTP outer",
          "core outer shared security type",
          "core HTTP builtin",
        ],
        harmlessControls: [
          "comments",
          "string literal",
          "optional execution adapter outside closure",
          "MCP outer to SDK",
        ],
      }),
    );
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
} else {
  const entries = [
    ...sourceEntries(target),
    ...sourceEntries(target, "src/messaging"),
    ...sourceEntries(target, "src/host/mcp"),
    ...registryCore,
    ...deliveryCore,
  ];
  assert(entries.length > 0, "empty communication source set");
  for (const name of entries)
    assert(
      coreModules.has(name) || outerModules.has(name),
      `unclassified communication module requires role review: ${name}`,
    );
  for (const name of coreModules)
    assert(entries.includes(name), `required core source missing: ${name}`);
  console.log(
    JSON.stringify(
      {
        status: "pass",
        communicationBoundary: inspect(target, entries),
        coreBoundary: inspect(target, [...coreModules], corePolicy),
        reviewedRoles: {
          core: [...coreModules].sort(),
          outer: [...outerModules].sort(),
          outerOnlyShared: [...shared],
          corePackages: [...corePackages],
        },
        limits:
          "AST module edges and triple-slash path references only. Communication closure excludes product/Task code; separately classified core/storage closure excludes MCP/OAuth/HTTP outer and SDK dependencies. No package-internal, aliased-loader, reflection, runtime capability, model invocation or approval proof.",
      },
      null,
      2,
    ),
  );
}
