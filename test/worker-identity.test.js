import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import process from "node:process";
import {
  inspectWorkerIdentity,
  WORKER_IDENTITY_SCOPES,
} from "../src/worker-identity.ts";
import {
  ApprovedSubjects,
  Auth0Verifier,
  OAuthResource,
} from "../src/oauth.ts";
const config = {
  version: 1,
  mode: "verify-worker-identity",
  oauth: {
    issuer: "https://fixture.us.auth0.com/",
    resource: "https://hub.example/hab/mcp",
  },
  workerClientId: "fixture-worker-client",
};
const pair = await crypto.subtle.generateKey(
  {
    name: "RSASSA-PKCS1-v1_5",
    modulusLength: 2048,
    publicExponent: new Uint8Array([1, 0, 1]),
    hash: "SHA-256",
  },
  true,
  ["sign", "verify"],
);
const jwk = {
  ...(await crypto.subtle.exportKey("jwk", pair.publicKey)),
  kid: "fixture",
  alg: "RS256",
  use: "sig",
};
const NOW = 2_000_000;
const claims = () => ({
  iss: config.oauth.issuer,
  aud: config.oauth.resource,
  sub: "fixture-opaque-service-subject",
  azp: config.workerClientId,
  iat: NOW / 1000,
  exp: NOW / 1000 + 600,
  scope: WORKER_IDENTITY_SCOPES.join(" "),
  gty: "client-credentials",
});
const enc = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
async function sign(overrides = {}, header = {}) {
  const text = `${enc({ alg: "RS256", kid: "fixture", typ: "JWT", ...header })}.${enc({ ...claims(), ...overrides })}`;
  return `Bearer ${text}.${Buffer.from(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", pair.privateKey, new TextEncoder().encode(text))).toString("base64url")}`;
}
function dependency(jwks = { keys: [jwk] }) {
  return {
    now: () => NOW,
    fetch: async (url, init) => {
      assert.equal(url, "https://fixture.us.auth0.com/.well-known/jwks.json");
      assert.equal(init.redirect, "error");
      assert.ok(init.signal);
      return Response.json(jwks);
    },
  };
}
test("signed worker candidate has no authority; explicit separate enrollment is required", async () => {
  const token = await sign();
  const result = await inspectWorkerIdentity(config, token, dependency());
  assert.equal(result.subject, claims().sub);
  assert.equal(result.enrolled, false);
  assert.equal(result.clientId, config.workerClientId);
  assert.equal(result.operations, undefined);
  assert.equal(result.runnerScope, undefined);
  assert.ok(!JSON.stringify(result).includes(token));
  const resource = new OAuthResource(config.oauth);
  const disabled = new Auth0Verifier({
    resource,
    subjects: new ApprovedSubjects([]),
    ...dependency(),
  });
  assert.equal(await disabled.verify(token), null);
  const enabled = new Auth0Verifier({
    resource,
    subjects: new ApprovedSubjects(
      [
        {
          subject: result.subject,
          clientId: result.clientId,
          kind: "service",
          worker: "hermes",
          runnerScope: "operator-reviewed-fixture-scope",
          operations: ["claim", "get", "heartbeat", "complete"],
        },
      ],
      { enabled: true },
    ),
    ...dependency(),
  });
  assert.equal((await enabled.verify(token)).subject, result.subject);
});
test("wrong signatures, claims, client, grants, scopes and expiry are rejected without identity output", async () => {
  for (const overrides of [
    { iss: "https://evil.us.auth0.com/" },
    { aud: "https://elsewhere.example/mcp" },
    { azp: "other-client" },
    { client_id: "other-client" },
    { exp: NOW / 1000 },
    { iat: NOW / 1000 + 1 },
    { nbf: NOW / 1000 + 1 },
    { exp: NOW / 1000 + 601 },
    { gty: "password" },
    { gty: undefined },
    { sub: "" },
    { sub: "x".repeat(201) },
    { scope: "hub:get" },
    { scope: WORKER_IDENTITY_SCOPES.join(" ") + " hub:submit" },
    { scope: "hub:get hub:get hub:claim hub:heartbeat" },
    { cnf: {} },
    { act: {} },
    { authorization_details: [] },
  ])
    await assert.rejects(
      inspectWorkerIdentity(config, await sign(overrides), dependency()),
      /^Error: worker_identity_rejected$/,
    );
  for (const header of [
    { alg: "none" },
    { typ: "at+jwt" },
    { jku: "https://evil.example" },
    { kid: "unknown" },
  ])
    await assert.rejects(
      inspectWorkerIdentity(config, await sign({}, header), dependency()),
      /worker_identity_rejected/,
    );
  const token = await sign();
  const altered =
    token.slice(0, -5) + (token.endsWith("AAAAA") ? "BBBBB" : "AAAAA");
  await assert.rejects(
    inspectWorkerIdentity(config, altered, dependency()),
    /worker_identity_rejected/,
  );
  await assert.rejects(
    inspectWorkerIdentity(
      { ...config, subject: "auto-enroll" },
      token,
      dependency(),
    ),
    /worker_identity_rejected/,
  );
});
test("bounded pinned JWKS denies redirects, unknown/duplicate/private/weak keys and failures", async () => {
  const token = await sign();
  for (const keys of [
    [],
    [jwk, jwk],
    [{ ...jwk, d: "private" }],
    [{ ...jwk, e: "Aw" }],
    [{ ...jwk, n: "AQAB" }],
    [{ ...jwk, kid: "other" }],
    Array(21).fill(jwk),
  ])
    await assert.rejects(
      inspectWorkerIdentity(config, token, dependency({ keys })),
      /worker_identity_rejected/,
    );
  for (const fetch of [
    async () => {
      throw Error("private-token-sentinel");
    },
    async () => new Response("bad", { status: 503 }),
    async () => new Response("x".repeat(65537)),
    async () => {
      const response = Response.json({ keys: [jwk] });
      Object.defineProperty(response, "url", { value: "https://evil.example" });
      return response;
    },
  ])
    await assert.rejects(
      inspectWorkerIdentity(config, token, { fetch, now: () => NOW }),
      /^Error: worker_identity_rejected$/,
    );
});
test("manual CLI receives synthetic Bearer on stdin and outputs only verified candidate", async () => {
  const root = realpathSync(
    mkdtempSync(join(tmpdir(), "hub-worker-identity-")),
  );
  try {
    const path = join(root, "identity.local.json");
    writeFileSync(path, JSON.stringify(config), { mode: 0o600 });
    const now = Math.floor(Date.now() / 1000);
    const token = await sign({ iat: now, exp: now + 600 });
    const run = spawnSync(
      process.execPath,
      [
        "--import",
        fileURLToPath(
          new URL("./worker-identity-jwks-fixture.js", import.meta.url),
        ),
        fileURLToPath(
          new URL("../src/worker-identity-cli.ts", import.meta.url),
        ),
      ],
      {
        input: JSON.stringify({ authorization: token }),
        encoding: "utf8",
        env: {
          PATH: process.env.PATH,
          HAB_WORKER_IDENTITY_CONFIG: path,
          HAB_TEST_PUBLIC_JWK: JSON.stringify(jwk),
        },
        timeout: 5000,
      },
    );
    assert.equal(run.status, 0);
    assert.equal(JSON.parse(run.stdout).subject, claims().sub);
    assert.ok(!run.stdout.includes(token));
    assert.ok(!run.stderr.includes(token));
    const denied = spawnSync(
      process.execPath,
      [
        fileURLToPath(
          new URL("../src/worker-identity-cli.ts", import.meta.url),
        ),
      ],
      {
        input: JSON.stringify({ authorization: "PRIVATE_INPUT_SENTINEL" }),
        encoding: "utf8",
        env: { PATH: process.env.PATH, HAB_WORKER_IDENTITY_CONFIG: path },
        timeout: 5000,
      },
    );
    assert.equal(denied.status, 1);
    assert.equal(denied.stdout, "");
    assert.equal(denied.stderr, "worker_identity_rejected\n");
    assert.ok(!denied.stderr.includes("PRIVATE_INPUT_SENTINEL"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
