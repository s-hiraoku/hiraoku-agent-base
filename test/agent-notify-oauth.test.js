import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { URLSearchParams } from "node:url";
import {
  OAuthTokenFile,
  NOTIFIER_OAUTH_SCOPE,
  login,
} from "../src/agent-notify/oauth-token.ts";
import { main } from "../scripts/hab-notify.ts";

const NOW = Date.parse("2026-11-15T14:00:00Z");

function setup(t, stored) {
  const dir = mkdtempSync(join(tmpdir(), "hab-notify-oauth-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "token.json");
  if (stored) writeFileSync(file, JSON.stringify(stored), { mode: 0o600 });
  return { dir, file };
}

/** A fake token endpoint: records each form body and answers with `answer(n)`. */
function fakeIssuer(answer, delayMs = 0) {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({
      url,
      body: Object.fromEntries(new URLSearchParams(init.body)),
    });
    const n = calls.length;
    if (delayMs) await new Promise((done) => setTimeout(done, delayMs));
    const [status, json] = answer(n);
    if (status === 0) throw new TypeError("fetch failed");
    return new Response(JSON.stringify(json), { status });
  };
  return { calls, fetch };
}

const tokenOptions = (file, fetch, extra = {}) => ({
  file,
  token_endpoint: "https://issuer.example/oauth/token",
  client_id: "public-client",
  resource: "https://hab.example/hab/mcp",
  fetch,
  now: () => NOW,
  ...extra,
});

const expired = {
  access_token: "synthetic-at-1",
  refresh_token: "synthetic-rt-1",
  expires_at: NOW / 1000 - 10,
};

test("an expired token is refreshed with the rotated refresh token and stored 0600", async (t) => {
  const { file } = setup(t, expired);
  const issuer = fakeIssuer(() => [
    200,
    {
      access_token: "synthetic-at-2",
      refresh_token: "synthetic-rt-2",
      token_type: "Bearer",
      expires_in: 600,
      scope: NOTIFIER_OAUTH_SCOPE,
    },
  ]);
  const token = new OAuthTokenFile(tokenOptions(file, issuer.fetch));
  assert.equal(await token.authorization(), "Bearer synthetic-at-2");
  assert.deepEqual(issuer.calls[0].body, {
    grant_type: "refresh_token",
    refresh_token: "synthetic-rt-1",
    client_id: "public-client",
    resource: "https://hab.example/hab/mcp",
  });
  const saved = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(saved.refresh_token, "synthetic-rt-2");
  assert.equal(saved.expires_at, NOW / 1000 + 600);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal(existsSync(`${file}.lock`), false);
  // Now fresh: no further request.
  assert.equal(await token.authorization(), "Bearer synthetic-at-2");
  assert.equal(issuer.calls.length, 1);
});

test("a token due within refresh_before is refreshed early; a fresh one is not", async (t) => {
  const { file } = setup(t, { ...expired, expires_at: NOW / 1000 + 30 });
  const issuer = fakeIssuer(() => [
    200,
    { access_token: "synthetic-at-2", expires_in: 600 },
  ]);
  const token = new OAuthTokenFile(tokenOptions(file, issuer.fetch));
  assert.equal(await token.authorization(), "Bearer synthetic-at-2");
  // An issuer that does not rotate omits refresh_token: the old one is kept.
  assert.equal(
    JSON.parse(readFileSync(file, "utf8")).refresh_token,
    "synthetic-rt-1",
  );
  const late = new OAuthTokenFile(
    tokenOptions(file, issuer.fetch, { refresh_before_ms: 0 }),
  );
  assert.equal(await late.authorization(), "Bearer synthetic-at-2");
  assert.equal(issuer.calls.length, 1);
});

test("processes refreshing at once spend the refresh token only once", async (t) => {
  const { file } = setup(t, expired);
  const issuer = fakeIssuer(
    (n) => [
      200,
      {
        access_token: `synthetic-at-${n + 1}`,
        refresh_token: `synthetic-rt-${n + 1}`,
        expires_in: 600,
      },
    ],
    150,
  );
  const a = new OAuthTokenFile(tokenOptions(file, issuer.fetch));
  const b = new OAuthTokenFile(tokenOptions(file, issuer.fetch));
  const c = new OAuthTokenFile(tokenOptions(file, issuer.fetch));
  const results = await Promise.all([
    a.authorization(),
    b.authorization(),
    c.authorization(),
  ]);
  assert.deepEqual(results, Array(3).fill("Bearer synthetic-at-2"));
  assert.equal(issuer.calls.length, 1);
});

test("a refused grant asks for login; a failed request is retried later; the file is kept", async (t) => {
  const { file } = setup(t, expired);
  let answer = [400, { error: "invalid_grant" }];
  const issuer = fakeIssuer(() => answer);
  const token = new OAuthTokenFile(tokenOptions(file, issuer.fetch));
  assert.equal(await token.problem(), "token_login_required");
  answer = [503, { error: "temporarily_unavailable" }];
  assert.equal(await token.problem(), "token_refresh_failed");
  answer = [0];
  assert.equal(await token.problem(), "token_refresh_failed");
  answer = [200, { access_token: "", expires_in: 600 }];
  assert.equal(await token.problem(), "token_refresh_failed");
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), expired);
  assert.equal(existsSync(`${file}.lock`), false);
});

test("a missing, unsafe or refresh-less token file is named without a request", async (t) => {
  const { file } = setup(t);
  const issuer = fakeIssuer(() => [500, {}]);
  const token = new OAuthTokenFile(tokenOptions(file, issuer.fetch));
  assert.equal(await token.problem(), "token_login_required");
  writeFileSync(file, JSON.stringify(expired));
  chmodSync(file, 0o644);
  assert.equal(await token.problem(), "insecure_token_file");
  chmodSync(file, 0o600);
  writeFileSync(
    file,
    JSON.stringify({
      access_token: "synthetic-at",
      expires_at: NOW / 1000 + 30,
    }),
  );
  // No refresh token: used until it expires, then a login is due.
  assert.equal(await token.authorization(), "Bearer synthetic-at");
  writeFileSync(
    file,
    JSON.stringify({
      access_token: "synthetic-at",
      expires_at: NOW / 1000 - 1,
    }),
  );
  assert.equal(await token.problem(), "token_login_required");
  assert.equal(issuer.calls.length, 0);
  assert.throws(
    () =>
      new OAuthTokenFile(
        tokenOptions(file, issuer.fetch, {
          token_endpoint: "http://issuer.example/oauth/token",
        }),
      ),
    { code: "invalid_request" },
  );
});

test("a lock left by a dead process is removed; a live one is waited for", async (t) => {
  // This test uses the real clock, because lock age is the file's real mtime.
  const { file } = setup(t, { ...expired, expires_at: Date.now() / 1000 - 10 });
  const issuer = fakeIssuer(() => [
    200,
    { access_token: "synthetic-at-2", expires_in: 600 },
  ]);
  // A lock another process holds right now: wait, then give up for this check.
  writeFileSync(`${file}.lock`, "1 old\n");
  const now = new OAuthTokenFile({
    ...tokenOptions(file, issuer.fetch, { lock_wait_ms: 300 }),
    now: Date.now,
  });
  assert.equal(await now.problem(), "token_refresh_busy");
  assert.equal(issuer.calls.length, 0);
  const old = (Date.now() - 120_000) / 1000;
  utimesSync(`${file}.lock`, old, old);
  assert.equal(await now.authorization(), "Bearer synthetic-at-2");
  assert.equal(existsSync(`${file}.lock`), false);
});

const freePort = () =>
  new Promise((done) => {
    const server = createServer().listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => done(port));
    });
  });

test("login uses PKCE through the loopback callback and stores the grant", async (t) => {
  const { file } = setup(t);
  const issuer = fakeIssuer(() => [
    200,
    {
      access_token: "synthetic-at-login",
      refresh_token: "synthetic-rt-login",
      expires_in: 600,
    },
  ]);
  const port = await freePort();
  const redirect = `http://127.0.0.1:${port}/callback`;
  let opened;
  const done = login(
    new OAuthTokenFile(tokenOptions(file, issuer.fetch)),
    {
      authorization_endpoint: "https://issuer.example/authorize",
      redirect_uri: redirect,
      client_id: "public-client",
      resource: "https://hab.example/hab/mcp",
      timeout_ms: 10_000,
    },
    (url) => (opened = new URL(url)),
  );
  while (!opened) await new Promise((r) => setTimeout(r, 10));
  const q = opened.searchParams;
  assert.equal(q.get("response_type"), "code");
  assert.equal(q.get("code_challenge_method"), "S256");
  assert.equal(q.get("redirect_uri"), redirect);
  assert.equal(q.get("scope"), NOTIFIER_OAUTH_SCOPE);
  assert.match(q.get("scope"), /offline_access/);
  // A callback without this login's state is refused and the login keeps waiting.
  const stray = await globalThis.fetch(`${redirect}?code=x&state=other`);
  assert.equal(stray.status, 400);
  const back = await globalThis.fetch(
    `${redirect}?code=synthetic-code&state=${q.get("state")}`,
  );
  assert.equal(back.status, 200);
  assert.deepEqual(await done, { has_refresh_token: true });
  const body = issuer.calls[0].body;
  assert.equal(body.grant_type, "authorization_code");
  assert.equal(body.code, "synthetic-code");
  assert.equal(body.redirect_uri, redirect);
  assert.equal(
    createHash("sha256").update(body.code_verifier).digest("base64url"),
    q.get("code_challenge"),
  );
  const saved = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(saved.refresh_token, "synthetic-rt-login");
  assert.equal(statSync(file).mode & 0o777, 0o600);
});

test("hab-notify with token.oauth refreshes before calling HAB and prints no token", async (t) => {
  const { dir, file } = setup(t, {
    ...expired,
    expires_at: Date.now() / 1000 - 10,
  });
  let answer = [
    200,
    {
      access_token: "synthetic-at-cli",
      refresh_token: "synthetic-rt-cli",
      expires_in: 600,
    },
  ];
  const bodies = [];
  const issuer = createServer((request, response) => {
    let text = "";
    request.on("data", (chunk) => (text += chunk));
    request.on("end", () => {
      bodies.push(Object.fromEntries(new URLSearchParams(text)));
      response
        .writeHead(answer[0], { "Content-Type": "application/json" })
        .end(JSON.stringify(answer[1]));
    });
  });
  await new Promise((done) => issuer.listen(0, "127.0.0.1", done));
  t.after(() => issuer.close());
  const config = join(dir, "notify.json");
  writeFileSync(
    config,
    JSON.stringify({
      // Nothing listens here: a call that went out ends as transport_failed.
      hab_url: "http://127.0.0.1:9/mcp",
      agent_id: "agent-b",
      token: {
        oauth: {
          file,
          token_endpoint: `http://127.0.0.1:${issuer.address().port}/oauth/token`,
          client_id: "public-client",
          resource: "https://hab.example/hab/mcp",
        },
      },
      store: join(dir, "notices.sqlite"),
      screen: {
        type: "jsonl",
        path: join(dir, "screen.jsonl"),
        target: "synthetic:desktop-1",
      },
    }),
  );
  const lines = [];
  const out = (line) => lines.push(line);
  assert.equal(await main(["--config", config, "check"], out), 1);
  // The refresh worked, so the call to HAB was made (and failed to connect).
  assert.deepEqual(JSON.parse(lines.at(-1)), { error: "transport_failed" });
  assert.equal(bodies.length, 1);
  assert.equal(bodies[0].refresh_token, "synthetic-rt-1");
  assert.equal(
    JSON.parse(readFileSync(file, "utf8")).refresh_token,
    "synthetic-rt-cli",
  );
  // A revoked grant is named, and HAB is not called.
  writeFileSync(
    file,
    JSON.stringify({ ...expired, expires_at: Date.now() / 1000 - 10 }),
  );
  answer = [400, { error: "invalid_grant" }];
  assert.equal(await main(["--config", config, "check"], out), 1);
  assert.deepEqual(JSON.parse(lines.at(-1)), { error: "token_login_required" });
  // login without its endpoints is refused before listening.
  assert.equal(await main(["--config", config, "login"], out), 2);
  assert.deepEqual(JSON.parse(lines.at(-1)), { error: "oauth_not_configured" });
  assert.equal(/synthetic-(at|rt)/.test(lines.join("\n")), false);
});
