import test from "node:test";
import assert from "node:assert/strict";
import {
  persistentOAuthFixture as persistentFixture,
  resource,
} from "./relay-oauth-fixtures.js";
import {
  PinnedRelayOAuthAuthority,
  parseRelayOAuthConfig,
} from "../src/relay-host/oauth-auth.ts";

test("persistent participation accepts a refreshed short token after the old trial window without rebinding", async () => {
  const f = await persistentFixture();
  const first = await f.verify(await f.token());
  const principal = f.auth.authority.individual(first).principal;
  const unchanged = structuredClone(f.getConfig());
  f.setNow(f.start + 1200000);
  assert.equal(f.auth.authority.individual(first), undefined);
  assert.equal(await f.verify(await f.token()), null);
  const fresh = await f.verify(
    await f.token({ iat: f.start / 1000 + 1200, exp: f.start / 1000 + 1800 }),
  );
  assert.ok(fresh);
  assert.deepEqual(f.auth.authority.individual(fresh).principal, principal);
  assert.deepEqual(f.getConfig(), unchanged);
});

test("final short token is clipped to participation end and never survives that boundary", async () => {
  const f = await persistentFixture();
  f.participation.approved_until = new Date(f.start + 1500).toISOString();
  const jwt = await f.token();
  f.setNow(f.start + 1000);
  const context = await f.verify(jwt);
  assert.equal(
    f.auth.authority.individual(context).expires_at,
    f.participation.approved_until,
  );
  f.setNow(f.start + 1499);
  assert.ok(f.auth.authority.individual(context));
  f.setNow(f.start + 1500);
  assert.equal(f.auth.authority.individual(context), undefined);
  assert.equal(await f.verify(jwt), null);
});

test("concurrent refreshed access tokens resolve to the same approved connection without changing policy", async () => {
  const f = await persistentFixture();
  f.setNow(f.start + 1200000);
  const original = structuredClone(f.getConfig());
  const tokens = await Promise.all(
    ["first", "second"].map((jti) =>
      f.token({
        iat: f.start / 1000 + 1200,
        exp: f.start / 1000 + 1800,
        jti,
      }),
    ),
  );
  const contexts = await Promise.all(tokens.map((jwt) => f.verify(jwt)));
  assert.ok(contexts.every(Boolean));
  assert.deepEqual(
    f.auth.authority.individual(contexts[0]).principal,
    f.auth.authority.individual(contexts[1]).principal,
  );
  assert.deepEqual(f.getConfig(), original);
});

test("participation dates do not relax JWT dates, maximum lifetime, subject, client, resource or scopes", async () => {
  const f = await persistentFixture();
  const start = f.start / 1000;
  for (const patch of [
    { exp: start + 601 },
    { exp: start + 901 },
    { exp: start + 86400 },
    { exp: undefined },
    { exp: start },
    { iat: start + 1 },
    { iat: start - 1 },
    { nbf: start + 1 },
    { sub: "other-owner" },
    { azp: "other-client" },
    { aud: "https://other.example/mcp" },
    { iss: "https://other.example/" },
    { scope: "hub:submit" },
  ])
    assert.equal(await f.verify(await f.token(patch)), null);
  assert.ok(await f.verify(await f.token()));
});

test("explicit persistent config rejects implicit upgrades, unbounded dates and token material", async () => {
  const f = await persistentFixture();
  const config = structuredClone(f.getConfig());
  const record = config.connections[0];
  for (const invalid of [
    { ...config, mode: undefined },
    { ...config, mode: "trial" },
    { ...config, version: 1 },
    { ...config, max_access_token_lifetime_seconds: undefined },
    { ...config, max_access_token_lifetime_seconds: 0 },
    { ...config, max_access_token_lifetime_seconds: 901 },
    { ...config, max_access_token_lifetime_seconds: 1.5 },
    { ...config, refresh_token: "must-not-be-in-this-file" },
    ...[
      { approved_until: undefined },
      { approved_until: null },
      { approved_until: "never" },
      { approved_until: record.approved_at },
      { approved_at: "invalid" },
      { state: undefined },
      { state: "unknown" },
      { access_token: "must-not-be-in-this-file" },
    ].map((patch) => ({ ...config, connections: [{ ...record, ...patch }] })),
    { ...config, connections: [record, { ...record, connection_id: "other" }] },
  ]) {
    assert.throws(() => parseRelayOAuthConfig(invalid));
    await assert.rejects(
      PinnedRelayOAuthAuthority.create(() => invalid),
      /invalid_relay_oauth_config/,
    );
  }
  // The code requires explicit finite dates; it does not choose a deployment duration.
  for (const days of [1, 7, 30, 365])
    assert.equal(
      parseRelayOAuthConfig({
        ...config,
        connections: [
          {
            ...record,
            approved_until: new Date(f.start + days * 86400000).toISOString(),
          },
        ],
      }).version,
      2,
    );
});

test("revocation, disable, deletion and permission edits invalidate existing contexts and fresh tokens", async () => {
  const f = await persistentFixture();
  const original = structuredClone(f.getConfig());
  const jwt = await f.token();
  for (const edit of [
    (c) => {
      c.connections[0].state = "revoked";
    },
    (c) => {
      c.enabled = false;
    },
    (c) => {
      c.connections = [];
    },
    (c) => {
      c.connections[0].approved_at = new Date(f.start + 1000).toISOString();
    },
    (c) => {
      c.connections[0].approved_until = new Date(f.start - 1).toISOString();
    },
  ]) {
    f.setConfig(structuredClone(original));
    const context = await f.verify(jwt);
    assert.ok(context);
    const changed = structuredClone(original);
    edit(changed);
    f.setConfig(changed);
    assert.equal(f.auth.authority.individual(context), undefined);
    assert.equal(await f.verify(jwt), null);
  }
});

test("restart reuses the saved participation policy, not old opaque contexts or expired access tokens", async () => {
  const f = await persistentFixture();
  const oldContext = await f.verify(await f.token());
  const now = f.start + 1200000;
  let saved = JSON.stringify(f.getConfig());
  const restart = () =>
    PinnedRelayOAuthAuthority.create(
      () => JSON.parse(saved),
      () => now,
    );
  const auth = await restart();
  assert.equal(auth.authority.individual(oldContext), undefined);
  const verify = async (authority, jwt) =>
    authority.verify({
      authorization: `Bearer ${jwt}`,
      resource,
      signal: new AbortController().signal,
    });
  assert.equal(await verify(auth, await f.token()), null);
  const jwt = await f.token({ iat: now / 1000, exp: now / 1000 + 600 });
  assert.ok(await verify(auth, jwt));
  const revoked = JSON.parse(saved);
  revoked.connections[0].state = "revoked";
  saved = JSON.stringify(revoked);
  assert.equal(await verify(await restart(), jwt), null);
});

test("observed revocation followed by config restoration cannot resurrect an older opaque context", async () => {
  const f = await persistentFixture();
  const original = structuredClone(f.getConfig());
  const jwt = await f.token();
  const context = await f.verify(jwt);
  f.getConfig().connections[0].state = "revoked";
  assert.equal(f.auth.authority.individual(context), undefined);
  f.setConfig(original);
  assert.equal(f.auth.authority.individual(context), undefined);
  assert.ok(await f.verify(jwt));
});

test("persistent verification rejects a stale result when participation changes during signature verification", async () => {
  const f = await persistentFixture();
  const jwt = await f.token();
  const pending = f.verify(jwt);
  f.setConfig({ ...f.getConfig(), enabled: false });
  assert.equal(await pending, null);
});

test("pinned key rotation invalidates old contexts and signatures while accepting the new issuer key", async () => {
  const f = await persistentFixture();
  const jwt = await f.token();
  const ctx = await f.verify(jwt);
  const next = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  );
  const key = await crypto.subtle.exportKey("jwk", next.publicKey);
  f.getConfig().keys = [
    {
      kty: "RSA",
      alg: "RS256",
      use: "sig",
      kid: "rotated-key",
      n: key.n,
      e: key.e,
    },
  ];
  assert.equal(f.auth.authority.individual(ctx), undefined);
  assert.equal(await f.verify(jwt), null);
  assert.ok(
    await f.verify(await f.token({}, { kid: "rotated-key" }, next.privateKey)),
  );
});

test("clock rollback fails closed for persistent contexts and reauthentication", async () => {
  const f = await persistentFixture();
  const jwt = await f.token();
  const context = await f.verify(jwt);
  f.setNow(f.start - 1);
  assert.equal(f.auth.authority.individual(context), undefined);
  assert.equal(await f.verify(jwt), null);
});
