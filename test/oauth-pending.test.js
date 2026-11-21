import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PinnedOAuthAuthority } from "../src/host/oauth-auth.ts";
import {
  PendingConnections,
  readPending,
  removePending,
  pendingId,
  PENDING_FILE,
  PENDING_MAX_ROWS,
  PENDING_TTL_MS,
} from "../src/host/oauth-pending.ts";
import { persistentOAuthFixture, resource } from "./oauth-fixtures.js";

const NEWCOMER = { sub: "newcomer-subject-0001", azp: "newcomer-client" };

async function watched() {
  const f = await persistentOAuthFixture();
  const seen = [];
  const auth = await PinnedOAuthAuthority.create(
    f.getConfig,
    () => f.start + 1000,
    (signIn, known) => seen.push({ ...signIn, known }),
  );
  const verify = async (jwt) => {
    const reasons = [];
    const context = await auth.verify({
      authorization: "Bearer " + jwt,
      resource,
      signal: new AbortController().signal,
      deny: (reason) => reasons.push(reason),
    });
    return { context, reasons };
  };
  return { ...f, seen, verify };
}

test("a fully valid but unregistered sign-in is kept, with the same refusal as before", async () => {
  const f = await watched();
  const { context, reasons } = await f.verify(await f.token(NEWCOMER));
  assert.equal(context, null);
  assert.deepEqual(reasons, ["client_not_registered"]);
  assert.deepEqual(f.seen, [
    {
      issuer: f.getConfig().issuer,
      subject: NEWCOMER.sub,
      client_id: NEWCOMER.azp,
      known: false,
    },
  ]);
  // The owner's subject with a new client (a product that came back) is marked known.
  const back = await f.verify(await f.token({ azp: "owner-new-client" }));
  assert.deepEqual(back.reasons, ["client_not_registered"]);
  assert.equal(f.seen.at(-1).known, true);
});

test("forged, stale or out-of-scope tokens never reach the pending list", async () => {
  const f = await watched();
  const other = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  );
  const cases = [
    [
      "signed by another key",
      f.token(NEWCOMER, {}, other.privateKey),
      "client_not_registered",
    ],
    [
      "unknown key id",
      f.token(NEWCOMER, { kid: "other-key" }),
      "client_not_registered",
    ],
    [
      "expired",
      f.token({
        ...NEWCOMER,
        iat: f.start / 1000 - 700,
        exp: f.start / 1000 - 100,
      }),
      "client_not_registered",
    ],
    [
      "issued in the future",
      f.token({
        ...NEWCOMER,
        iat: f.start / 1000 + 60,
        exp: f.start / 1000 + 600,
      }),
      "client_not_registered",
    ],
    [
      "too long-lived",
      f.token({ ...NEWCOMER, exp: f.start / 1000 + 3600 }),
      "client_not_registered",
    ],
    [
      "scope missing",
      f.token({ ...NEWCOMER, scope: "hab:resolve" }),
      "scope_missing",
    ],
    [
      "wrong audience",
      f.token({ ...NEWCOMER, aud: "https://elsewhere.example/mcp" }),
      "audience_mismatch",
    ],
    [
      "wrong issuer",
      f.token({ ...NEWCOMER, iss: "https://evil.example/" }),
      "issuer_mismatch",
    ],
  ];
  for (const [label, jwt, reason] of cases) {
    const { context, reasons } = await f.verify(await jwt);
    assert.equal(context, null, label);
    assert.deepEqual(reasons, [reason], label);
  }
  assert.deepEqual(f.seen, []);
});

function store(t) {
  const dir = mkdtempSync(join(tmpdir(), "hab-pending-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const pending = new PendingConnections(dir);
  t.after(() => pending.close());
  return { dir, pending };
}
const signIn = (n) => ({
  issuer: "https://issuer.example/",
  subject: `subject-${n}`,
  client_id: `client-${n}`,
});

test("the pending list keeps one owner-only row per sign-in, with no token in it", (t) => {
  const { dir, pending } = store(t);
  assert.equal(statSync(join(dir, PENDING_FILE)).mode & 0o777, 0o600);
  assert.equal(pending.record(signIn(1), false, 1000), true);
  assert.equal(pending.record(signIn(1), false, 5000), true);
  const [row] = readPending(dir, 6000);
  assert.deepEqual(Object.keys(row).sort(), [
    "attempts",
    "client_id",
    "first_seen_at",
    "issuer",
    "last_seen_at",
    "pending_id",
    "subject",
  ]);
  assert.equal(row.pending_id, pendingId(signIn(1)));
  assert.equal(row.attempts, 2);
  assert.equal(row.first_seen_at, 1000);
  assert.equal(row.last_seen_at, 5000);
  assert.equal(removePending(dir, row.pending_id), true);
  assert.equal(removePending(dir, row.pending_id), false);
  // A rejected sign-in that comes back is pending again, under the same ID.
  pending.record(signIn(1), false, 7000);
  assert.equal(readPending(dir, 7000)[0].pending_id, row.pending_id);
});

test("a full list never shuts out a known subject, and rows go after 14 days", (t) => {
  const { dir, pending } = store(t);
  for (let i = 0; i < PENDING_MAX_ROWS; i++)
    pending.record(signIn(i), false, 1000 + i);
  // A known subject pushes out the oldest stranger.
  assert.equal(pending.record(signIn("owner"), true, 5000), true);
  const ids = readPending(dir, 5000).map((r) => r.subject);
  assert.equal(ids.length, PENDING_MAX_ROWS);
  assert.ok(ids.includes("subject-owner"));
  assert.ok(!ids.includes("subject-0"));
  // A stranger still pushes out an older stranger, never the known one.
  for (let i = 100; i < 140; i++) pending.record(signIn(i), false, 6000 + i);
  const after = readPending(dir, 7000).map((r) => r.subject);
  assert.equal(after.length, PENDING_MAX_ROWS);
  assert.ok(after.includes("subject-owner"));
  // Only once nobody returned for 14 days is a row gone.
  assert.equal(
    readPending(dir, 5000 + PENDING_TTL_MS).some(
      (r) => r.subject === "subject-owner",
    ),
    false,
  );
  pending.record(signIn("late"), false, 5000 + PENDING_TTL_MS + 1);
  assert.deepEqual(
    readPending(dir, 5000 + PENDING_TTL_MS + 1)
      .map((r) => r.subject)
      .filter((s) => s === "subject-owner"),
    [],
  );
});

test("with every row a known subject, a stranger waits and another known subject still gets in", (t) => {
  const { dir, pending } = store(t);
  for (let i = 0; i < PENDING_MAX_ROWS; i++)
    pending.record(signIn(`k${i}`), true, 1000 + i);
  assert.equal(pending.record(signIn("stranger"), false, 2000), false);
  assert.equal(pending.record(signIn("k-new"), true, 2001), true);
  const subjects = readPending(dir, 3000).map((r) => r.subject);
  assert.equal(subjects.length, PENDING_MAX_ROWS);
  assert.ok(subjects.includes("subject-k-new"));
  assert.ok(!subjects.includes("subject-stranger"));
  assert.ok(!subjects.includes("subject-k0"));
});
