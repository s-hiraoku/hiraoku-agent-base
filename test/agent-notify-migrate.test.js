import process from "node:process";
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  existsSync,
  realpathSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SQLiteNotices } from "../src/agent-notify/sqlite-notices.ts";
import { bindingIdentity } from "../src/agent-notify/binding.ts";
import {
  inspectNoticeMigration,
  migrateNoticesOffline,
} from "../src/agent-notify/migrate-notices.ts";
const attestation = {
  notifiers_stopped_and_source_will_not_restart: true,
  old_connection_recipient_and_existing_session_verified: true,
};
function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "hab-mig-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = join(root, "old.sqlite");
  const store = new SQLiteNotices(source, "legacy-session");
  const message = {
    sender_id: "sender",
    message_id: "message",
    from: null,
    kind: "question",
    thread_id: "thread",
    in_reply_to: null,
    sent_at: "2026-01-01T00:00:00Z",
    expires_at: "2027-01-01T00:00:00Z",
    display: "private text",
    handoff_prompt: "private prompt",
  };
  store.insertShowing(message, 1);
  store.transition(message, ["showing"], "queued", 2);
  const revision = store.get(message).revision;
  store.close();
  const plan = {
    source,
    destination_directory: join(root, "bundle"),
    expected_source_target: "legacy-session",
    destination_binding: {
      product: "example",
      connection_id: "verified-host",
      recipient_id: "recipient",
      session_id: "legacy-session",
    },
  };
  return { root, plan, message, revision };
}
test("offline migration preserves original backup, decision/revision and duplicate guard", (t) => {
  const { plan, message, revision } = fixture(t);
  const before = readFileSync(plan.source);
  const inspection = inspectNoticeMigration(plan);
  assert.equal(inspection.old_identity_requires_operator_verification, true);
  assert.ok(!JSON.stringify(inspection).includes("private text"));
  migrateNoticesOffline(
    { ...plan, expected_source_sha256: inspection.source_sha256 },
    attestation,
  );
  assert.deepEqual(readFileSync(plan.source), before);
  assert.deepEqual(
    readFileSync(join(plan.destination_directory, "source.sqlite")),
    before,
  );
  const migrated = new SQLiteNotices(
    join(plan.destination_directory, "notices.sqlite"),
    bindingIdentity(plan.destination_binding),
  );
  assert.equal(migrated.get(message).state, "queued");
  assert.equal(migrated.get(message).revision, revision);
  assert.equal(migrated.insertShowing(message, 3), false);
  migrated.close();
  assert.throws(
    () =>
      migrateNoticesOffline(
        { ...plan, expected_source_sha256: inspection.source_sha256 },
        attestation,
      ),
    /destination_exists/,
  );
});
test("migration refuses missing attestation, changed source and unsettled outcomes", (t) => {
  const { plan, message } = fixture(t);
  const inspection = inspectNoticeMigration(plan);
  assert.throws(() => migrateNoticesOffline(plan, {}), /attestation_required/);
  assert.throws(
    () => migrateNoticesOffline(plan, attestation),
    /fingerprint_required/,
  );
  const store = new SQLiteNotices(plan.source, "legacy-session");
  store.transition(message, ["queued"], "unknown", 3);
  store.close();
  assert.throws(
    () =>
      migrateNoticesOffline(
        { ...plan, expected_source_sha256: inspection.source_sha256 },
        attestation,
      ),
    /unsettled_decisions/,
  );
  assert.equal(existsSync(plan.destination_directory), false);
  assert.equal(
    existsSync(plan.destination_directory + ".migration-lock"),
    false,
  );
  const settled = new SQLiteNotices(plan.source, "legacy-session");
  settled.transition(message, ["unknown"], "declined", 4);
  settled.close();
  assert.throws(
    () =>
      migrateNoticesOffline(
        { ...plan, expected_source_sha256: inspection.source_sha256 },
        attestation,
      ),
    /source_changed/,
  );
});
test("migration refuses another binding, active writer and non-private destination", (t) => {
  const { plan } = fixture(t);
  assert.throws(
    () => inspectNoticeMigration({ ...plan, expected_source_target: "other" }),
    /binding_mismatch/,
  );
  const lock = new DatabaseSync(plan.source);
  lock.exec("BEGIN IMMEDIATE");
  assert.throws(() => inspectNoticeMigration(plan), /locked/);
  lock.exec("ROLLBACK");
  lock.close();
  const inspection = inspectNoticeMigration(plan);
  mkdirSync(plan.destination_directory, { mode: 0o755 });
  assert.throws(
    () =>
      migrateNoticesOffline(
        {
          ...plan,
          destination_directory: join(plan.destination_directory, "nested"),
          expected_source_sha256: inspection.source_sha256,
        },
        attestation,
      ),
    /parent_not_private/,
  );
});

test("migration rejects committed WAL and never publishes a partial bundle", (t) => {
  const { plan, message } = fixture(t);
  const inspection = inspectNoticeMigration(plan);
  const db = new DatabaseSync(plan.source);
  db.exec("PRAGMA wal_autocheckpoint=0");
  db.prepare("UPDATE notices SET decided_at=? WHERE sender_id=?").run(
    9,
    message.sender_id,
  );
  try {
    assert.throws(
      () =>
        migrateNoticesOffline(
          { ...plan, expected_source_sha256: inspection.source_sha256 },
          attestation,
        ),
      /source_wal/,
    );
    assert.equal(existsSync(plan.destination_directory), false);
    assert.equal(
      existsSync(plan.destination_directory + ".migration-lock"),
      false,
    );
  } finally {
    db.close();
  }
});

test("migration CLI inspects then creates bundle only with explicit attestation file", async (t) => {
  const { spawnSync } = await import("node:child_process");
  const { writeFileSync } = await import("node:fs");
  const { plan, root } = fixture(t);
  const planFile = join(root, "plan.json"),
    attestFile = join(root, "attest.json");
  writeFileSync(planFile, JSON.stringify(plan), { mode: 0o600 });
  const command = (...args) =>
    spawnSync(process.execPath, ["scripts/hab-migrate-notices.ts", ...args], {
      encoding: "utf8",
    });
  const inspected = command("inspect", planFile);
  assert.equal(inspected.status, 0, inspected.stderr);
  const report = JSON.parse(inspected.stdout);
  assert.equal(command("migrate", planFile).status, 1);
  writeFileSync(
    planFile,
    JSON.stringify({ ...plan, expected_source_sha256: report.source_sha256 }),
    { mode: 0o600 },
  );
  writeFileSync(attestFile, JSON.stringify(attestation), { mode: 0o600 });
  const migrated = command("migrate", planFile, attestFile);
  assert.equal(migrated.status, 0, migrated.stderr);
  assert.equal(
    JSON.parse(migrated.stdout).destination_target,
    bindingIdentity(plan.destination_binding),
  );
});

test("pending rollback journal is refused before recovery without changing source", async (t) => {
  const { writeFileSync } = await import("node:fs");
  const { plan } = fixture(t);
  const before = readFileSync(plan.source);
  const journal = Buffer.from(
    "pending rollback recovery must not be attempted",
  );
  writeFileSync(plan.source + "-journal", journal, { mode: 0o600 });
  assert.throws(
    () => inspectNoticeMigration(plan),
    /journal_requires_offline_recovery/,
  );
  assert.deepEqual(readFileSync(plan.source), before);
  assert.deepEqual(readFileSync(plan.source + "-journal"), journal);
  assert.equal(existsSync(plan.destination_directory), false);
});

test("migration CLI never prints malformed private JSON or input paths", async (t) => {
  const { spawnSync } = await import("node:child_process");
  const { writeFileSync } = await import("node:fs");
  const { root } = fixture(t);
  const privateFile = join(root, "PRIVATE_PATH.json");
  writeFileSync(privateFile, '{"private":"SECRET_PRIVATE_CONTENT",broken}', {
    mode: 0o600,
  });
  for (const file of [privateFile, join(root, "SECRET_MISSING_PATH.json")]) {
    const result = spawnSync(
      process.execPath,
      ["scripts/hab-migrate-notices.ts", "inspect", file],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.deepEqual(JSON.parse(result.stderr), { error: "migration_failed" });
    assert.ok(!result.stderr.includes("SECRET"));
    assert.ok(!result.stderr.includes(root));
  }
});

test("pre-revision legacy schema migrates without resetting a settled decision", (t) => {
  const { plan, message } = fixture(t);
  const old = new DatabaseSync(plan.source);
  old.exec(
    "DROP TRIGGER notices_insert_revision; DROP TRIGGER notices_state_revision; ALTER TABLE notices DROP COLUMN revision; ALTER TABLE notices_meta DROP COLUMN revision;",
  );
  old.close();
  const before = readFileSync(plan.source);
  const report = inspectNoticeMigration(plan);
  migrateNoticesOffline(
    { ...plan, expected_source_sha256: report.source_sha256 },
    attestation,
  );
  assert.deepEqual(readFileSync(plan.source), before);
  const migrated = new SQLiteNotices(
    join(plan.destination_directory, "notices.sqlite"),
    bindingIdentity(plan.destination_binding),
  );
  assert.equal(migrated.get(message).state, "queued");
  assert.equal(migrated.get(message).revision, 0);
  assert.equal(migrated.insertShowing(message, 9), false);
  migrated.close();
});

async function hermesFixture(t) {
  const { writeFileSync } = await import("node:fs");
  const value = fixture(t);
  const { plan, message, root } = value;
  const legacy = ["session", "profile", "namespace", "scope", "recipient"];
  const oldTarget = "hermes-desktop:profile:session";
  const source = new DatabaseSync(plan.source);
  source.prepare("UPDATE notices_meta SET target=?").run(oldTarget);
  source.prepare("UPDATE notices SET state='later'").run();
  source.close();
  const notice = {
    type: "notice",
    sender_id: message.sender_id,
    message_id: message.message_id,
    from: message.from,
    display: message.display,
    binding: JSON.stringify(legacy),
    at: "2026-01-01T00:00:00Z",
  };
  const lines = [
    notice,
    {
      type: "state",
      sender_id: message.sender_id,
      message_id: message.message_id,
      state: "later",
      at: "2026-01-01T00:00:01Z",
    },
    { ...notice, at: "2026-01-01T00:00:02Z" },
  ];
  const screen = join(root, "old-screen.jsonl");
  writeFileSync(screen, lines.map((x) => JSON.stringify(x)).join("\n") + "\n", {
    mode: 0o600,
  });
  Object.assign(plan, {
    expected_source_target: oldTarget,
    destination_binding: {
      product: "hermes-desktop",
      session_id: legacy[0],
      profile: legacy[1],
      recipient_id: legacy[4],
      connection_id: JSON.stringify([
        "https://verified-host/hab/mcp",
        legacy[2],
        legacy[3],
      ]),
    },
    hermes_screen: { source: screen, legacy_binding: legacy },
  });
  return { ...value, lines, legacy, screen };
}
function reviewedPair(plan) {
  const inspection = inspectNoticeMigration(plan);
  return {
    ...plan,
    expected_source_sha256: inspection.source_sha256,
    hermes_screen: {
      ...plan.hermes_screen,
      expected_source_sha256: inspection.screen_source_sha256,
    },
  };
}
test("paired Hermes migration preserves cursor/event identity, every line and current decisions", async (t) => {
  const { hermesDesktopPage } =
    await import("../src/agent-notify/hermes-desktop.ts");
  const { plan, message, lines, legacy, screen } = await hermesFixture(t);
  const before = readFileSync(screen),
    dbBefore = readFileSync(plan.source);
  const reviewed = reviewedPair(plan);
  migrateNoticesOffline(reviewed, attestation);
  assert.deepEqual(readFileSync(screen), before);
  assert.deepEqual(readFileSync(plan.source), dbBefore);
  assert.deepEqual(
    readFileSync(join(plan.destination_directory, "source-screen.jsonl")),
    before,
  );
  const transformed = readFileSync(
    join(plan.destination_directory, "screen.jsonl"),
    "utf8",
  )
    .trimEnd()
    .split("\n")
    .map((x) => JSON.parse(x));
  assert.deepEqual(
    transformed,
    lines.map((x) =>
      x.type === "notice"
        ? {
            ...x,
            binding: JSON.stringify([
              ...legacy,
              "https://verified-host/hab/mcp",
            ]),
          }
        : x,
    ),
  );
  const binding = {
    session_id: legacy[0],
    profile: legacy[1],
    backend_namespace: legacy[2],
    profile_scope: legacy[3],
    receiver_id: legacy[4],
    connection_id: "https://verified-host/hab/mcp",
  };
  const page = hermesDesktopPage(
    join(plan.destination_directory, "screen.jsonl"),
    binding,
    { limit: 10 },
  );
  assert.deepEqual(
    page.events.map((x) => x.event_id),
    ["sender:message:0", "sender:message:1"],
  );
  assert.equal(page.next_cursor, "2");
  assert.equal(
    hermesDesktopPage(
      join(plan.destination_directory, "screen.jsonl"),
      binding,
      { limit: 10, after: "1" },
    ).events[0].event_id,
    "sender:message:1",
  );
  const migrated = new SQLiteNotices(
    join(plan.destination_directory, "notices.sqlite"),
    bindingIdentity(plan.destination_binding),
  );
  assert.equal(migrated.get(message).state, "later");
  assert.equal(migrated.insertShowing(message, 10), false);
  migrated.close();
});
test("paired migration rejects missing notices, mixed binding, changed payload and unknown lines", async (t) => {
  const { writeFileSync } = await import("node:fs");
  const { plan, screen, lines } = await hermesFixture(t);
  for (const [text, error] of [
    ["", /missing_notice/],
    [
      JSON.stringify({ ...lines[0], binding: '["other"]' }) + "\n",
      /binding_mismatch/,
    ],
    [
      JSON.stringify({ ...lines[0], display: "altered" }) + "\n",
      /payload_mismatch/,
    ],
    [
      JSON.stringify({ ...lines[0], decision_choices: ["accept"] }) + "\n",
      /unsupported_schema/,
    ],
    [JSON.stringify(lines[0]), /incomplete/],
    [
      JSON.stringify({ ...lines[0], message_id: "absent" }) + "\n",
      /missing_decision/,
    ],
  ]) {
    writeFileSync(screen, text);
    assert.throws(() => inspectNoticeMigration(plan), error);
    assert.equal(existsSync(plan.destination_directory), false);
  }
});
test("paired migration refuses fingerprint drift, destination mismatch and unsupported DB schema", async (t) => {
  const { appendFileSync } = await import("node:fs");
  const { plan, screen } = await hermesFixture(t);
  const reviewed = reviewedPair(plan);
  assert.throws(
    () =>
      migrateNoticesOffline(
        {
          ...reviewed,
          hermes_screen: {
            ...reviewed.hermes_screen,
            expected_source_sha256: undefined,
          },
        },
        attestation,
      ),
    /fingerprint_required/,
  );
  assert.throws(
    () =>
      inspectNoticeMigration({
        ...plan,
        destination_binding: {
          ...plan.destination_binding,
          recipient_id: "another",
        },
      }),
    /binding_mismatch/,
  );
  appendFileSync(screen, "\n");
  assert.throws(
    () => migrateNoticesOffline(reviewed, attestation),
    /screen_changed/,
  );
  const db = new DatabaseSync(plan.source);
  db.exec("ALTER TABLE notices ADD COLUMN future_data TEXT");
  db.close();
  assert.throws(() => inspectNoticeMigration(plan), /unsupported_schema/);
});

test("paired migration catches a writer changing JSONL during staging and publishes neither file", async (t) => {
  const fs = await import("node:fs");
  const { syncBuiltinESMExports } = await import("node:module");
  const { plan, screen } = await hermesFixture(t);
  const reviewed = reviewedPair(plan);
  const original = fs.default.fsyncSync;
  let changed = false;
  fs.default.fsyncSync = (fd) => {
    if (!changed) {
      changed = true;
      fs.appendFileSync(screen, "\n");
    }
    return original(fd);
  };
  syncBuiltinESMExports();
  try {
    assert.throws(
      () => migrateNoticesOffline(reviewed, attestation),
      /screen_changed/,
    );
    assert.equal(existsSync(plan.destination_directory), false);
    assert.equal(
      existsSync(plan.destination_directory + ".migration-lock"),
      false,
    );
  } finally {
    fs.default.fsyncSync = original;
    syncBuiltinESMExports();
  }
});
test("paired migration rejects oversized screen without reading its contents", async (t) => {
  const { truncateSync } = await import("node:fs");
  const { plan, screen } = await hermesFixture(t);
  truncateSync(screen, 64 * 1024 * 1024 + 1);
  assert.throws(() => inspectNoticeMigration(plan), /screen_too_large/);
});

test("legacy Hermes refuses DB-only migration so existing cards cannot disappear", async (t) => {
  const { plan } = await hermesFixture(t);
  const reviewed = reviewedPair(plan);
  const { hermes_screen: omitted, ...dbOnly } = reviewed;
  assert.ok(omitted);
  const before = readFileSync(plan.source);
  assert.throws(
    () => inspectNoticeMigration(dbOnly),
    /migration_hermes_screen_required/,
  );
  assert.throws(
    () => migrateNoticesOffline(dbOnly, attestation),
    /migration_hermes_screen_required/,
  );
  assert.deepEqual(readFileSync(plan.source), before);
  assert.equal(existsSync(plan.destination_directory), false);
});

test("paired migration retains reply-specific choices in the authoritative message", async (t) => {
  const { plan, message } = await hermesFixture(t);
  const choices = [
    { choice: "accept", label: "会話に渡す" },
    { choice: "later", label: "後で" },
  ];
  const source = new DatabaseSync(plan.source);
  const original = JSON.stringify({ ...message, choices });
  source.prepare("UPDATE notices SET message=?").run(original);
  source.close();
  migrateNoticesOffline(reviewedPair(plan), attestation);
  const destination = new DatabaseSync(
    join(plan.destination_directory, "notices.sqlite"),
  );
  try {
    const migrated = destination
      .prepare("SELECT message FROM notices")
      .get().message;
    assert.equal(migrated, original);
    assert.deepEqual(JSON.parse(migrated).choices, choices);
  } finally {
    destination.close();
  }
});
