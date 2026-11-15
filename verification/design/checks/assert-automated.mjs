#!/usr/bin/env node
// HAB CI gate for the automated subset. Never promotes manual checks to verified.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { tmpdir } from "node:os";

const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const hash = (value, label) =>
  assert(
    typeof value === "string" && /^[a-f0-9]{64}$/.test(value),
    `invalid ${label} hash`,
  );
const object = (value, label) =>
  assert(
    value && typeof value === "object" && !Array.isArray(value),
    `${label} must be an object`,
  );
const json = (path) => JSON.parse(readFileSync(path, "utf8"));
const equal = (actual, expected, label) =>
  assert.deepEqual(actual, expected, label);
const list = (value, label) => {
  assert(Array.isArray(value), `${label} must be an array`);
  return value;
};
const nonempty = (value, label) =>
  assert(
    typeof value === "string" && value.length > 0,
    `${label} must be nonempty`,
  );

function byId(values, label) {
  const map = new Map();
  for (const value of list(values, label)) {
    object(value, label);
    assert(
      typeof value.id === "string" &&
        /^[A-Za-z][A-Za-z0-9_-]{0,79}$/.test(value.id),
      `invalid ${label} id`,
    );
    assert(!map.has(value.id), `duplicate ${label}: ${value.id}`);
    map.set(value.id, value);
  }
  return map;
}

function sameKeys(map, keys, label) {
  equal(
    [...map.keys()].sort(),
    [...keys].sort(),
    `${label}: missing or extra IDs`,
  );
}

function localFile(root, name) {
  assert(
    typeof name === "string" && name && !isAbsolute(name),
    "evidence path must be relative",
  );
  const path = realpathSync(join(root, name));
  const rel = relative(root, path);
  assert(
    rel && rel !== ".." && !rel.startsWith("../") && !isAbsolute(rel),
    "evidence path escapes run directory",
  );
  assert(statSync(path).isFile(), `missing regular evidence file: ${name}`);
  return path;
}

function checkTestLog(check, recorded, content) {
  if (check.protocol === "node-tap") {
    const totals = {};
    for (const key of [
      "tests",
      "pass",
      "fail",
      "skipped",
      "cancelled",
      "todo",
    ]) {
      const matches = [
        ...content.matchAll(new RegExp(`^# ${key} (\\d+)\\s*$`, "gm")),
      ];
      assert.equal(
        matches.length,
        1,
        `${check.id}: missing/duplicate TAP ${key}`,
      );
      totals[key] = Number(matches[0][1]);
      assert(
        Number.isSafeInteger(totals[key]),
        `${check.id}: unsafe TAP total`,
      );
    }
    assert(totals.pass > 0, `${check.id}: zero passed tests`);
    for (const key of ["fail", "skipped", "cancelled", "todo"])
      assert.equal(totals[key], 0, `${check.id}: TAP ${key}`);
    assert.equal(
      totals.tests,
      totals.pass,
      `${check.id}: inconsistent TAP totals`,
    );
    assert.equal(
      recorded.passed_tests,
      totals.pass,
      `${check.id}: passed_tests differs from actual TAP log`,
    );
  } else if (check.protocol === "python-unittest") {
    const totals = [...content.matchAll(/^Ran (\d+) tests? in .+$/gm)];
    const summaries = [...content.matchAll(/^OK(?: \([^\n]+\))?$/gm)];
    assert.equal(
      totals.length,
      1,
      `${check.id}: missing/duplicate unittest total`,
    );
    assert.equal(
      summaries.length,
      1,
      `${check.id}: missing/duplicate unittest summary`,
    );
    assert.equal(
      summaries[0][0],
      "OK",
      `${check.id}: skipped/expected failure unittest summary`,
    );
    const passed = Number(totals[0][1]);
    assert(
      Number.isSafeInteger(passed) && passed > 0,
      `${check.id}: zero/invalid passed tests`,
    );
    assert.equal(
      recorded.passed_tests,
      passed,
      `${check.id}: passed_tests differs from actual unittest log`,
    );
  } else {
    assert.equal(
      check.protocol,
      "exit",
      `${check.id}: unreviewed command protocol`,
    );
  }
}

function roundtripEvidence(out, check, expand) {
  // This is intentionally HAB-specific, not a substitute implementation of the generic runner.
  assert(
    check.argv.includes("{evidence}/mcp-roundtrip"),
    "roundtrip evidence argv is not the reviewed path",
  );
  const folder = realpathSync(expand("{evidence}/mcp-roundtrip"));
  assert.equal(
    dirname(folder),
    out,
    "roundtrip evidence escaped report directory",
  );
  const proof = json(localFile(folder, "proof.json")),
    cleanup = json(localFile(folder, "cleanup.json"));
  assert.equal(proof.status, "pass", "roundtrip proof did not pass");
  for (const key of [
    "syntheticAuthority",
    "sameIdReplay",
    "receiverCleanReopen",
  ])
    assert.equal(proof[key], true, `roundtrip proof missing ${key}`);
  assert.equal(proof.failure, null, "roundtrip proof has failure");
  assert(
    /^v(?:2[4-9]|[3-9][0-9]|[1-9][0-9]{2,})\./.test(proof.node),
    "roundtrip Node <24 or missing identity",
  );
  for (const key of [
    "exitObserved",
    "gracefulExit",
    "storesRemoved",
    "evidenceRetained",
  ])
    assert.equal(cleanup[key], true, `roundtrip cleanup missing ${key}`);
  assert.equal(
    cleanup.forcedTermination,
    false,
    "roundtrip forced cleanup is not a clean pass",
  );
  assert(
    Number.isSafeInteger(cleanup.ownedPid) && cleanup.ownedPid > 0,
    "roundtrip missing owned PID",
  );
  equal(cleanup.errors, [], "roundtrip cleanup errors");
  equal(
    cleanup.exit,
    { code: 0, signal: null, error: null },
    "roundtrip child exit mismatch",
  );
  const stackLog = readFileSync(localFile(folder, "stack.log"), "utf8");
  assert(
    stackLog.includes("HAB_VERIFY_READY ") &&
      stackLog.includes("HAB_VERIFY_STOPPED"),
    "roundtrip missing start/clean-stop log markers",
  );
  const traceText = readFileSync(localFile(folder, "trace.jsonl"), "utf8");
  const trace = traceText
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const events = (name) =>
    trace
      .map((row, index) => ({ ...row, index }))
      .filter((row) => row.event === name);
  const one = (name) => {
    const found = events(name);
    assert.equal(found.length, 1, `roundtrip missing/duplicate ${name}`);
    return found[0];
  };
  assert.equal(
    events("failure").length,
    0,
    "roundtrip trace records a failure",
  );
  assert.equal(
    events("independent_pre_ack_rejected").length,
    0,
    "roundtrip pre-ACK gate rejected evidence",
  );
  const doctor = one("doctor");
  assert.equal(
    doctor.value.ownedPid,
    cleanup.ownedPid,
    "doctor owned PID differs from cleanup",
  );
  assert.equal(doctor.value.unauthenticatedStatus, 401);
  const url = new URL(doctor.value.url);
  assert.equal(url.protocol, "http:");
  assert.equal(url.hostname, "127.0.0.1");
  assert.equal(url.pathname, "/mcp");
  assert(
    Number(url.port) > 0 && Number(url.port) < 65536,
    "doctor missing ephemeral port",
  );
  const requests = events("request"),
    responses = events("response");
  // SQLite delivery makes an accepted message pollable at once; the helper still tolerates a bounded repeat poll (5 s at 25 ms).
  const names = requests.map((row) => row.value.params?.name);
  let polls = 0;
  while (names[3 + polls] === "hab_poll") polls++;
  assert(polls >= 1 && polls <= 201, "roundtrip poll retry count out of range");
  equal(
    names,
    [
      "hab_resolve",
      "hab_submit",
      "hab_submit",
      ...Array(polls).fill("hab_poll"),
      "hab_ack",
      "hab_status",
      "hab_poll",
    ],
    "roundtrip missing/extra/reordered MCP operations",
  );
  for (let i = 3; i < 3 + polls - 1; i++)
    assert.equal(
      JSON.parse(responses[i].value.body).result?.structuredContent?.delivery,
      null,
      "roundtrip retried a poll that returned a delivery",
    );
  const ackAt = 3 + polls,
    statusAt = ackAt + 1;
  assert.equal(
    responses.length,
    requests.length,
    "roundtrip missing responses",
  );
  for (let i = 0; i < requests.length; i++) {
    assert(
      requests[i].index < responses[i].index &&
        (i === requests.length - 1 ||
          responses[i].index < requests[i + 1].index),
      "roundtrip request/response trace order mismatch",
    );
    assert.equal(responses[i].value.status, 200, "roundtrip non-200 response");
    nonempty(responses[i].value.body, "roundtrip response body");
  }
  equal(
    requests[1].value.params.arguments,
    requests[2].value.params.arguments,
    "roundtrip replay body changed",
  );
  const messageId = requests[1].value.params.arguments.message_id;
  nonempty(messageId, "roundtrip submitted message ID");
  const beforeAck = one("independent_pre_ack_read"),
    ack = requests[ackAt].value.params.arguments;
  assert(
    requests[ackAt].index < beforeAck.index &&
      beforeAck.index < responses[ackAt].index,
    "pre-ACK observation outside actual ACK boundary",
  );
  for (const key of ["committedBody", "originalPendingAck", "observerReadOnly"])
    assert.equal(beforeAck.value[key], true, `roundtrip pre-ACK ${key}`);
  assert.equal(beforeAck.value.receiptConfirmed, false);
  assert.equal(beforeAck.value.messageId, messageId);
  assert.equal(ack.message_id, messageId);
  assert.equal(beforeAck.value.requestId, ack.request_id);
  nonempty(ack.request_id, "original ACK ID");
  const replay = one("same_id_replay");
  assert.equal(replay.value.sameReceipt, true);
  assert.equal(replay.value.messageId, messageId);
  const reopen = one("receiver_clean_reopen");
  assert.equal(reopen.value.body, "unchanged");
  assert.equal(reopen.value.receiptConfirmed, true);
  assert.equal(reopen.value.keyedIntegrityRead, true);
  assert(
    beforeAck.index < reopen.index && reopen.index < requests[statusAt].index,
    "receiver reopen trace order mismatch",
  );
  assert(
    readFileSync(
      localFile(folder, "scaffold/evidence/audit.jsonl"),
      "utf8",
    ).trim(),
    "missing retained scaffold audit evidence",
  );
  assert(
    !existsSync(join(folder, "scaffold/instance")),
    "disposable scaffold stores remain despite cleanup claim",
  );
  for (const name of [
    "receiver.sqlite",
    "receiver.sqlite-wal",
    "receiver.sqlite-shm",
  ])
    assert(
      !existsSync(join(folder, name)),
      "receiver store remains despite cleanup claim",
    );
}

function inspect(reportPath, contractPath) {
  reportPath = realpathSync(reportPath);
  contractPath = realpathSync(contractPath);
  const out = dirname(reportPath),
    bundle = dirname(contractPath);
  const bytes = readFileSync(contractPath),
    spec = JSON.parse(bytes),
    report = json(reportPath);
  assert.equal(spec.version, 1);
  assert.equal(report.version, 1);
  equal(report.project, spec.project, "report/contract project mismatch");
  assert.equal(report.spec_sha256, sha(bytes), "contract hash drift");
  assert.equal(report.executed, true, "report was not executed");
  assert(
    ["incomplete", "pass"].includes(report.overall),
    "overall must be incomplete or pass",
  );
  equal(report.drift, [], "run drift is not empty");
  object(report.before, "before");
  equal(report.before, report.after, "target snapshot changed during run");
  assert(
    /^[a-f0-9]{40,64}$/.test(report.before.commit),
    "missing target commit",
  );
  hash(report.before.visible_tree_sha256, "target tree");
  assert.equal(typeof report.before.status, "string");
  object(report.verification_inputs_before, "verification inputs");
  equal(
    report.verification_inputs_before,
    report.verification_inputs_after,
    "verification inputs changed during run",
  );
  hash(report.runner_sha256, "runner");
  assert.equal(report.runner_sha256, report.verification_inputs_before.runner);
  const checks = byId(spec.checks, "contract check"),
    requirements = byId(spec.requirements, "contract requirement");
  const observed = byId(report.checks, "report check"),
    observedRequirements = byId(report.requirements, "report requirement");
  assert(requirements.size > 0, "empty requirement set");
  const used = new Set();
  for (const req of requirements.values()) {
    assert(
      ["accepted", "unresolved", "proposed", "historical"].includes(
        req.decision,
      ),
      "unrecognized requirement decision",
    );
    const refs = list(req.checks, `${req.id} checks`);
    assert(
      refs.length > 0 && new Set(refs).size === refs.length,
      "empty/duplicate requirement check reference",
    );
    for (const id of refs) {
      assert(checks.has(id), `undefined requirement check ${id}`);
      if (["accepted", "unresolved"].includes(req.decision)) used.add(id);
    }
  }
  assert(used.size > 0, "empty active check set");
  sameKeys(observed, used, "required checks");
  sameKeys(observedRequirements, requirements.keys(), "requirements");
  const commands = [...checks.values()].filter(
    (check) => check.kind === "command",
  );
  for (const check of checks.values())
    assert(
      ["command", "manual"].includes(check.kind),
      "unrecognized check kind",
    );
  const targetCandidates = new Set();
  for (const check of commands.filter((check) => used.has(check.id))) {
    list(check.argv, `${check.id} argv`);
    const actual = list(
      observed.get(check.id).argv,
      `${check.id} recorded argv`,
    );
    for (let i = 0; i < check.argv.length; i++)
      if (check.argv[i] === "{target}") {
        assert(
          typeof actual[i] === "string" && isAbsolute(actual[i]),
          "missing absolute target argv",
        );
        targetCandidates.add(actual[i]);
      }
  }
  assert.equal(
    targetCandidates.size,
    1,
    "report must contain one consistent explicit target expansion",
  );
  const target = [...targetCandidates][0];
  const expand = (value) =>
    value
      .replaceAll("{target}", target)
      .replaceAll("{evidence}", out)
      .replaceAll("{bundle}", bundle);
  const helpers = {};
  for (const check of commands) {
    const inputs = {};
    for (const arg of check.argv.map(expand))
      if (isAbsolute(arg)) {
        const rel = relative(bundle, arg);
        if (
          rel !== ".." &&
          !rel.startsWith("../") &&
          !isAbsolute(rel) &&
          (!existsSync(arg) || !statSync(arg).isDirectory())
        ) {
          assert(
            existsSync(arg) && statSync(arg).isFile(),
            `${check.id}: helper file missing`,
          );
          inputs[arg] = sha(readFileSync(arg));
        }
      }
    helpers[check.id] = inputs;
  }
  equal(
    report.verification_inputs_before.helpers,
    helpers,
    "verification helper set/hash differs from actual contract inputs",
  );
  const manual = [],
    automated = [];
  for (const id of used) {
    const check = checks.get(id),
      recorded = observed.get(id);
    for (const key of ["tier", "proves", "limitations"])
      equal(recorded[key], check[key], `${id}: metadata differs from contract`);
    if (check.kind === "manual") {
      manual.push(id);
      assert.equal(
        recorded.status,
        "unverified",
        `${id}: manual forged as verified`,
      );
      assert.equal(
        recorded.reason,
        check.instructions,
        `${id}: manual recipe mismatch`,
      );
      for (const key of [
        "argv",
        "exit_code",
        "log",
        "cleanup",
        "passed_tests",
        "bundle_inputs_before",
        "bundle_inputs_after",
      ])
        assert(
          !Object.hasOwn(recorded, key),
          `${id}: manual has fabricated command evidence`,
        );
      continue;
    }
    automated.push(id);
    assert.equal(
      recorded.status,
      "pass",
      `${id}: automated check did not pass`,
    );
    assert.equal(recorded.exit_code, 0, `${id}: nonzero/missing exit code`);
    assert.equal(recorded.cleanup, "confirmed", `${id}: cleanup not confirmed`);
    assert.equal(recorded.scratch_retained, null, `${id}: scratch retained`);
    equal(
      recorded.argv,
      check.argv.map(expand),
      `${id}: executed argv differs from contract`,
    );
    assert(
      Number.isFinite(recorded.duration_seconds) &&
        recorded.duration_seconds >= 0,
      `${id}: missing duration`,
    );
    equal(
      recorded.bundle_inputs_before,
      helpers[id],
      `${id}: helper input before mismatch`,
    );
    equal(
      recorded.bundle_inputs_after,
      helpers[id],
      `${id}: helper input after mismatch`,
    );
    assert.equal(recorded.log, `${id}.log`, `${id}: unexpected log path`);
    const log = readFileSync(localFile(out, recorded.log));
    assert.equal(recorded.log_sha256, sha(log), `${id}: log hash mismatch`);
    checkTestLog(check, recorded, log.toString("utf8"));
  }
  assert(automated.length > 0, "no active automated checks");
  equal(
    report.conflicts,
    spec.conflicts ?? [],
    "conflict report differs from contract",
  );
  const conflicts = byId(spec.conflicts ?? [], "conflict");
  for (const req of requirements.values()) {
    const actual = observedRequirements.get(req.id);
    const open = [...conflicts.values()]
      .filter((c) => c.status === "open" && c.requirements.includes(req.id))
      .map((c) => c.id);
    const expectedStatus = ["proposed", "historical"].includes(req.decision)
      ? "not-enforced"
      : open.length || req.decision === "unresolved"
        ? "blocked"
        : req.checks.every((id) => observed.get(id).status === "pass")
          ? "pass"
          : "unverified";
    for (const key of ["title", "scope", "checks"])
      equal(actual[key], req[key], `${req.id}: requirement ${key} mismatch`);
    equal(actual.open_conflicts, open, `${req.id}: conflict mapping mismatch`);
    assert.equal(
      actual.status,
      expectedStatus,
      `${req.id}: requirement status is inconsistent`,
    );
  }
  const expectedOverall = [...observedRequirements.values()]
    .filter((req) => req.status !== "not-enforced")
    .every((req) => req.status === "pass")
    ? "pass"
    : "incomplete";
  assert.equal(
    report.overall,
    expectedOverall,
    "overall inconsistent with requirements/manual scope",
  );
  if (manual.length)
    assert.equal(
      report.overall,
      "incomplete",
      "manual checks cannot produce overall pass",
    );
  assert(
    used.has("mcp-durable-roundtrip") &&
      checks.get("mcp-durable-roundtrip").kind === "command",
    "required real roundtrip check missing",
  );
  roundtripEvidence(out, checks.get("mcp-durable-roundtrip"), expand);
  return {
    status: "pass",
    scope: "automated subset only; manual requirements remain unverified",
    overall: report.overall,
    automated: automated.sort(),
    manualUnverified: manual.sort(),
    limitations:
      "Consistency gate over trusted contract/report/artifacts, not signed provenance, source-semantic review, native/production compliance or an independent rerun of product behavior.",
  };
}

function selfTest() {
  const scratch = realpathSync(
    mkdtempSync(join(tmpdir(), "hab-automated-gate-")),
  );
  const reportPath = join(scratch, "run/report.json"),
    contractPath = join(scratch, "bundle/contract.json");
  const put = (path, value) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(
      path,
      typeof value === "string" ? value : JSON.stringify(value, null, 2) + "\n",
    );
  };
  const fixture = ({ emptyPolls = 0, retriedDelivery = false } = {}) => {
    rmSync(scratch, { recursive: true, force: true });
    mkdirSync(scratch, { recursive: true });
    const target = join(scratch, "target"),
      bundle = dirname(contractPath),
      out = dirname(reportPath),
      round = join(out, "mcp-roundtrip");
    mkdirSync(target);
    put(
      join(bundle, "synthetic.mjs"),
      "// Synthetic gate input; never executed.\n",
    );
    const defs = [
      {
        id: "node-suite",
        kind: "command",
        protocol: "node-tap",
        argv: ["node", "{bundle}/synthetic.mjs", "{target}"],
      },
      {
        id: "python-suite",
        kind: "command",
        protocol: "python-unittest",
        argv: ["python3", "{bundle}/synthetic.mjs"],
      },
      {
        id: "mcp-durable-roundtrip",
        kind: "command",
        protocol: "exit",
        argv: [
          "node",
          "{bundle}/synthetic.mjs",
          "{target}",
          "{evidence}/mcp-roundtrip",
        ],
      },
      {
        id: "native-manual",
        kind: "manual",
        instructions: "Not run; native behavior unverified.",
      },
    ].map((check) => ({
      tier: "synthetic-gate-control",
      proves: "Gate control only",
      limitations: "No product behavior",
      ...check,
    }));
    const req = {
      id: "synthetic-requirement",
      decision: "accepted",
      title: "Synthetic",
      scope: "gate control only",
      checks: defs.map((check) => check.id),
    };
    const spec = {
      version: 1,
      project: {
        name: "HAB gate control",
        repository: "synthetic",
        baseline: "a".repeat(40),
      },
      checks: defs,
      requirements: [req],
      conflicts: [],
    };
    put(contractPath, spec);
    const expand = (value) =>
      value
        .replaceAll("{bundle}", bundle)
        .replaceAll("{target}", target)
        .replaceAll("{evidence}", out);
    const helperInputs = {
      [join(bundle, "synthetic.mjs")]: sha(
        readFileSync(join(bundle, "synthetic.mjs")),
      ),
    };
    const results = defs.map((check) => {
      const base = {
        id: check.id,
        tier: check.tier,
        proves: check.proves,
        limitations: check.limitations,
      };
      if (check.kind === "manual")
        return { ...base, status: "unverified", reason: check.instructions };
      const log =
        check.protocol === "node-tap"
          ? "# tests 1\n# pass 1\n# fail 0\n# skipped 0\n# cancelled 0\n# todo 0\n"
          : check.protocol === "python-unittest"
            ? "Ran 1 test in 0.001s\n\nOK\n"
            : "Synthetic gate control artifact, not product evidence.\n";
      put(join(out, `${check.id}.log`), log);
      return {
        ...base,
        status: "pass",
        exit_code: 0,
        cleanup: "confirmed",
        scratch_retained: null,
        duration_seconds: 0.001,
        argv: check.argv.map(expand),
        log: `${check.id}.log`,
        log_sha256: sha(log),
        bundle_inputs_before: helperInputs,
        bundle_inputs_after: helperInputs,
        ...(check.protocol === "exit" ? {} : { passed_tests: 1 }),
      };
    });
    const inputs = {
      runner: "c".repeat(64),
      helpers: Object.fromEntries(
        defs
          .filter((c) => c.kind === "command")
          .map((c) => [c.id, helperInputs]),
      ),
    };
    const snapshot = {
      commit: "a".repeat(40),
      visible_tree_sha256: "b".repeat(64),
      status: "",
    };
    const report = {
      version: 1,
      project: spec.project,
      spec_sha256: sha(readFileSync(contractPath)),
      overall: "incomplete",
      executed: true,
      before: snapshot,
      after: snapshot,
      runner_sha256: inputs.runner,
      verification_inputs_before: inputs,
      verification_inputs_after: inputs,
      drift: [],
      checks: results,
      requirements: [
        {
          id: req.id,
          title: req.title,
          scope: req.scope,
          status: "unverified",
          checks: req.checks,
          open_conflicts: [],
        },
      ],
      conflicts: [],
    };
    put(join(round, "proof.json"), {
      status: "pass",
      syntheticAuthority: true,
      sameIdReplay: true,
      receiverCleanReopen: true,
      node: "v24.0.0",
      failure: null,
    });
    put(join(round, "cleanup.json"), {
      ownedPid: 12345,
      exitObserved: true,
      gracefulExit: true,
      forcedTermination: false,
      storesRemoved: true,
      evidenceRetained: true,
      errors: [],
      exit: { code: 0, signal: null, error: null },
    });
    put(
      join(round, "stack.log"),
      "HAB_VERIFY_READY http://127.0.0.1:12345/mcp\nHAB_VERIFY_STOPPED\n",
    );
    put(
      join(round, "scaffold/evidence/audit.jsonl"),
      '{"category":"synthetic-gate-control"}\n',
    );
    const trace = [
      {
        event: "doctor",
        value: {
          ownedPid: 12345,
          unauthenticatedStatus: 401,
          url: "http://127.0.0.1:12345/mcp",
        },
      },
    ];
    const names = [
      "hab_resolve",
      "hab_submit",
      "hab_submit",
      ...Array(emptyPolls + 1).fill("hab_poll"),
      "hab_ack",
      "hab_status",
      "hab_poll",
    ];
    let pollsSeen = 0;
    for (const name of names) {
      const args =
        name === "hab_submit"
          ? { message_id: "synthetic-message", body: "synthetic" }
          : name === "hab_ack"
            ? { message_id: "synthetic-message", request_id: "original-ack" }
            : {};
      trace.push({
        event: "request",
        value: { params: { name, arguments: args } },
      });
      if (name === "hab_ack")
        trace.push({
          event: "independent_pre_ack_read",
          value: {
            messageId: "synthetic-message",
            requestId: "original-ack",
            committedBody: true,
            originalPendingAck: true,
            observerReadOnly: true,
            receiptConfirmed: false,
          },
        });
      const retried = name === "hab_poll" && pollsSeen++ < emptyPolls;
      const body = retried
        ? JSON.stringify({
            result: {
              structuredContent: {
                delivery: retriedDelivery ? { message_id: "x" } : null,
              },
            },
          })
        : "{}";
      trace.push({ event: "response", value: { status: 200, body } });
      if (
        name === "hab_submit" &&
        trace.filter(
          (r) => r.event === "request" && r.value.params.name === name,
        ).length === 2
      )
        trace.push({
          event: "same_id_replay",
          value: { sameReceipt: true, messageId: "synthetic-message" },
        });
      if (name === "hab_ack")
        trace.push({
          event: "receiver_clean_reopen",
          value: {
            body: "unchanged",
            receiptConfirmed: true,
            keyedIntegrityRead: true,
          },
        });
    }
    put(
      join(round, "trace.jsonl"),
      trace.map((row) => JSON.stringify(row)).join("\n") + "\n",
    );
    put(reportPath, report);
    return { report: json(reportPath), round, out, bundle };
  };
  try {
    fixture({ emptyPolls: 2 });
    assert.equal(inspect(reportPath, contractPath).status, "pass");
    fixture();
    assert.equal(inspect(reportPath, contractPath).status, "pass");
    const controls = [
      ["missing report", () => rmSync(reportPath)],
      ["missing log", (f) => rmSync(join(f.out, "node-suite.log"))],
      [
        "zero tests",
        (f) => {
          f.report.checks[0].passed_tests = 0;
          put(reportPath, f.report);
        },
      ],
      [
        "skipped check status",
        (f) => {
          f.report.checks[0].status = "unverified";
          put(reportPath, f.report);
        },
      ],
      [
        "manual forged pass",
        (f) => {
          f.report.checks[3].status = "pass";
          put(reportPath, f.report);
        },
      ],
      [
        "contract hash drift",
        (f) => {
          f.report.spec_sha256 = "d".repeat(64);
          put(reportPath, f.report);
        },
      ],
      [
        "failed cleanup",
        (f) => {
          f.report.checks[0].cleanup = "unconfirmed";
          put(reportPath, f.report);
        },
      ],
      [
        "partial check set",
        (f) => {
          f.report.checks.splice(1, 1);
          put(reportPath, f.report);
        },
      ],
      [
        "duplicate check",
        (f) => {
          f.report.checks.push(f.report.checks[0]);
          put(reportPath, f.report);
        },
      ],
      [
        "extra check",
        (f) => {
          f.report.checks.push({ ...f.report.checks[0], id: "extra" });
          put(reportPath, f.report);
        },
      ],
      ["log hash drift", (f) => put(join(f.out, "node-suite.log"), "changed")],
      [
        "helper hash drift",
        (f) => put(join(f.bundle, "synthetic.mjs"), "changed"),
      ],
      [
        "verification input drift",
        (f) => {
          f.report.verification_inputs_after.runner = "e".repeat(64);
          put(reportPath, f.report);
        },
      ],
      [
        "target snapshot drift",
        (f) => {
          f.report.after.status = "changed";
          put(reportPath, f.report);
        },
      ],
      [
        "roundtrip proof failure",
        (f) => put(join(f.round, "proof.json"), { status: "fail" }),
      ],
      [
        "roundtrip cleanup failure",
        (f) => {
          const c = json(join(f.round, "cleanup.json"));
          c.gracefulExit = false;
          put(join(f.round, "cleanup.json"), c);
        },
      ],
      ["missing trace", (f) => rmSync(join(f.round, "trace.jsonl"))],
      [
        "retried poll that returned a delivery",
        () => fixture({ emptyPolls: 1, retriedDelivery: true }),
      ],
      [
        "forged passed status over skipped TAP",
        (f) => {
          const log =
            "# tests 2\n# pass 1\n# fail 0\n# skipped 1\n# cancelled 0\n# todo 0\n";
          put(join(f.out, "node-suite.log"), log);
          f.report.checks[0].log_sha256 = sha(log);
          put(reportPath, f.report);
        },
      ],
      [
        "overall forged pass with manual",
        (f) => {
          f.report.overall = "pass";
          put(reportPath, f.report);
        },
      ],
    ];
    for (const [name, mutate] of controls) {
      const f = fixture();
      mutate(f);
      assert.throws(() => inspect(reportPath, contractPath), undefined, name);
    }
    console.log(
      JSON.stringify({
        status: "pass",
        scope: "gate controls only; no product/server behavior exercised",
        negativeControls: controls.map(([name]) => name),
        positiveControl:
          "complete internally consistent synthetic report/artifacts; manual remains unverified",
      }),
    );
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

const args = process.argv.slice(2);
if (args.length === 1 && args[0] === "--self-test") selfTest();
else {
  assert(
    args.length === 2,
    "usage: node assert-automated.mjs REPORT.json CONTRACT.json | --self-test",
  );
  console.log(JSON.stringify(inspect(resolve(args[0]), resolve(args[1]))));
}
