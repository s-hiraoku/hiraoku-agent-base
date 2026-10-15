import { z } from "zod";
import type { TaskService } from "./store.ts";
import type { Principal, Row, Statement, Operation } from "./types.ts";
const identity = z
  .object({
    subject: z.string().min(1).max(200),
    clientId: z.string().min(1).max(200),
  })
  .strict();
const routing = z
  .object({ dots: identity, grok: identity })
  .strict()
  .refine((r) => r.dots.clientId !== r.grok.clientId);
const id = z.string().uuid();
export const pingSchemas = {
  ping_submit: z
    .object({
      request_key: z.string().regex(/^[A-Za-z0-9_-]{1,80}$/),
      payload: z.literal("ping"),
      ttl_ms: z.number().int().min(1000).max(300000).default(60000),
    })
    .strict(),
  ping_get: z.object({ id }).strict(),
  ping_reply: z
    .object({ correlation_id: id, in_reply_to: id, payload: z.literal("pong") })
    .strict(),
  ping_pending: z.object({}).strict(),
};
const sql = (
  query: string,
  ...params: (string | number | null)[]
): Statement => ({ sql: query, params });
/** Exact enrolled subject/client pairs, not caller agent labels. Disabled unless injected. */
export class PingService {
  readonly hub: TaskService;
  readonly wakeTimeoutMs: number;
  readonly routes?: z.infer<typeof routing>;
  constructor(
    hub: TaskService,
    routes?: unknown,
    options: { wakeTimeoutMs?: number } = {},
  ) {
    this.hub = hub;
    this.wakeTimeoutMs = z
      .number()
      .int()
      .min(1)
      .max(3000)
      .parse(options.wakeTimeoutMs ?? 2000);
    if (routes !== undefined)
      this.routes = Object.freeze(routing.parse(routes));
  }
  private async actor(p: Principal, op: Operation) {
    this.hub.principal(p, op);
    if (!this.routes) throw Error("ping_disabled");
    const side = (["dots", "grok"] as const).find(
      (s) =>
        this.routes![s].subject === p.subject &&
        this.routes![s].clientId === p.clientId,
    );
    if (!side) throw Error("ping_identity_rejected");
    return {
      p: await this.hub.authorization.bind(p),
      side,
      peer: side === "dots" ? ("grok" as const) : ("dots" as const),
    };
  }
  private view(row: Row) {
    return {
      id: row.id,
      correlation_id: row.correlation_id,
      sender: row.sender_side,
      recipient: row.recipient_side,
      payload: "ping",
      state: row.state,
      created_at: row.created,
      expires_at: row.expires,
      reply: row.reply_id
        ? {
            id: row.reply_id,
            correlation_id: row.correlation_id,
            in_reply_to: row.id,
            sender: row.recipient_side,
            recipient: row.sender_side,
            payload: "pong",
            created_at: row.replied_at,
          }
        : null,
    };
  }
  async submit(p: Principal, args: unknown) {
    const a = pingSchemas.ping_submit.parse(args),
      actor = await this.actor(p, "ping_submit"),
      clock = this.hub.driver.nowSQL;
    const recipient = this.routes![actor.peer];
    const rows = await this.hub.authorization.batch(
      actor.p,
      [
        sql(
          `UPDATE diagnostic_pings SET state='expired',actor_subject=?,actor_client=?,at=${clock} WHERE sender_subject=? AND sender_client=? AND state='pending' AND (expires<=${clock} OR authorization_epoch<>(SELECT epoch FROM authorization_state WHERE kind='global' AND target='*'))`,
          p.subject,
          p.clientId!,
          p.subject,
          p.clientId!,
        ),
        // Materialize one DB-clock sample: SQLite UDF calls may cross a millisecond.
        sql(
          `WITH ping_clock AS MATERIALIZED (SELECT ${clock} AS now) INSERT OR IGNORE INTO diagnostic_pings(id,correlation_id,request_key,sender_side,recipient_side,sender_subject,sender_client,recipient_subject,recipient_client,state,created,expires,authorization_epoch,actor_subject,actor_client,at) SELECT ?,?,?,?,?,?,?,?,?,'pending',ping_clock.now,ping_clock.now+?,(SELECT epoch FROM authorization_state WHERE kind='global' AND target='*'),?,?,ping_clock.now FROM ping_clock WHERE (SELECT COUNT(*) FROM diagnostic_pings WHERE sender_subject=? AND sender_client=? AND state='pending')<10 OR EXISTS(SELECT 1 FROM diagnostic_pings WHERE sender_subject=? AND sender_client=? AND request_key=?)`,
          crypto.randomUUID(),
          crypto.randomUUID(),
          a.request_key,
          actor.side,
          actor.peer,
          p.subject,
          p.clientId!,
          recipient.subject,
          recipient.clientId,
          a.ttl_ms,
          p.subject,
          p.clientId!,
          p.subject,
          p.clientId!,
          p.subject,
          p.clientId!,
          a.request_key,
        ),
        sql(
          "SELECT * FROM diagnostic_pings WHERE sender_subject=? AND sender_client=? AND request_key=?",
          p.subject,
          p.clientId!,
          a.request_key,
        ),
      ],
      [recipient],
    );
    const row = rows[2][0];
    if (!row) throw Error("ping_capacity_rejected");
    if (
      Number(row.expires) - Number(row.created) !== a.ttl_ms ||
      row.recipient_subject !== recipient.subject ||
      row.recipient_client !== recipient.clientId
    )
      throw Error("ping_idempotency_conflict");
    return this.view(row);
  }
  async get(p: Principal, args: unknown) {
    const a = pingSchemas.ping_get.parse(args),
      actor = await this.actor(p, "ping_get"),
      clock = this.hub.driver.nowSQL;
    const access =
      "id=? AND ((sender_subject=? AND sender_client=?) OR (recipient_subject=? AND recipient_client=?))";
    const params = [a.id, p.subject, p.clientId!, p.subject, p.clientId!];
    const rows = await this.hub.authorization.batch(actor.p, [
      sql(
        `UPDATE diagnostic_pings SET state='expired',actor_subject=?,actor_client=?,at=${clock} WHERE ${access} AND state='pending' AND (expires<=${clock} OR authorization_epoch<>(SELECT epoch FROM authorization_state WHERE kind='global' AND target='*'))`,
        p.subject,
        p.clientId!,
        ...params,
      ),
      sql(`SELECT * FROM diagnostic_pings WHERE ${access}`, ...params),
    ]);
    if (!rows[1][0]) throw Error("ping_not_found");
    return this.view(rows[1][0]);
  }
  async reply(p: Principal, args: unknown) {
    const a = pingSchemas.ping_reply.parse(args),
      actor = await this.actor(p, "ping_reply"),
      clock = this.hub.driver.nowSQL,
      sender = this.routes![actor.peer];
    const access =
      "id=? AND correlation_id=? AND recipient_subject=? AND recipient_client=? AND sender_subject=? AND sender_client=?";
    const params = [
      a.in_reply_to,
      a.correlation_id,
      p.subject,
      p.clientId!,
      sender.subject,
      sender.clientId,
    ];
    const rows = await this.hub.authorization.batch(
      actor.p,
      [
        sql(
          `UPDATE diagnostic_pings SET state='replied',reply_id=?,replied_at=${clock},actor_subject=?,actor_client=?,at=${clock} WHERE ${access} AND state='pending' AND expires>${clock} AND authorization_epoch=(SELECT epoch FROM authorization_state WHERE kind='global' AND target='*')`,
          crypto.randomUUID(),
          p.subject,
          p.clientId!,
          ...params,
        ),
        sql(
          `SELECT * FROM diagnostic_pings WHERE ${access} AND state='replied'`,
          ...params,
        ),
      ],
      [sender],
    );
    if (!rows[1][0]) throw Error("ping_reply_rejected");
    return this.view(rows[1][0]);
  }
  async pending(p: Principal, args: unknown) {
    pingSchemas.ping_pending.parse(args);
    const actor = await this.actor(p, "ping_pending"),
      clock = this.hub.driver.nowSQL;
    const rows = await this.hub.authorization.batch(actor.p, [
      sql(
        `SELECT * FROM diagnostic_pings WHERE recipient_subject=? AND recipient_client=? AND state='pending' AND expires>${clock} AND authorization_epoch=(SELECT epoch FROM authorization_state WHERE kind='global' AND target='*') ORDER BY created,id LIMIT 10`,
        p.subject,
        p.clientId!,
      ),
    ]);
    return rows[0].map((row) => this.view(row));
  }
  /** Trusted backend capability: injected fixed Grok routine transport only; no HTTP tool.
   * One attempt per event. A crash/unknown response parks the event, never retries the Bot.
   */
  async dispatchGrokWake(transport: {
    post(
      body: {
        request_id: string;
        correlation_id: string;
        payload: "ping";
      },
      signal: AbortSignal,
    ): Promise<{ status: number }>;
  }): Promise<boolean> {
    if (!this.routes) throw Error("ping_disabled");
    const { dots, grok } = this.routes,
      clock = this.hub.driver.nowSQL;
    const principal = await this.hub.authorization.bind({
      ...dots,
      operations: [],
    });
    const rows = await this.hub.authorization.batch(
      principal,
      [
        sql(
          `UPDATE diagnostic_outbox SET delivery='attempted',at=${clock} WHERE id=(SELECT o.id FROM diagnostic_outbox o JOIN diagnostic_pings p ON p.id=o.request_id WHERE o.kind='requested' AND o.recipient_side='grok' AND o.delivery='pending' AND p.state='pending' AND p.expires>${clock} AND p.authorization_epoch=(SELECT epoch FROM authorization_state WHERE kind='global' AND target='*') AND p.sender_subject=? AND p.sender_client=? AND p.recipient_subject=? AND p.recipient_client=? ORDER BY o.at,o.id LIMIT 1) RETURNING request_id`,
          dots.subject,
          dots.clientId,
          grok.subject,
          grok.clientId,
        ),
      ],
      [grok],
    );
    const job = rows[0][0];
    if (!job) return false;
    const started = performance.now();
    const row = (
      await this.hub.authorization.batch(
        principal,
        [
          sql(
            "SELECT id,correlation_id,expires-" +
              clock +
              " AS remaining_ms FROM diagnostic_pings WHERE id=? AND state='pending' AND authorization_epoch=(SELECT epoch FROM authorization_state WHERE kind='global' AND target='*') AND expires>" +
              clock,
            String(job.request_id),
          ),
        ],
        [grok],
      )
    )[0][0];
    if (!row) return true;
    let delivery = "uncertain";
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const budget = Math.min(
      this.wakeTimeoutMs,
      Number(row.remaining_ms) - (performance.now() - started),
    );
    try {
      if (budget <= 0) throw Error("wake_expired");
      const result = await Promise.race([
        transport.post(
          {
            request_id: String(row.id),
            correlation_id: String(row.correlation_id),
            payload: "ping",
          },
          controller.signal,
        ),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(Error("wake_timeout"));
          }, budget);
        }),
      ]);
      delivery = result.status === 200 ? "accepted" : "failed";
    } catch {
      /* No provider error or secret logging. No automatic retry after unknown admission. */
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
    await this.hub.authorization.batch(
      principal,
      [
        sql(
          `UPDATE diagnostic_outbox SET delivery=?,at=${clock} WHERE request_id=? AND kind='requested' AND delivery='attempted'`,
          delivery,
          String(row.id),
        ),
      ],
      [grok],
    );
    return true;
  }
}
