import {
  sqliteTable,
  text,
  integer,
  uniqueIndex,
  index,
  check,
  primaryKey,
} from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";
export const tasks = sqliteTable(
  "tasks",
  {
    id: text().primaryKey(),
    owner: text().notNull(),
    destination: text().notNull(),
    request_key: text().notNull(),
    task_type: text().notNull().default("connectivity_check"),
    state: text().notNull(),
    execution_open: integer().notNull().default(0),
    fence: integer().notNull().default(0),
    lease: integer(),
    run_id: text(),
    runner_scope: text(),
    runner_subject: text(),
    result: text(),
    actor: text().notNull(),
    at: integer().notNull(),
    mutation: text().notNull(),
  },
  (t) => [
    uniqueIndex("request_idempotency").on(t.owner, t.request_key),
    uniqueIndex("single_execution")
      .on(t.destination)
      .where(sql`${t.execution_open}=1`),
    index("queue_order").on(t.destination, t.state, t.at),
    check(
      "valid_state",
      sql`${t.state} IN ('queued','running','waiting_approval','succeeded','failed','cancelled')`,
    ),
    check(
      "fixed_task_type",
      sql`${t.task_type} IN ('connectivity_check','shift_log_inventory','generic_text')`,
    ),
    check("valid_gate", sql`${t.execution_open} IN (0,1)`),
  ],
);
export const audit = sqliteTable("audit", {
  seq: integer().primaryKey({ autoIncrement: true }),
  task: text().notNull(),
  actor: text().notNull(),
  state: text().notNull(),
  fence: integer().notNull(),
  at: integer().notNull(),
});
export const outbox = sqliteTable("outbox", {
  id: text().primaryKey(),
  task: text().notNull(),
  owner: text().notNull(),
  event: text().notNull(),
  at: integer().notNull(),
  delivered: integer().notNull().default(0),
});
export const taskAccess = sqliteTable(
  "task_access",
  {
    id: text().primaryKey(),
    task: text().notNull(),
    subject: text().notNull(),
    notify: integer().notNull(),
    actor: text().notNull(),
    at: integer().notNull(),
  },
  (t) => [
    uniqueIndex("task_reader").on(t.task, t.subject),
    check("notify_boolean", sql`${t.notify} IN (0,1)`),
  ],
);
export const accessAudit = sqliteTable("access_audit", {
  seq: integer().primaryKey({ autoIncrement: true }),
  task: text().notNull(),
  subject: text().notNull(),
  actor: text().notNull(),
  action: text().notNull(),
  at: integer().notNull(),
});
export const subscriptions = sqliteTable("subscriptions", {
  client_id: text(),
  id: text().primaryKey(),
  subject: text().notNull(),
  task: text().notNull(),
  url: text().notNull(),
  secret_ref: text().notNull(),
  previous_secret_ref: text(),
  rotation_until: integer().notNull().default(0),
  revision: integer().notNull(),
  expires: integer().notNull(),
  active: integer().notNull().default(0),
  verified_until: integer().notNull().default(0),
  at: integer().notNull(),
});
export const deliveries = sqliteTable(
  "deliveries",
  {
    id: text().primaryKey(),
    subscription: text().notNull(),
    event: text().notNull(),
    state: text().notNull(),
    fence: integer().notNull().default(0),
    lease: integer(),
    attempts: integer().notNull().default(0),
    retry_at: integer().notNull().default(0),
    revision: integer().notNull(),
    at: integer().notNull(),
  },
  (t) => [
    uniqueIndex("subscription_event").on(t.subscription, t.event),
    check(
      "delivery_state",
      sql`${t.state} IN ('pending','running','delivered','dead')`,
    ),
  ],
);

export const authorizationState = sqliteTable(
  "authorization_state",
  {
    kind: text().notNull(),
    target: text().notNull(),
    stopped: integer().notNull(),
    epoch: integer().notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.kind, t.target] }),
    check(
      "authorization_kind",
      sql`${t.kind} IN ('global','subject','client')`,
    ),
    check("authorization_target", sql`length(${t.target}) BETWEEN 1 AND 200`),
    check("authorization_stopped", sql`${t.stopped} IN (0,1)`),
    check("authorization_epoch", sql`${t.epoch}>=0`),
    check("authorization_global", sql`${t.kind}<>'global' OR ${t.target}='*'`),
  ],
);
export const authorizationChecks = sqliteTable(
  "authorization_checks",
  {
    id: integer().primaryKey(),
    subject: text().notNull(),
    client: text(),
    epoch: integer(),
  },
  (t) => [check("authorization_check_singleton", sql`${t.id}=1`)],
);
export const authorizationControlChecks = sqliteTable(
  "authorization_control_checks",
  {
    id: integer().primaryKey(),
    epoch: integer().notNull(),
  },
  (t) => [check("authorization_control_singleton", sql`${t.id}=1`)],
);
export const authorizationAudit = sqliteTable("authorization_audit", {
  seq: integer().primaryKey({ autoIncrement: true }),
  kind: text().notNull(),
  target: text().notNull(),
  stopped: integer().notNull(),
  epoch: integer().notNull(),
  actor: text().notNull(),
  at: integer().notNull(),
});

export const diagnosticPings = sqliteTable(
  "diagnostic_pings",
  {
    id: text().primaryKey(),
    correlation_id: text().notNull(),
    request_key: text().notNull(),
    sender_side: text().notNull(),
    recipient_side: text().notNull(),
    sender_subject: text().notNull(),
    sender_client: text().notNull(),
    recipient_subject: text().notNull(),
    recipient_client: text().notNull(),
    state: text().notNull(),
    created: integer().notNull(),
    expires: integer().notNull(),
    authorization_epoch: integer().notNull(),
    reply_id: text(),
    replied_at: integer(),
    actor_subject: text().notNull(),
    actor_client: text().notNull(),
    at: integer().notNull(),
  },
  (t) => [
    uniqueIndex("diagnostic_request_key").on(
      t.sender_subject,
      t.sender_client,
      t.request_key,
    ),
    uniqueIndex("diagnostic_correlation").on(t.correlation_id),
    uniqueIndex("diagnostic_reply_id").on(t.reply_id),
    check(
      "diagnostic_sides",
      sql`${t.sender_side} IN ('dots','grok') AND ${t.recipient_side} IN ('dots','grok') AND ${t.sender_side}<>${t.recipient_side}`,
    ),
    check(
      "diagnostic_state",
      sql`${t.state} IN ('pending','replied','expired')`,
    ),
    check(
      "diagnostic_ttl",
      sql`${t.expires}-${t.created} BETWEEN 1000 AND 300000`,
    ),
    check(
      "diagnostic_reply",
      sql`(${t.state}='replied' AND ${t.reply_id} IS NOT NULL AND ${t.replied_at} IS NOT NULL) OR (${t.state}<>'replied' AND ${t.reply_id} IS NULL AND ${t.replied_at} IS NULL)`,
    ),
  ],
);
export const diagnosticOutbox = sqliteTable(
  "diagnostic_outbox",
  {
    id: text().primaryKey(),
    request_id: text().notNull(),
    recipient_side: text().notNull(),
    kind: text().notNull(),
    delivery: text().notNull().default("pending"),
    at: integer().notNull(),
  },
  (t) => [
    uniqueIndex("diagnostic_event").on(t.request_id, t.kind),
    check(
      "diagnostic_delivery",
      sql`${t.delivery} IN ('pending','attempted','accepted','failed','uncertain')`,
    ),
    check(
      "diagnostic_kind",
      sql`${t.kind} IN ('requested','replied','expired')`,
    ),
  ],
);
export const diagnosticAudit = sqliteTable("diagnostic_audit", {
  seq: integer().primaryKey({ autoIncrement: true }),
  request_id: text().notNull(),
  actor_subject: text().notNull(),
  actor_client: text().notNull(),
  state: text().notNull(),
  at: integer().notNull(),
});

export const tokenBudget = sqliteTable(
  "token_budget",
  {
    period: text("period").primaryKey(),
    start: integer("start").notNull(),
    end: integer("end").notNull(),
    ceiling: integer("ceiling").notNull(),
    used: integer("used").notNull().default(0),
    state: text("state").notNull(),
    attempt: text("attempt"),
  },
  (t) => [
    check(
      "token_budget_limit",
      sql`${t.ceiling} BETWEEN 1 AND 1000 AND ${t.used} BETWEEN 0 AND ${t.ceiling}`,
    ),
    check("token_budget_period", sql`${t.end}>${t.start}`),
    check(
      "token_budget_state",
      sql`${t.state} IN ('open','attempting','parked')`,
    ),
  ],
);

export const taskTextRequests = sqliteTable(
  "task_text_requests",
  {
    task_id: text()
      .primaryKey()
      .references(() => tasks.id),
    owner_client: text().notNull(),
    worker_client: text(),
    owner_scope: text().notNull(),
    sender_agent: text().notNull(),
    recipient_agent: text().notNull(),
    recipient_owner: text().notNull(),
    conversation_binding: text().notNull(),
    accepted_at: integer().notNull(),
    work_deadline: integer().notNull(),
    fingerprint: text().notNull(),
    payload: text().notNull(),
  },
  (t) => [
    check(
      "text_payload_size",
      sql`length(CAST(${t.payload} AS BLOB)) <= 262144`,
    ),
    check("text_deadline", sql`${t.work_deadline} >= 0`),
  ],
);
