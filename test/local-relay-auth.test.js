import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { LocalBearerAuthority } from "../src/relay-host/local-auth.ts";
const token = "a".repeat(64),
  resource = "http://127.0.0.1:8792/mcp",
  start = Date.parse("2026-01-01T00:00:00.000Z");
function fixture() {
  let now = start;
  const record = {
    sha256: createHash("sha256").update(token).digest("hex"),
    principal: {
      issuer: "urn:synthetic:local",
      audience: resource,
      subject: "synthetic-owner",
      client_id: "synthetic-client",
      connection_id: "synthetic-individual",
    },
    issued_at: new Date(start).toISOString(),
    expires_at: new Date(start + 900000).toISOString(),
  };
  let config = { version: 1, credentials: [record] };
  const auth = new LocalBearerAuthority(
    () => config,
    () => now,
  );
  const verify = (patch = {}) =>
    auth.verify({
      authorization: "Bearer " + token,
      resource,
      signal: new AbortController().signal,
      ...patch,
    });
  return {
    auth,
    verify,
    record,
    setConfig: (value) => {
      config = value;
    },
    setNow: (value) => {
      now = value;
    },
  };
}
test("opaque bearer verifies an exact individual; supplied names and fabricated contexts never authenticate", async () => {
  const f = fixture(),
    ctx = await f.verify();
  assert.ok(ctx);
  assert.deepEqual(
    f.auth.authority.individual(ctx).principal,
    f.record.principal,
  );
  assert.equal(f.auth.authority.administrator, undefined);
  assert.equal(
    f.auth.authority.individual({ ...f.record.principal }),
    undefined,
  );
  assert.equal(
    await f.verify({ authorization: "Bearer " + "b".repeat(64) }),
    null,
  );
  assert.equal(await f.verify({ resource: "http://127.0.0.1:8793/mcp" }), null);
});
test("expiry fences both a new request and an already verified operation context without refresh", async () => {
  const f = fixture(),
    ctx = await f.verify();
  f.setNow(start + 899999);
  assert.equal(
    f.auth.authority.individual(ctx).expires_at,
    f.record.expires_at,
  );
  f.setNow(start + 900000);
  assert.equal(f.auth.authority.individual(ctx), undefined);
  assert.equal(await f.verify(), null);
});
test("removal, config damage and rebinding invalidate an in-flight identity", async () => {
  const f = fixture(),
    ctx = await f.verify();
  f.setConfig({ version: 1, credentials: [] });
  assert.equal(f.auth.authority.individual(ctx), undefined);
  assert.equal(await f.verify(), null);
  f.setConfig({
    version: 1,
    credentials: [
      {
        ...f.record,
        principal: { ...f.record.principal, connection_id: "other" },
      },
    ],
  });
  assert.equal(f.auth.authority.individual(ctx), undefined);
  f.setConfig({ version: 2, credentials: [f.record] });
  assert.equal(f.auth.authority.individual(ctx), undefined);
  assert.equal(await f.verify(), null);
});
test("empty configuration is explicitly deny-all; missing, duplicate, excessive lifetime and malformed data reject startup", async () => {
  const f = fixture();
  for (const value of [
    undefined,
    { version: 1, credentials: [f.record, f.record] },
    {
      version: 1,
      credentials: [
        { ...f.record, expires_at: new Date(start + 900001).toISOString() },
      ],
    },
    { version: 1, credentials: [{ ...f.record, issued_at: "bad" }] },
  ])
    assert.throws(
      () =>
        new LocalBearerAuthority(
          () => value,
          () => start,
        ),
      /invalid_local_credentials/,
    );
  const auth = new LocalBearerAuthority(
    () => ({ version: 1, credentials: [] }),
    () => start,
  );
  assert.equal(
    await auth.verify({
      authorization: "Bearer " + token,
      resource,
      signal: new AbortController().signal,
    }),
    null,
  );
});
test("not-yet-valid, aborted, malformed headers and backwards time fail closed", async () => {
  const f = fixture();
  f.setNow(start - 1);
  assert.equal(await f.verify(), null);
  f.setNow(start + 100);
  assert.ok(await f.verify());
  f.setNow(start + 99);
  assert.equal(await f.verify(), null);
  const other = fixture();
  for (const authorization of [
    "",
    "Basic " + token,
    "Bearer name",
    "Bearer " + token + "\n",
  ])
    assert.equal(await other.verify({ authorization }), null);
  const abort = new AbortController();
  abort.abort();
  assert.equal(await other.verify({ signal: abort.signal }), null);
});
