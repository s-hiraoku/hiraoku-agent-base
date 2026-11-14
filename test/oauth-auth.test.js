import test from "node:test";
import assert from "node:assert/strict";
import { oauthFixture, issuer, resource } from "./oauth-fixtures.js";
import { PinnedOAuthAuthority } from "../src/host/oauth-auth.ts";
import {
  McpOAuthResource,
  HAB_OAUTH_SCOPES,
} from "../src/host/mcp/oauth-resource.ts";

test("pinned OAuth attests only the enrolled connection, never JWT agent/connection arguments", async () => {
  const f = await oauthFixture(),
    jwt = await f.token({ connection_id: "attacker", agent_id: "other" }),
    ctx = await f.verify(jwt);
  assert.ok(ctx);
  assert.deepEqual(f.auth.authority.individual(ctx).principal, {
    issuer,
    audience: resource,
    subject: f.record.subject,
    client_id: f.record.client_id,
    connection_id: f.record.connection_id,
  });
  assert.equal(f.auth.authority.individual({ ...f.record }), undefined);
  assert.equal(f.auth.authority.administrator, undefined);
  assert.equal(
    await f.verify(jwt, { resource: "https://other.example/hab/mcp" }),
    null,
  );
  const abort = new AbortController();
  abort.abort();
  assert.equal(await f.verify(jwt, { signal: abort.signal }), null);
});
test("reject wrong issuer, audience, client, subject and missing HAB grants", async () => {
  const f = await oauthFixture();
  for (const patch of [
    { iss: "https://other.jp.auth0.com/" },
    { aud: "https://hab.example/mcp" },
    { aud: ["https://other.example/api", resource] },
    { sub: "other" },
    { azp: "other" },
    { client_id: "different" },
    { azp: undefined },
    { scope: "hub:submit hub:get" },
    { scope: HAB_OAUTH_SCOPES.slice(1).join(" ") },
  ])
    assert.equal(await f.verify(await f.token(patch)), null);
});
test("enforce iat, nbf, token lifetime, connection window and expiry on saved contexts", async () => {
  const f = await oauthFixture(),
    start = f.start / 1000;
  for (const patch of [
    { iat: start + 1 },
    { iat: undefined },
    { exp: start },
    { exp: start + 901 },
    { iat: start - 1 },
    { nbf: start + 1 },
    { exp: start + 0.5 },
  ])
    assert.equal(await f.verify(await f.token(patch)), null);
  const ctx = await f.verify(await f.token());
  assert.ok(ctx);
  f.setNow(f.start + 600000);
  assert.equal(f.auth.authority.individual(ctx), undefined);
  assert.equal(await f.verify(await f.token()), null);
});
test("reject non-RS256, remote key selectors, malformed encodings and wrong signatures", async () => {
  const f = await oauthFixture();
  for (const h of [
    { alg: "none" },
    { alg: "HS256" },
    { kid: "other" },
    { crit: ["x"] },
    { jku: "https://evil.example/keys" },
    { jwk: { kty: "RSA" } },
    { x5u: "https://evil.example/cert" },
  ])
    assert.equal(await f.verify(await f.token({}, h)), null);
  const jwt = await f.token(),
    parts = jwt.split(".");
  parts[2] = Buffer.alloc(256).toString("base64url");
  for (const value of [
    parts.join("."),
    jwt + "=",
    jwt + ".extra",
    "e30._w.AA",
    "not-a-token",
  ])
    assert.equal(await f.verify(value), null);
});
test("removal, rebinding, disable and config damage invalidate a verified context", async () => {
  const f = await oauthFixture(),
    original = structuredClone(f.getConfig()),
    jwt = await f.token();
  for (const change of [
    (c) => {
      c.enabled = false;
    },
    (c) => {
      c.connections = [];
    },
    (c) => {
      c.connections[0].connection_id = "replacement";
    },
    (c) => {
      c.extra = true;
    },
  ]) {
    f.setConfig(structuredClone(original));
    const ctx = await f.verify(jwt);
    assert.ok(ctx);
    const changed = structuredClone(original);
    change(changed);
    f.setConfig(changed);
    assert.equal(f.auth.authority.individual(ctx), undefined);
    const fresh = await f.verify(jwt);
    if (changed.connections?.[0]?.connection_id === "replacement") {
      assert.ok(fresh);
      assert.equal(
        f.auth.authority.individual(fresh).principal.connection_id,
        "replacement",
      );
    } else assert.equal(fresh, null);
  }
});
test("config changes during verification cannot publish an old authenticated context", async () => {
  const f = await oauthFixture(),
    jwt = await f.token();
  const pending = f.verify(jwt);
  f.setConfig({ ...f.getConfig(), enabled: false });
  assert.equal(await pending, null);
});
test("clock rollback rejects both new authentication and operation revalidation", async () => {
  const f = await oauthFixture(),
    jwt = await f.token(),
    ctx = await f.verify(jwt);
  f.setNow(f.start - 1);
  assert.equal(f.auth.authority.individual(ctx), undefined);
  assert.equal(await f.verify(jwt), null);
});
test("empty disabled config denies all; absent, private, weak or ambiguous keys/config refuse startup", async () => {
  const f = await oauthFixture();
  const disabled = {
    ...f.getConfig(),
    enabled: false,
    keys: [],
    connections: [],
  };
  const a = await PinnedOAuthAuthority.create(() => disabled);
  assert.equal(
    await a.verify({
      authorization: "Bearer a.b.c",
      resource,
      signal: new AbortController().signal,
    }),
    null,
  );
  for (const patch of [
    undefined,
    { ...f.getConfig(), keys: [] },
    { ...f.getConfig(), keys: [{ ...f.getConfig().keys[0], d: "private" }] },
    { ...f.getConfig(), keys: [{ ...f.getConfig().keys[0], n: "AQAB" }] },
    {
      ...f.getConfig(),
      connections: [
        f.record,
        { ...f.record, connection_id: "duplicate-client" },
      ],
    },
    {
      ...f.getConfig(),
      connections: [
        { ...f.record, expires_at: new Date(f.start + 900001).toISOString() },
      ],
    },
  ])
    await assert.rejects(
      PinnedOAuthAuthority.create(() => patch),
      /invalid_oauth_config/,
    );
});
test("resource metadata owns only its path, declares exact scopes and rejects URL aliases", async () => {
  const r = new McpOAuthResource(issuer, resource);
  const body = await r.response(r.metadataPath, "GET").json();
  assert.deepEqual(body.scopes_supported, HAB_OAUTH_SCOPES);
  assert.equal(body.resource, resource);
  assert.match(r.challenge(), /resource_metadata=/);
  assert.equal(
    r.response("/.well-known/oauth-protected-resource", "GET"),
    undefined,
  );
  assert.equal(r.response(r.metadataPath, "POST").status, 405);
  for (const value of [
    "http://hab.example/hab/mcp",
    resource + "?x=1",
    resource + "#x",
    "https://hab.example:443/hab/mcp",
    "https://hab.example/hab/../mcp",
    "https://hab.example//mcp",
  ])
    assert.throws(
      () => new McpOAuthResource(issuer, value),
      /invalid_oauth_resource/,
    );
});
test("each refusal names a fixed audit reason and never a claim value", async () => {
  const f = await oauthFixture(),
    start = f.start / 1000;
  const reasonFor = async (jwt, patch = {}) => {
    const reasons = [];
    const ctx = await f.verify(jwt, {
      deny: (reason) => reasons.push(reason),
      ...patch,
    });
    assert.equal(ctx, null);
    assert.equal(reasons.length, 1);
    assert.match(reasons[0], /^[a-z][a-z0-9_]{0,47}$/);
    return reasons[0];
  };
  const cases = [
    [{ iss: "https://other.jp.auth0.com/" }, "issuer_mismatch"],
    [{ aud: "https://hab.example/mcp" }, "audience_mismatch"],
    // A list audience is accepted only as [resource] or [resource, issuer userinfo].
    [{ aud: [resource, "https://x.example/userinfo"] }, "audience_not_single"],
    [{ sub: "other" }, "subject_not_registered"],
    [{ azp: "other", client_id: undefined }, "client_not_registered"],
    [{ client_id: "different" }, "client_id_conflict"],
    [{ azp: undefined, client_id: undefined }, "client_id_missing"],
    [{ scope: "hub:submit" }, "scope_missing"],
    [{ exp: start + 901 }, "token_lifetime_invalid"],
    [{ nbf: start + 1 }, "token_not_yet_valid"],
    [{ iat: start - 1 }, "token_before_approval"],
    [{ iat: undefined }, "token_claims_invalid"],
  ];
  for (const [patch, reason] of cases)
    assert.equal(await reasonFor(await f.token(patch)), reason, reason);
  assert.equal(
    await reasonFor(await f.token({}, { kid: "other" })),
    "signing_key_unknown",
  );
  assert.equal(
    await reasonFor(await f.token({}, { alg: "none" })),
    "token_header_invalid",
  );
  const parts = (await f.token()).split(".");
  parts[2] = Buffer.alloc(256).toString("base64url");
  assert.equal(await reasonFor(parts.join(".")), "signature_invalid");
  assert.equal(await reasonFor("not-a-jwt"), "token_malformed");
  assert.equal(
    await reasonFor(await f.token(), {
      resource: "https://other.example/hab/mcp",
    }),
    "resource_mismatch",
  );
  f.setNow(f.start + 600000);
  assert.equal(await reasonFor(await f.token()), "token_expired");
});
test("Auth0 list audiences: only the resource once, plus at most this issuer's userinfo", async () => {
  const f = await oauthFixture(),
    userinfo = issuer + "userinfo";
  // ChatGPT-style connectors ask for openid, so Auth0 adds its userinfo audience.
  assert.ok(await f.verify(await f.token({ aud: [resource, userinfo] })));
  assert.ok(await f.verify(await f.token({ aud: [userinfo, resource] })));
  assert.ok(await f.verify(await f.token({ aud: [resource] })));
  for (const aud of [
    ["https://other.example/api", resource],
    [userinfo],
    [resource, resource],
    [resource, "https://other.jp.auth0.com/userinfo"],
    [resource, userinfo, "https://other.example/api"],
    [],
  ]) {
    const reasons = [];
    assert.equal(
      await f.verify(await f.token({ aud }), {
        deny: (reason) => reasons.push(reason),
      }),
      null,
      JSON.stringify(aud),
    );
    assert.equal(reasons.length, 1);
  }
  const ctx = await f.verify(await f.token({ aud: [resource, userinfo] }));
  assert.equal(f.auth.authority.individual(ctx).principal.audience, resource);
});
