import { taskTypes, canonicalResult, taskFailure } from "./task-contract.ts";
import { DurableAuthorization } from "./authorization.ts";
import {
  type Runs,
  type Driver,
  type Principal,
  type Task,
  type Lease,
  type Statement,
  type Outbox,
  type Row,
  type Operation,
} from "./types.ts";
const stmt = (
  sql: string,
  ...params: (string | number | null)[]
): Statement => ({ sql, params });
export class TaskService {
  readonly driver: Driver;
  readonly authorization: DurableAuthorization;
  now: () => number;
  readonly leaseMs: number;
  constructor(
    driver: Driver,
    now: () => number = () => Date.now(),
    leaseMs = 30000,
  ) {
    this.driver = driver;
    this.authorization = new DurableAuthorization(driver);
    this.now = now;
    this.leaseMs = leaseMs;
  }
  principal(p: Principal, op: Operation) {
    if (!p?.subject || !p.operations?.includes(op))
      throw new Error("forbidden");
  }
  row(rows: Row[]): Task {
    if (!rows[0]) throw new Error("operation_rejected");
    return rows[0] as unknown as Task;
  }
  async get(p: Principal, a: { id: string }) {
    this.principal(p, "get");
    p = await this.authorization.bind(p);
    const r = await this.authorization.batch(p, [
      stmt(
        "SELECT * FROM tasks WHERE id=? AND (owner=? OR (destination=? AND runner_subject=? AND runner_scope IS ?) OR EXISTS(SELECT 1 FROM task_access g WHERE g.task=tasks.id AND g.subject=?))",
        a.id,
        p.subject,
        p.worker ?? "",
        p.subject,
        p.runnerScope ?? null,
        p.subject,
      ),
    ]);
    return this.row(r[0]);
  }
  async submit(p: Principal, a: { task_type: string; request_key: string }) {
    this.principal(p, "submit");
    p = await this.authorization.bind(p);
    if (
      !taskTypes.some((type) => type === a.task_type) ||
      !(p.taskTypes ?? ["connectivity_check"]).some(
        (type) => type === a.task_type,
      ) ||
      !/^[a-zA-Z0-9_-]{1,80}$/.test(a.request_key) ||
      p.destination !== "hermes" ||
      Object.keys(a).some((k) => !["task_type", "request_key"].includes(k))
    )
      throw new Error("invalid_request");
    const clock = this.driver.nowSQL;
    const mutation = crypto.randomUUID();
    const readers = p.resultReaders ?? [];
    if (
      readers.length > 8 ||
      readers.some(
        (r) =>
          !r.subject || r.subject.length > 200 || typeof r.notify !== "boolean",
      )
    )
      throw new Error("invalid_grant_policy");
    const r = await this.authorization.batch(p, [
      stmt(
        `INSERT OR IGNORE INTO tasks(id,owner,destination,request_key,task_type,state,actor,at,mutation) SELECT ?,?,?,?,?,'queued',?,${clock},? WHERE (SELECT count(*) FROM tasks)<10000 AND (SELECT count(*) FROM tasks WHERE state IN ('queued','running','waiting_approval'))<128`,
        crypto.randomUUID(),
        p.subject,
        p.destination,
        a.request_key,
        a.task_type,
        p.subject,
        mutation,
      ),
      ...readers.map((reader) =>
        stmt(
          `INSERT OR IGNORE INTO task_access(id,task,subject,notify,actor,at) SELECT ?,id,?,?,?,${clock} FROM tasks WHERE owner=? AND request_key=? AND mutation=?`,
          crypto.randomUUID(),
          reader.subject,
          Number(reader.notify),
          p.subject,
          p.subject,
          a.request_key,
          mutation,
        ),
      ),
      stmt(
        "SELECT * FROM tasks WHERE owner=? AND request_key=?",
        p.subject,
        a.request_key,
      ),
    ]);
    const task = this.row(r[r.length - 1]);
    if (task.task_type !== a.task_type)
      throw Error("idempotency_task_type_conflict");
    return task;
  }
  async claim(p: Principal, a: Record<string, never> = {}) {
    this.principal(p, "claim");
    p = await this.authorization.bind(p);
    if (p.worker !== "hermes" || Object.keys(a).length)
      throw new Error("forbidden");
    const clock = this.driver.nowSQL;
    const mutation = crypto.randomUUID();
    const r = await this.authorization.batch(p, [
      stmt(
        `UPDATE tasks SET state='waiting_approval',fence=fence+1,lease=NULL,actor=?,at=${clock},mutation=? WHERE destination=? AND state='running' AND lease<=${clock}`,
        p.subject,
        crypto.randomUUID(),
        p.worker,
      ),
      stmt(
        `UPDATE tasks SET state='running',execution_open=1,fence=fence+1,lease=${clock}+?,runner_scope=?,runner_subject=?,actor=?,at=${clock},mutation=? WHERE id=(SELECT id FROM tasks WHERE destination=? AND task_type IN (?,?) AND state='queued' ORDER BY at,rowid LIMIT 1) AND NOT EXISTS(SELECT 1 FROM tasks WHERE destination=? AND execution_open=1)`,
        this.leaseMs,
        p.runnerScope ?? null,
        p.subject,
        p.subject,
        mutation,
        p.worker,
        (p.taskTypes ?? ["connectivity_check"])[0],
        (p.taskTypes ?? ["connectivity_check"])[1] ??
          (p.taskTypes ?? ["connectivity_check"])[0],
        p.worker,
      ),
      stmt("SELECT * FROM tasks WHERE mutation=?", mutation),
    ]);
    return r[2][0] ? this.row(r[2]) : null;
  }
  async heartbeat(p: Principal, a: Lease & { run_id?: string }) {
    this.principal(p, "heartbeat");
    p = await this.authorization.bind(p);
    const clock = this.driver.nowSQL;
    const mutation = crypto.randomUUID();
    const r = await this.authorization.batch(p, [
      stmt(
        `UPDATE tasks SET lease=${clock}+?,run_id=COALESCE(run_id,?),actor=?,at=${clock},mutation=? WHERE id=? AND destination=? AND runner_subject=? AND runner_scope IS ? AND fence=? AND state='running' AND lease>${clock} AND (? IS NULL OR run_id IS NULL OR run_id=?)`,
        this.leaseMs,
        a.run_id ?? null,
        p.subject,
        mutation,
        a.id,
        p.worker ?? "",
        p.subject,
        p.runnerScope ?? null,
        a.fence,
        a.run_id ?? null,
        a.run_id ?? null,
      ),
      stmt("SELECT * FROM tasks WHERE mutation=?", mutation),
    ]);
    return this.row(r[1]);
  }
  async complete(
    p: Principal,
    a: Lease & { state: "succeeded" | "failed"; result: string },
  ) {
    this.principal(p, "complete");
    p = await this.authorization.bind(p);
    const task = this.row(
      (
        await this.authorization.batch(p, [
          stmt(
            "SELECT * FROM tasks WHERE id=? AND destination=? AND runner_subject=? AND runner_scope IS ?",
            a.id,
            p.worker ?? "",
            p.subject,
            p.runnerScope ?? null,
          ),
        ])
      )[0],
    );
    const type = task.task_type ?? "connectivity_check";
    const result =
      a.state === "succeeded"
        ? canonicalResult(type, a.result)
        : a.result === taskFailure(type)
          ? a.result
          : undefined;
    if (!["succeeded", "failed"].includes(a.state) || result === undefined)
      throw Error("invalid_result");
    a = { ...a, result };
    const clock = this.driver.nowSQL;
    const r = await this.authorization.batch(p, [
      stmt(
        `UPDATE tasks SET state=?,result=?,lease=NULL,execution_open=0,actor=?,at=${clock},mutation=? WHERE id=? AND destination=? AND runner_subject=? AND runner_scope IS ? AND fence=? AND state='running' AND lease>${clock}`,
        a.state,
        a.result,
        p.subject,
        crypto.randomUUID(),
        a.id,
        p.worker ?? "",
        p.subject,
        p.runnerScope ?? null,
        a.fence,
      ),
      stmt(
        "SELECT * FROM tasks WHERE id=? AND destination=? AND runner_subject=? AND runner_scope IS ? AND fence=? AND state=? AND result=?",
        a.id,
        p.worker ?? "",
        p.subject,
        p.runnerScope ?? null,
        a.fence,
        a.state,
        a.result,
      ),
    ]);
    return this.row(r[1]);
  }
  async cancel(p: Principal, a: { id: string }) {
    this.principal(p, "cancel");
    p = await this.authorization.bind(p);
    const clock = this.driver.nowSQL;
    const r = await this.authorization.batch(p, [
      stmt(
        `UPDATE tasks SET state='cancelled',fence=fence+1,lease=NULL,actor=?,at=${clock},mutation=? WHERE id=? AND owner=? AND state NOT IN ('succeeded','failed','cancelled')`,
        p.subject,
        crypto.randomUUID(),
        a.id,
        p.subject,
      ),
      stmt("SELECT * FROM tasks WHERE id=? AND owner=?", a.id, p.subject),
    ]);
    return this.row(r[1]);
  }
  async view(p: Principal, a: { id: string }) {
    const task = await this.get(p, a);
    return task.owner === p.subject ||
      (task.destination === p.worker &&
        task.runner_subject === p.subject &&
        task.runner_scope === (p.runnerScope ?? null))
      ? task
      : { id: task.id, state: task.state, result: task.result, at: task.at };
  }
  async canNotify(subject: string, task: string): Promise<boolean> {
    const r = await this.driver.batch([
      stmt(
        "SELECT id FROM tasks WHERE id=? AND (owner=? OR EXISTS(SELECT 1 FROM task_access g WHERE g.task=tasks.id AND g.subject=? AND g.notify=1))",
        task,
        subject,
        subject,
      ),
    ]);
    return Boolean(r[0][0]);
  }
  async revokeReader(p: Principal, a: { id: string; subject: string }) {
    this.principal(p, "grants");
    p = await this.authorization.bind(p);
    const clock = this.driver.nowSQL;
    await this.authorization.batch(p, [
      stmt(
        `INSERT INTO access_audit(task,subject,actor,action,at) SELECT task,subject,?,'revoked',${clock} FROM task_access WHERE task=? AND subject=?`,
        p.subject,
        a.id,
        a.subject,
      ),
      stmt(
        "DELETE FROM task_access WHERE task=? AND subject=?",
        a.id,
        a.subject,
      ),
      stmt(
        `UPDATE subscriptions SET active=0,revision=revision+1,at=${clock} WHERE task=? AND subject=?`,
        a.id,
        a.subject,
      ),
    ]);
  }
  async reconciliationTask(p: Principal, id: string) {
    this.principal(p, "reconcile");
    p = await this.authorization.bind(p);
    return this.row(
      (
        await this.authorization.batch(p, [
          stmt("SELECT * FROM tasks WHERE id=?", id),
        ])
      )[0],
    );
  }
  async reconcile(p: Principal, a: { id: string; fence: number }, runs: Runs) {
    this.principal(p, "reconcile");
    p = await this.authorization.bind(p);
    const task = await this.reconciliationTask(p, a.id);
    if (
      !task.run_id ||
      !task.runner_scope ||
      task.runner_scope !== runs.boundaryId ||
      !runs.toolIsolationVerified ||
      !runs.durableIdempotency ||
      task.fence !== a.fence ||
      task.execution_open !== 1
    )
      throw Error("reconciliation_evidence_missing");
    const run = await runs.get(task.run_id);
    if (
      run.id !== task.run_id ||
      run.state !== "succeeded" ||
      !run.text ||
      canonicalResult(task.task_type ?? "connectivity_check", run.text) ===
        undefined ||
      !runs.toolIsolationVerified ||
      !runs.durableIdempotency
    )
      throw Error("reconciliation_terminal_unconfirmed");
    return this.commitReconciliation(p, {
      ...a,
      run_id: task.run_id,
      runner_scope: task.runner_scope,
      result: canonicalResult(
        task.task_type ?? "connectivity_check",
        run.text,
      )!,
    });
  }
  private async commitReconciliation(
    p: Principal,
    a: {
      id: string;
      fence: number;
      run_id: string;
      runner_scope: string;
      result: string;
    },
  ) {
    this.principal(p, "reconcile");
    p = await this.authorization.bind(p);
    const clock = this.driver.nowSQL;
    const mutation = crypto.randomUUID();
    const r = await this.authorization.batch(p, [
      stmt(
        `UPDATE tasks SET state=CASE WHEN state='cancelled' THEN state ELSE 'succeeded' END,result=CASE WHEN state='cancelled' THEN result ELSE ? END,execution_open=0,lease=NULL,fence=fence+1,actor=?,at=${clock},mutation=? WHERE id=? AND execution_open=1 AND fence=? AND run_id=? AND runner_scope=? AND (state IN ('waiting_approval','cancelled') OR (state='running' AND lease<=${clock}))`,
        a.result,
        p.subject,
        mutation,
        a.id,
        a.fence,
        a.run_id,
        a.runner_scope,
      ),
      stmt("SELECT * FROM tasks WHERE id=? AND mutation=?", a.id, mutation),
    ]);
    return this.row(r[1]);
  }
  async pending(p: Principal) {
    this.principal(p, "events");
    p = await this.authorization.bind(p);
    const r = await this.authorization.batch(p, [
      stmt(
        "SELECT * FROM outbox WHERE owner=? AND delivered=0 ORDER BY at,id",
        p.subject,
      ),
    ]);
    return r[0] as unknown as Outbox[];
  }
  async ack(p: Principal, id: string) {
    this.principal(p, "events");
    p = await this.authorization.bind(p);
    await this.authorization.batch(p, [
      stmt(
        "UPDATE outbox SET delivered=1 WHERE id=? AND owner=?",
        id,
        p.subject,
      ),
    ]);
  }
}
