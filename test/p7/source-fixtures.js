import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import pin from "./source-pin.json" with { type: "json" };
import archive from "./predecessor-source-fixtures.json" with { type: "json" };
import { sha256, p7ExpectedInputs } from "../../scripts/lib/p7-provenance.mjs";
const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export function fixtureBytes(file, input, snapshots = archive) {
  let bytes = existsSync(join(repo, file))
    ? readFileSync(join(repo, file))
    : undefined;
  if (!bytes || sha256(bytes) !== input.sha256) {
    const snapshot = snapshots.blobs[input.sha256];
    assert.ok(snapshot, `Missing immutable predecessor fixture: ${file}`);
    bytes = gunzipSync(Buffer.from(snapshot.gzip_base64, "base64"), {
      maxOutputLength: 1024 * 1024,
    });
  }
  assert.equal(sha256(bytes), input.sha256, file);
  return bytes;
}
export function sourceFixture(t, profile = "historical") {
  const root = mkdtempSync(join(tmpdir(), "p7-source-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const inputs =
    profile === "historical" ? pin.inputs : p7ExpectedInputs(profile);
  for (const [file, input] of Object.entries(inputs)) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), fixtureBytes(file, input));
  }
  writeFileSync(
    join(root, "package.json"),
    readFileSync(join(repo, "package.json")),
  );
  return root;
}
