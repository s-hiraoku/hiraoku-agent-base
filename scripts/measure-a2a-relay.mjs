import assert from "node:assert/strict";
import process from "node:process";
import os from "node:os";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";

const args = process.argv.slice(2);
if (
  args.length !== 2 ||
  args[0] !== "--output" ||
  !args[1] ||
  args[1].startsWith("--")
)
  throw Error(
    "Use --output <new-directory>. The workload is fixed at 5 runs of 5 tasks.",
  );
const output = resolve(args[1]);
mkdirSync(output, { mode: 0o700 });
const scratch = join(realpathSync(output), "tmp");
mkdirSync(scratch, { mode: 0o700 });
process.env.TMPDIR = scratch;
const root = fileURLToPath(new URL("..", import.meta.url));
const git = (...args) =>
  execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
const hash = (data) => createHash("sha256").update(data).digest("hex");
const write = (name, value) =>
  writeFileSync(join(output, name), JSON.stringify(value, null, 2) + "\n", {
    mode: 0o600,
  });
const claim = {
  claim:
    "Characterize this fixed local P1-P3 route with 5 runs of 5 validated completed tasks at concurrency 1, including one lost-submit-response recovery per run.",
  interpretation:
    "Achieved harness rate and elapsed times on a shared host. No production SLO, saturation, capacity, adoption, or comparative performance conclusion.",
  workload: {
    measured_runs: 5,
    tasks_per_run: 5,
    concurrency: 1,
    expected_faults_per_run: 1,
    separate_warmup_tasks: 1,
    separate_diagnostic_tasks: 1,
  },
  clock: "performance.now, milliseconds",
  measured_window:
    "First SendMessage through final validated GetTask and aggregate count checks. Includes fault injection, full store restart, private correlation reads, assertions, and exact-ID retry. Excludes fixture setup, AgentCard discovery, host snapshots, and cleanup.",
  operator:
    "Immediate synthetic explicit operator and fixed canonical worker. No LLM or human think time.",
  backend: "sqlite",
};
write("claim.json", claim);
const { TaskState } = await import("@a2a-js/sdk");
const { DatabaseSync } = await import("node:sqlite");
const { createA2aRelayFixture, a2aRequest, worker, RESPONSE } =
  await import("../test/a2a-relay-fixtures.js");
const sourcePaths = git(
  "ls-files",
  "src",
  "test",
  "drizzle",
  "package.json",
  "package-lock.json",
).split("\n");
sourcePaths.push("scripts/measure-a2a-relay.mjs");
const host = () => ({
  at: new Date().toISOString(),
  load_average: os.loadavg(),
  free_memory_bytes: os.freemem(),
  total_memory_bytes: os.totalmem(),
});
const statistics = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return {
    count: sorted.length,
    median:
      sorted.length % 2
        ? sorted[middle]
        : (sorted[middle - 1] + sorted[middle]) / 2,
    minimum: sorted[0],
    maximum: sorted.at(-1),
  };
};
const stageSummary = (samples) =>
  Object.fromEntries(
    [
      ...new Set(samples.flatMap((sample) => Object.keys(sample.stages_ms))),
    ].map((stage) => [
      stage,
      statistics(
        samples
          .filter((sample) => stage in sample.stages_ms)
          .map((sample) => sample.stages_ms[stage]),
      ),
    ]),
  );
const sdkIds = (f) => {
  const db = new DatabaseSync(join(f.dir, "a2a.sqlite"), { readOnly: true });
  try {
    return db
      .prepare("SELECT id FROM hab_a2a_tasks ORDER BY id")
      .all()
      .map((row) => row.id);
  } finally {
    db.close();
  }
};
const lock = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8"));
const dependencies = Object.fromEntries(
  ["@a2a-js/sdk", "better-sqlite3", "kysely"].map((name) => {
    const path = join(root, "node_modules", name, "package.json");
    const installed = JSON.parse(readFileSync(path, "utf8"));
    const locked = lock.packages[`node_modules/${name}`].version;
    assert.equal(
      installed.version,
      locked,
      `${name} installed version matches lock`,
    );
    return [
      name,
      {
        installed: installed.version,
        locked,
        package_sha256: hash(readFileSync(path)),
      },
    ];
  }),
);
const report = {
  schema: "hab-a2a-bounded-performance-v1",
  status: "running",
  claim,
  git: {
    head: git("rev-parse", "HEAD"),
    tree: git("rev-parse", "HEAD^{tree}"),
    dirty: Boolean(git("status", "--porcelain=v1")),
    status: git("status", "--porcelain=v1"),
  },
  source_sha256: Object.fromEntries(
    sourcePaths
      .sort()
      .map((path) => [path, hash(readFileSync(join(root, path)))]),
  ),
  runtime: {
    node: process.version,
    executable: process.execPath,
    versions: process.versions,
    exec_argv: process.execArgv,
    node_options: process.env.NODE_OPTIONS ?? "",
    dependencies,
  },
  host: {
    platform: os.platform(),
    release: os.release(),
    architecture: os.arch(),
    logical_cpus: os.cpus().length,
    cpu_models: [...new Set(os.cpus().map((cpu) => cpu.model))],
    initial: host(),
    process_snapshot: execFileSync("ps", ["-ww", "-axo", "pid,%cpu,comm"], {
      encoding: "utf8",
    })
      .trim()
      .split("\n")
      .slice(1)
      .map((line) => {
        const match = line.trim().match(/^(\d+)\s+([\d.]+)\s+(.+)$/);
        return match
          ? {
              pid: Number(match[1]),
              command: match[3].split("/").at(-1).trim(),
              cpu_percent: Number(match[2]),
            }
          : null;
      })
      .filter(Boolean)
      .sort((a, b) => b.cpu_percent - a.cpu_percent)
      .slice(0, 8),
    shared_host: true,
  },
  runs: [],
  unexpected_failures: 0,
  cleanup: [],
};

async function completeTask(f, id, recover) {
  const sample = {
    id,
    class: recover ? "lost_response_recovery" : "nominal",
    stages_ms: {},
    expected_faults: 0,
  };
  const start = performance.now();
  const stage = async (name, work) => {
    const begin = performance.now();
    try {
      return await work();
    } finally {
      sample.stages_ms[name] = performance.now() - begin;
    }
  };
  const before = f.count();
  let task;
  if (recover) {
    const previousSdkIds = sdkIds(f);
    f.state.failSubmitReply = true;
    await stage("send_expected_response_loss", async () => {
      await assert.rejects(() =>
        f.client.sendMessage(a2aRequest(id), f.options),
      );
      assert.equal(f.state.failSubmitReply, false);
      assert.equal(f.count(), before);
    });
    sample.expected_faults = 1;
    const accepted = f.relayRows().at(-1);
    assert.ok(accepted.body);
    const afterFaultSdkIds = sdkIds(f);
    assert.equal(afterFaultSdkIds.length, previousSdkIds.length + 1);
    task = await stage("restart_and_exact_id_recovery", async () => {
      await f.restart();
      f.faults.outboxRetryDue();
      const replay = await f.client.sendMessage(a2aRequest(id), f.options);
      assert.deepEqual(sdkIds(f), afterFaultSdkIds);
      assert.ok(afterFaultSdkIds.includes(replay.id));
      const receipt = await f.receipt(replay);
      assert.equal(receipt.receipt_id, accepted.receipt_id);
      assert.equal(receipt.message_id, accepted.message_id);
      assert.equal(Date.parse(receipt.expires_at), accepted.expires_at);
      assert.deepEqual(
        f.relayRows().find((row) => row.message_id === accepted.message_id),
        accepted,
      );
      assert.equal(
        replay.metadata.hab_relay.source.thread_id,
        JSON.parse(accepted.body).thread_id,
      );
      assert.equal(f.count(), before);
      return replay;
    });
    sample.recovery_invariants = {
      original_receipt: true,
      original_envelope_bytes: true,
      original_message_id: true,
      original_expiry: true,
      original_sdk_task: true,
      no_execution_before_acceptance: true,
      envelope_sha256: hash(accepted.body),
    };
  } else {
    task = await stage("send_admission", () =>
      f.client.sendMessage(a2aRequest(id), f.options),
    );
  }
  assert.equal(task.status.state, TaskState.TASK_STATE_SUBMITTED);
  assert.equal(f.count(), before);
  const source = f.sourceOf(task);
  await stage("recipient_durable_storage_ack", async () => {
    await f.recipient.receiveOnce();
    const entry = f
      .recipientEntries()
      .find(
        (entry) =>
          entry.sender_id === source.sender_id &&
          entry.message.message_id === source.message_id,
      );
    assert.equal(entry?.receipt_confirmed, true);
    assert.equal((await f.receipt(task)).state, "acked");
    assert.equal(f.count(), before);
    const stored = await f.client.getTask({ id: task.id }, f.options);
    assert.equal(stored.status.state, TaskState.TASK_STATE_SUBMITTED);
    assert.deepEqual(stored.artifacts, []);
  });
  await stage("explicit_accept_and_submit", async () => {
    f.recipient.accept(f.operator, source);
    await f.recipient.submitOnce(f.operator, source);
    assert.equal(f.count(), before + 1);
  });
  await stage("accepted_reply_delivery", async () => {
    f.recipient.replyOnce(f.operator, source, "execution_accepted");
    await f.sendReply();
    await f.receiveResult();
  });
  const engineId = f.journal.get(source).task.id;
  await stage("engine_claim_and_complete", async () => {
    const claimed = await f.hub.claim(worker);
    assert.equal(claimed.id, engineId);
    await f.hub.complete(worker, {
      id: claimed.id,
      fence: claimed.fence,
      state: "succeeded",
      result: RESPONSE,
    });
  });
  await stage("pre_result_privacy_check", async () => {
    const waiting = await f.client.getTask({ id: task.id }, f.options);
    assert.notEqual(waiting.status.state, TaskState.TASK_STATE_COMPLETED);
    assert.deepEqual(waiting.artifacts, []);
    assert.equal(JSON.stringify(waiting).includes(RESPONSE), false);
  });
  await stage("result_observation_delivery_get", async () => {
    await f.recipient.observeOnce(f.operator, source);
    f.recipient.replyOnce(f.operator, source, "execution_result");
    await f.sendReply();
    await f.receiveResult();
    const complete = await f.client.getTask({ id: task.id }, f.options);
    assert.equal(complete.status.state, TaskState.TASK_STATE_COMPLETED);
    assert.equal(complete.artifacts.length, 1);
    assert.equal(complete.artifacts[0].parts.length, 1);
    assert.equal(complete.artifacts[0].parts[0].content.value, RESPONSE);
  });
  sample.total_ms = performance.now() - start;
  sample.a2a_task_id = task.id;
  sample.engine_task_id = engineId;
  sample.source = source;
  sample.artifacts = 1;
  return sample;
}

async function fixtureRun(label, work) {
  const hooks = [];
  let f;
  try {
    f = await createA2aRelayFixture({ after: (hook) => hooks.push(hook) });
    return await work(f);
  } finally {
    const failures = [];
    for (const hook of hooks.reverse()) {
      try {
        await hook();
      } catch (error) {
        failures.push(error);
      }
    }
    let closed = 0;
    if (f)
      for (const url of [f.base, f.relayUrl]) {
        try {
          await assert.rejects(
            () => globalThis.fetch(url, { signal: AbortSignal.timeout(1000) }),
            (error) => error.cause?.code === "ECONNREFUSED",
          );
          closed++;
        } catch (error) {
          failures.push(error);
        }
      }
    report.cleanup.push({
      fixture: label,
      registered_hooks: hooks.length,
      owned_http_ports_closed: closed,
      global_process_inventory: "not_measured",
      failures: failures.length,
    });
    if (failures.length)
      throw new AggregateError(failures, `Cleanup failed for ${label}`);
  }
}

function sqlProbe() {
  const db = new DatabaseSync(":memory:");
  const statementPrototype = Object.getPrototypeOf(db.prepare("SELECT 1"));
  db.close();
  const labels = new WeakMap();
  const rows = new Map();
  const prepare = DatabaseSync.prototype.prepare;
  DatabaseSync.prototype.prepare = function (sql, ...args) {
    const statement = Reflect.apply(prepare, this, [sql, ...args]);
    labels.set(
      statement,
      `${sql.trim().split(/\s/)[0].toUpperCase()}:${hash(sql).slice(0, 16)}`,
    );
    return statement;
  };
  const original = new Map();
  for (const method of ["all", "get", "run"]) {
    original.set(method, statementPrototype[method]);
    statementPrototype[method] = function (...args) {
      const begin = performance.now();
      try {
        return Reflect.apply(original.get(method), this, args);
      } finally {
        const key = `${method}:${labels.get(this) ?? "statement_prepared_before_probe"}`;
        const row = rows.get(key) ?? {
          method,
          sql_category: labels.get(this) ?? "statement_prepared_before_probe",
          calls: 0,
          wall_ms: 0,
        };
        row.calls++;
        row.wall_ms += performance.now() - begin;
        rows.set(key, row);
      }
    };
  }
  return {
    rows,
    restore() {
      DatabaseSync.prototype.prepare = prepare;
      for (const [method, value] of original)
        statementPrototype[method] = value;
      assert.equal(DatabaseSync.prototype.prepare, prepare);
      for (const [method, value] of original)
        assert.equal(statementPrototype[method], value);
    },
  };
}

let failure;
try {
  await fixtureRun("warmup", async (f) => {
    report.warmup = {
      excluded_from_samples: true,
      completed: (await completeTask(f, "warmup", false)).artifacts,
    };
  });
  for (let run = 1; run <= 5; run++) {
    await fixtureRun(`measured-${run}`, async (f) => {
      const row = { run, before: host(), samples: [] };
      report.runs.push(row);
      const start = performance.now(),
        cpu = process.cpuUsage();
      for (let task = 1; task <= 5; task++)
        row.samples.push(
          await completeTask(f, `run_${run}_task_${task}`, task === 1),
        );
      row.counts = {
        completed: row.samples.length,
        expected_faults: row.samples.reduce(
          (n, sample) => n + sample.expected_faults,
          0,
        ),
        engine_tasks: f.count(),
        sdk_tasks: sdkIds(f).length,
        relay_messages: f.relayRows().length,
        recipient_inbox: f.recipientEntries().length,
        origin_inbox: f.originEntries().length,
        artifacts: row.samples.reduce((n, sample) => n + sample.artifacts, 0),
        unresolved_intents: f.unresolvedIntents(),
      };
      assert.deepEqual(row.counts, {
        completed: 5,
        expected_faults: 1,
        engine_tasks: 5,
        sdk_tasks: 5,
        relay_messages: 15,
        recipient_inbox: 5,
        origin_inbox: 10,
        artifacts: 5,
        unresolved_intents: 0,
      });
      assert.equal(
        new Set(row.samples.map((sample) => sample.engine_task_id)).size,
        5,
      );
      assert.equal(
        new Set(row.samples.map((sample) => sample.source.message_id)).size,
        5,
      );
      row.wall_ms = performance.now() - start;
      row.cpu_usage_us = process.cpuUsage(cpu);
      row.cpu_wall_ratio =
        (row.cpu_usage_us.user + row.cpu_usage_us.system) / 1000 / row.wall_ms;
      row.achieved_harness_tasks_per_second = 5000 / row.wall_ms;
      row.after = host();
      const nominal = row.samples.filter(
        (sample) => sample.class === "nominal",
      );
      row.nominal_total_ms = statistics(
        nominal.map((sample) => sample.total_ms),
      );
      row.nominal_stages_ms = stageSummary(nominal);
      row.recovery_total_ms = row.samples[0].total_ms;
      write(`run-${run}.json`, row);
    });
  }
  await fixtureRun("diagnostic", async (f) => {
    const probe = sqlProbe();
    const start = performance.now(),
      cpu = process.cpuUsage();
    try {
      const sample = await completeTask(f, "diagnostic", false);
      const wall = performance.now() - start;
      const usage = process.cpuUsage(cpu);
      const rows = [...probe.rows.values()].sort(
        (a, b) => b.wall_ms - a.wall_ms,
      );
      const sqlWall = rows.reduce((total, row) => total + row.wall_ms, 0);
      assert.ok(rows.reduce((total, row) => total + row.calls, 0) > 0);
      report.diagnostic = {
        excluded_from_samples: true,
        task: sample,
        wall_ms: wall,
        cpu_usage_us: usage,
        node_sqlite_statement_wall_ms: sqlWall,
        observed_statement_wall_share: sqlWall / wall,
        statements: rows,
        coverage:
          "node:sqlite StatementSync all/get/run invocation time, including harness validation reads. Excludes DatabaseSync exec/prepare time, iterators, better-sqlite3/Kysely SDK operations, fsync counters, and other processes.",
        conclusion:
          "Observed synchronous SQL wall share only. No hardware or capacity limiter is established.",
        prototype_restored: false,
      };
    } finally {
      probe.restore();
      if (report.diagnostic) report.diagnostic.prototype_restored = true;
    }
  });
  const samples = report.runs.flatMap((run) => run.samples);
  assert.equal(samples.length, 25);
  assert.equal(new Set(samples.map((sample) => sample.a2a_task_id)).size, 25);
  assert.equal(
    new Set(samples.map((sample) => sample.engine_task_id)).size,
    25,
  );
  assert.equal(
    new Set(samples.map((sample) => sample.source.message_id)).size,
    25,
  );
  report.summary = {
    completed: samples.length,
    nominal_tasks: samples.filter((sample) => sample.class === "nominal")
      .length,
    recovery_tasks: samples.filter(
      (sample) => sample.class === "lost_response_recovery",
    ).length,
    expected_faults: samples.reduce(
      (n, sample) => n + sample.expected_faults,
      0,
    ),
    unexpected_failures: 0,
    run_wall_ms: statistics(report.runs.map((run) => run.wall_ms)),
    achieved_harness_tasks_per_second: statistics(
      report.runs.map((run) => run.achieved_harness_tasks_per_second),
    ),
    nominal_run_median_task_ms: statistics(
      report.runs.map((run) => run.nominal_total_ms.median),
    ),
    recovery_task_ms: statistics(
      report.runs.map((run) => run.recovery_total_ms),
    ),
    interpretation: claim.interpretation,
  };
  assert.equal(report.summary.expected_faults, 5);
  report.status = "passed";
} catch (error) {
  failure = error;
  report.status = "failed";
  report.unexpected_failures++;
  report.error = {
    name: error.name,
    message: error.message,
    stack: error.stack,
  };
} finally {
  report.host.final = host();
  write("report.json", report);
}
if (failure) throw failure;
process.stdout.write(
  JSON.stringify({
    status: report.status,
    report: join(output, "report.json"),
    summary: report.summary,
  }) + "\n",
);
