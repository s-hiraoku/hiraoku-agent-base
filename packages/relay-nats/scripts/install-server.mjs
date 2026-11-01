import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve, join } from "node:path";

const version = "2.15.2";
const digests = {
  "darwin-x64":
    "9c45b23c19498692e81cd39c75e8382f0e6ff59c0d5b9470e32fe6640afa4446",
  "darwin-arm64":
    "cbd2219d01502c38733485ac684269da585ee479fa3b1377264beecdefdf9e9d",
  "linux-x64":
    "67cb8e10bc6f0c4b47f75a728529a20953dbae2a4f9a4a52ae8517d65ae303ff",
  "linux-arm64":
    "bc2c788dcbf2849af749564e06a0d48c19bced851f2d68a2e21c54d078949b28",
};
const key = `${process.platform}-${process.arch}`;
const expected = digests[key];
if (!expected) throw Error(`unsupported platform ${key}`);
const name = `nats-server-v${version}-${process.platform}-${process.arch === "x64" ? "amd64" : process.arch}`;
const runtime = resolve(".runtime");
mkdirSync(runtime, { recursive: true, mode: 0o700 });
const archive = join(runtime, name + ".tar.gz");
if (!existsSync(archive)) {
  const response = await fetch(
    `https://github.com/nats-io/nats-server/releases/download/v${version}/${name}.tar.gz`,
  );
  if (!response.ok)
    throw Error(`official server download failed ${response.status}`);
  writeFileSync(archive, new Uint8Array(await response.arrayBuffer()), {
    mode: 0o600,
  });
}
const actual = createHash("sha256").update(readFileSync(archive)).digest("hex");
if (actual !== expected) throw Error("server archive SHA-256 mismatch");
execFileSync("tar", ["-xzf", archive, "-C", runtime]);
const binary = join(runtime, name, "nats-server");
if (
  execFileSync(binary, ["--version"], { encoding: "utf8" }).trim() !==
  `nats-server: v${version}`
)
  throw Error("server version mismatch");
console.log(JSON.stringify({ version, sha256: actual, binary }));
