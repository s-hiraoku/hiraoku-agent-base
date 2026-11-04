import {
  textBinding,
  textInputSchema,
  storedTextSchema,
  sameTextBinding,
  textDigest,
  verifyTextRuntime,
  type TextInput,
} from "./text-task.ts";
import {
  taskTypes,
  allTaskTypes,
  canonicalResult,
  taskFailure,
} from "./task-contract.ts";
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
  private async loadText(p: Principal, task: Task) {
    if (task.task_type !== "generic_text") return undefined;
    const rows = await this.authorization.batch(p, [
      stmt(
        "SELECT payload,worker_client FROM task_text_requests WHERE task_id=?",
        task.id,
      ),
    ]);
    if (!rows[0][0]) throw Error("text_record_missing");
    task.text_request = storedTextSchema.parse(
      JSON.parse(String(rows[0][0].payload)),
    );
    return rows[0][0].worker_client;
  }
  private async bind(p: Principal) {
    if (p.textBinding || p.taskTypes?.includes("generic_text")) {
      if (p.authorizationEpoch !== undefined) {
        await this.authorization.batch(p, []);
        return p;
      }
    }
    return this.authorization.bind(p);
  }
  private textFilter(p: Principal) {
    try {
      const b = textBinding(p);
      if (p.destination !== b.recipientAgent)
        return { sql: "0", params: [] as string[] };
      return {
        sql: "EXISTS(SELECT 1 FROM task_text_requests t WHERE t.task_id=tasks.id AND t.owner_client=? AND t.owner_scope=? AND t.sender_agent=? AND t.recipient_agent=? AND t.recipient_owner=? AND t.conversation_binding=?)",
        params: [
          p.clientId!,
          b.ownerScope,
          b.senderAgent,
          b.recipientAgent,
          b.recipientOwner,
          b.conversationBinding,
        ],
      };
    } catch {
      return { sql: "0", params: [] as string[] };
    }
  }
  private async guardText(p: Principal, task: Task, ownerOnly = false) {
    if (task.task_type !== "generic_text") return;
    const workerClient = await this.loadText(p, task);
    const request = task.text_request;
    let b;
    try {
      b = textBinding(p);
    } catch {
      throw Error("operation_rejected");
    }
    if (!request || !sameTextBinding(b, request.binding))
      throw Error("operation_rejected");
    if (
      request.owner !== task.owner ||
      task.destination !== b.recipientAgent ||
      request.fingerprint !==
        (await textDigest({
          owner: request.owner,
          ownerClient: request.ownerClient,
          binding: request.binding,
          input: request.input,
        }))
    )
      throw Error("text_record_corrupt");
    const owner =
      task.owner === p.subject &&
      request.ownerClient === p.clientId &&
      p.destination === b.recipientAgent;
    if (owner) return;
    if (
      ownerOnly ||
      p.worker !== b.recipientAgent ||
      task.destination !== p.worker ||
      task.runner_subject !== p.subject ||
      task.runner_scope !== (p.runnerScope ?? null)
    )
      throw Error("operation_rejected");
    if (workerClient !== p.clientId) throw Error("operation_rejected");
  }
  async submitText(p: Principal, input: TextInput) {
    this.principal(p, "submit");
    p = await this.bind(p);
    const binding = textBinding(p);
    const parsed = textInputSchema.parse(input);
    if (p.destination !== binding.recipientAgent || p.resultReaders?.length)
      throw Error("text_binding_required");
    const fingerprint = await textDigest({
      owner: p.subject,
      ownerClient: p.clientId,
      binding,
      input: parsed,
    });
    const requestKey =
      "text_" +
      (await textDigest([
        p.subject,
        p.clientId,
        binding.ownerScope,
        binding.senderAgent,
        parsed.messageId,
      ]));
    const payload = JSON.stringify({
      version: 1,
      acceptedAt: 0,
      owner: p.subject,
      ownerClient: p.clientId,
      binding,
      input: parsed,
      fingerprint,
    });
    const clock = this.driver.nowSQL;
    const mutation = crypto.randomUUID();
    const rows = await this.authorization.batch(p, [
      stmt(
        `INSERT OR IGNORE INTO tasks(id,owner,destination,request_key,task_type,state,actor,at,mutation) SELECT ?,?,?,?,'generic_text','queued',?,${clock},? WHERE ? > ${clock} AND (SELECT count(*) FROM tasks)<10000 AND (SELECT count(*) FROM tasks WHERE state IN ('queued','running','waiting_approval'))<128`,
        crypto.randomUUID(),
        p.subject,
        binding.recipientAgent,
        requestKey,
        p.subject,
        mutation,
        parsed.workDeadline,
      ),
      stmt(
        `INSERT INTO task_text_requests(task_id,owner_client,owner_scope,sender_agent,recipient_agent,recipient_owner,conversation_binding,accepted_at,work_deadline,fingerprint,payload) SELECT id,?,?,?,?,?,?,${clock},?,?,json_set(?,'$.acceptedAt',${clock}) FROM tasks WHERE owner=? AND request_key=? AND mutation=?`,
        p.clientId!,
        binding.ownerScope,
        binding.senderAgent,
        binding.recipientAgent,
        binding.recipientOwner,
        binding.conversationBinding,
        parsed.workDeadline,
        fingerprint,
        payload,
        p.subject,
        requestKey,
        mutation,
      ),
      stmt(
        "SELECT * FROM tasks WHERE owner=? AND request_key=?",
        p.subject,
        requestKey,
      ),
    ]);
    const task = this.row(rows[2]);
    await this.loadText(p, task);
    if (
      task.task_type !== "generic_text" ||
      task.text_request?.fingerprint !== fingerprint
    )
      throw Error("text_idempotency_conflict");
    await this.guardText(p, task, true);
    return task;
  }
  async get(p: Principal, a: { id: string }) {
    this.principal(p, "get");
    p = await this.bind(p);
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
    const task = this.row(r[0]);
    await this.guardText(p, task);
    return task;
  }
  async submit(p: Principal, a: { task_type: string; request_key: string }) {
    this.principal(p, "submit");
    p = await this.bind(p);
    if (
      a.task_type === "generic_text" ||
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
  async claim(
    p: Principal,
    a: Record<string, never> = {},
    capabilities?: { textRetentionMs: number },
  ) {
    this.principal(p, "claim");
    p = await this.bind(p);
    const allowed = p.taskTypes ?? ["connectivity_check"];
    if (
      !allowed.length ||
      allowed.some((t) => !allTaskTypes.includes(t)) ||
      Object.keys(a).length
    )
      throw Error("forbidden");
    let scope = { sql: "0", params: [] as string[] };
    if (allowed.includes("generic_text")) {
      if (
        !capabilities ||
        Object.keys(capabilities).some((key) => key !== "textRetentionMs") ||
        !Number.isSafeInteger(capabilities.textRetentionMs) ||
        capabilities.textRetentionMs <= 0
      )
        throw Error("text_claim_capability_required");
      const b = textBinding(p);
      if (
        p.worker !== b.recipientAgent ||
        typeof p.runnerScope !== "string" ||
        !p.runnerScope.length ||
        p.runnerScope.length > 200
      )
        throw Error("text_binding_required");
      scope = {
        sql: "EXISTS(SELECT 1 FROM task_text_requests t WHERE t.task_id=tasks.id AND t.owner_scope=? AND t.sender_agent=? AND t.recipient_agent=? AND t.recipient_owner=? AND t.conversation_binding=?)",
        params: [
          b.ownerScope,
          b.senderAgent,
          b.recipientAgent,
          b.recipientOwner,
          b.conversationBinding,
        ],
      };
    }
    if (p.worker !== "hermes" && allowed.some((t) => t !== "generic_text"))
      throw Error("forbidden");
    const clock = this.driver.nowSQL;
    const deadlineScope = allowed.includes("generic_text")
      ? `(${scope.sql}) AND EXISTS(SELECT 1 FROM task_text_requests t WHERE t.task_id=tasks.id AND t.work_deadline>${clock} AND t.work_deadline<=t.accepted_at+? AND t.accepted_at+?>${clock} AND t.accepted_at<=?)`
      : "0";
    const deadlineParams = allowed.includes("generic_text")
      ? [
          ...scope.params,
          capabilities!.textRetentionMs,
          capabilities!.textRetentionMs,
          Number.MAX_SAFE_INTEGER - capabilities!.textRetentionMs,
        ]
      : [];
    const mutation = crypto.randomUUID();
    const rows = await this.authorization.batch(p, [
      stmt(
        `UPDATE tasks SET state='waiting_approval',fence=fence+1,lease=NULL,actor=?,at=${clock},mutation=? WHERE destination=? AND state='running' AND lease<=${clock} AND (task_type<>'generic_text' OR (${scope.sql}))`,
        p.subject,
        crypto.randomUUID(),
        p.worker!,
        ...scope.params,
      ),
      stmt(
        `UPDATE tasks SET state='running',execution_open=1,fence=fence+1,lease=${clock}+?,runner_scope=?,runner_subject=?,actor=?,at=${clock},mutation=? WHERE id=(SELECT id FROM tasks WHERE destination=? AND task_type IN (${allowed.map(() => "?").join(",")}) AND state='queued' AND (task_type<>'generic_text' OR (${deadlineScope})) ORDER BY at,rowid LIMIT 1) AND NOT EXISTS(SELECT 1 FROM tasks WHERE destination=? AND execution_open=1)`,
        this.leaseMs,
        p.runnerScope ?? null,
        p.subject,
        p.subject,
        mutation,
        p.worker!,
        ...allowed,
        ...deadlineParams,
        p.worker!,
      ),
      ...(allowed.includes("generic_text")
        ? [
            stmt(
              "UPDATE task_text_requests SET worker_client=? WHERE task_id=(SELECT id FROM tasks WHERE mutation=?) AND worker_client IS NULL",
              p.clientId ?? null,
              mutation,
            ),
          ]
        : []),
      stmt("SELECT * FROM tasks WHERE mutation=?", mutation),
    ]);
    const claimed = rows[rows.length - 1];
    if (!claimed[0]) return null;
    const task = this.row(claimed);
    await this.guardText(p, task);
    return task;
  }
  async heartbeat(p: Principal, a: Lease & { run_id?: string }) {
    this.principal(p, "heartbeat");
    p = await this.bind(p);
    const before = this.row(
      (
        await this.authorization.batch(p, [
          stmt("SELECT * FROM tasks WHERE id=?", a.id),
        ])
      )[0],
    );
    await this.guardText(p, before);
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
    const updated = this.row(r[1]);
    await this.guardText(p, updated);
    return updated;
  }
  async complete(
    p: Principal,
    a: Lease & { state: "succeeded" | "failed"; result: string },
  ) {
    this.principal(p, "complete");
    p = await this.bind(p);
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
    await this.guardText(p, task);
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
    const updated = this.row(r[1]);
    await this.guardText(p, updated);
    return updated;
  }
  async cancel(p: Principal, a: { id: string }) {
    this.principal(p, "cancel");
    p = await this.bind(p);
    const before = this.row(
      (
        await this.authorization.batch(p, [
          stmt("SELECT * FROM tasks WHERE id=?", a.id),
        ])
      )[0],
    );
    await this.guardText(p, before, true);
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
    const updated = this.row(r[1]);
    await this.guardText(p, updated);
    return updated;
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
        "SELECT id FROM tasks WHERE task_type<>'generic_text' AND id=? AND (owner=? OR EXISTS(SELECT 1 FROM task_access g WHERE g.task=tasks.id AND g.subject=? AND g.notify=1))",
        task,
        subject,
        subject,
      ),
    ]);
    return Boolean(r[0][0]);
  }
  async revokeReader(p: Principal, a: { id: string; subject: string }) {
    this.principal(p, "grants");
    p = await this.bind(p);
    const clock = this.driver.nowSQL;
    await this.authorization.batch(p, [
      stmt(
        `INSERT INTO access_audit(task,subject,actor,action,at) SELECT task,subject,?,'revoked',${clock} FROM task_access WHERE task=? AND subject=? AND EXISTS(SELECT 1 FROM tasks WHERE id=task AND task_type<>'generic_text')`,
        p.subject,
        a.id,
        a.subject,
      ),
      stmt(
        "DELETE FROM task_access WHERE task=? AND subject=? AND EXISTS(SELECT 1 FROM tasks WHERE id=task AND task_type<>'generic_text')",
        a.id,
        a.subject,
      ),
      stmt(
        `UPDATE subscriptions SET active=0,revision=revision+1,at=${clock} WHERE task=? AND subject=? AND EXISTS(SELECT 1 FROM tasks WHERE id=task AND task_type<>'generic_text')`,
        a.id,
        a.subject,
      ),
    ]);
  }
  async reconciliationTask(p: Principal, id: string) {
    this.principal(p, "reconcile");
    p = await this.bind(p);
    const task = this.row(
      (
        await this.authorization.batch(p, [
          stmt("SELECT * FROM tasks WHERE id=?", id),
        ])
      )[0],
    );
    if (
      task.task_type === "generic_text" &&
      (p.worker !== task.destination ||
        p.subject !== task.runner_subject ||
        p.runnerScope !== task.runner_scope)
    )
      throw Error("operation_rejected");
    await this.guardText(p, task);
    return task;
  }
  async reconcile(p: Principal, a: { id: string; fence: number }, runs: Runs) {
    this.principal(p, "reconcile");
    p = await this.bind(p);
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
    if (task.task_type === "generic_text")
      verifyTextRuntime(runs, task.runner_scope);
    const run = await runs.get(task.run_id);
    if (task.task_type === "generic_text")
      verifyTextRuntime(runs, task.runner_scope);
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
    return this.commitReconciliation(
      p,
      {
        ...a,
        run_id: task.run_id,
        runner_scope: task.runner_scope,
        result: canonicalResult(
          task.task_type ?? "connectivity_check",
          run.text,
        )!,
      },
      task.task_type === "generic_text" ? runs : undefined,
    );
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
    runs?: Runs,
  ) {
    this.principal(p, "reconcile");
    p = await this.bind(p);
    if (runs) verifyTextRuntime(runs, a.runner_scope);
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
    const updated = this.row(r[1]);
    await this.guardText(p, updated);
    return updated;
  }
  async pending(p: Principal) {
    this.principal(p, "events");
    p = await this.bind(p);
    const scope = this.textFilter(p);
    const r = await this.authorization.batch(p, [
      stmt(
        `SELECT outbox.* FROM outbox JOIN tasks ON tasks.id=outbox.task WHERE outbox.owner=? AND delivered=0 AND (tasks.task_type<>'generic_text' OR (${scope.sql})) ORDER BY outbox.at,outbox.id`,
        p.subject,
        ...scope.params,
      ),
    ]);
    return r[0] as unknown as Outbox[];
  }
  async ack(p: Principal, id: string) {
    this.principal(p, "events");
    p = await this.bind(p);
    const scope = this.textFilter(p);
    await this.authorization.batch(p, [
      stmt(
        `UPDATE outbox SET delivered=1 WHERE id=? AND owner=? AND EXISTS(SELECT 1 FROM tasks WHERE tasks.id=outbox.task AND (tasks.task_type<>'generic_text' OR (${scope.sql})))`,
        id,
        p.subject,
        ...scope.params,
      ),
    ]);
  }
}
