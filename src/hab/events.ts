/**
 * MCP events for new HAB mail (ADR-022). A cloud agent such as ChatGPT (Dots) subscribes
 * through its existing authenticated MCP connection; when a message waits in its inbox the
 * host POSTs a signed "you have mail" event to the callback ChatGPT gave, and ChatGPT starts
 * the task that calls hab_inbox. The event is a doorbell: it carries the recipient address
 * and arrival time only, never the body, sender, kind or IDs. Reading, the read/ACK boundary
 * and every authorization stay with hab_inbox.
 *
 * Wire format: OpenAI MCP Events (webhook delivery, Standard Webhooks signatures).
 * Constructing starts nothing; `start()` runs the dispatcher.
 */
import { DatabaseSync } from "node:sqlite";
import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { lookup as dnsLookup } from "node:dns/promises";
import { request } from "node:https";
import { BlockList, isIP } from "node:net";
import { z } from "zod";
import { ensurePrivateFile } from "../agent-notify/private-file.ts";
import { MessagingError } from "../messaging/delivery-service.ts";

export const HAB_EVENT_NAME = "hab.message.received";
export const habEventDefinition = Object.freeze({
  name: HAB_EVENT_NAME,
  description:
    "A message is waiting in your HAB inbox. Call hab_inbox to read it; the event carries no message content.",
  delivery: ["webhook"],
  inputSchema: {
    type: "object",
    properties: {},
    additionalProperties: false,
  },
  payloadSchema: {
    type: "object",
    properties: {
      to: { type: "string", description: "Your HAB address." },
      arrived_at: { type: "string", format: "date-time" },
    },
    required: ["to", "arrived_at"],
    additionalProperties: false,
  },
});

/** JSON-RPC error for a callback that fails verification (MCP Events). */
export const CALLBACK_ENDPOINT_ERROR = -32015;
export class HabEventError extends Error {
  readonly code: number;
  readonly reason: string;
  constructor(code: number, reason: string) {
    super(reason);
    this.code = code;
    this.reason = reason;
  }
}
const invalid = (reason: string) => new HabEventError(-32602, reason);
const callbackFailed = (reason: string) =>
  new HabEventError(CALLBACK_ENDPOINT_ERROR, reason);

export interface Arrival {
  accepted_at: number;
  sender_id: string;
  message_id: string;
}
/** What the host's HAB service gives the event module. */
export interface HabEventSource {
  /** Who the verified caller receives as; throws when it may not read an inbox. */
  eventRecipient(context: unknown): { agent_id: string; address: string };
  arrivals(agentId: string, after: Arrival | null, limit: number): Arrival[];
  addressOf(agentId: string): string | undefined;
}
export type WebhookPost = (
  url: string,
  body: string,
  headers: Record<string, string>,
) => Promise<{ status: number; body: string }>;

// ---- Standard Webhooks signatures ----

/** The raw key of a `whsec_` secret; 24–64 bytes as MCP Events requires. */
export function webhookKey(secret: unknown): Buffer {
  if (
    typeof secret !== "string" ||
    secret.length > 200 ||
    !/^whsec_[A-Za-z0-9+/]+={0,2}$/.test(secret)
  )
    throw invalid("invalid_secret");
  const key = Buffer.from(secret.slice(6), "base64");
  if (key.length < 24 || key.length > 64) throw invalid("invalid_secret");
  return key;
}
/** `v1,<base64 HMAC-SHA256 of "id.timestamp.body">`. */
export function signWebhook(
  secret: string,
  id: string,
  timestamp: number,
  body: string,
): string {
  return (
    "v1," +
    createHmac("sha256", webhookKey(secret))
      .update(`${id}.${timestamp}.${body}`)
      .digest("base64")
  );
}

// ---- Callback URLs: public HTTPS only ----

// Separate lists: an IPv6 rule such as ::ffff:0:0/96 would otherwise match every IPv4.
const blocked = new BlockList();
const blocked6 = new BlockList();
for (const [net, bits] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const)
  blocked.addSubnet(net, bits, "ipv4");
for (const [net, bits] of [
  ["::", 128],
  ["::1", 128],
  ["::ffff:0:0", 96],
  ["64:ff9b::", 96],
  ["100::", 64],
  ["2001:db8::", 32],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
] as const)
  blocked6.addSubnet(net, bits, "ipv6");
/** Whether an IP literal is a public unicast address (IPv4-mapped forms are judged as IPv4). */
export function isPublicAddress(address: string): boolean {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  if (mapped) return isPublicAddress(mapped[1]);
  const family = isIP(address);
  if (family === 4) return !blocked.check(address, "ipv4");
  if (family === 6) return !blocked6.check(address, "ipv6");
  return false;
}
export function callbackUrl(raw: unknown): URL {
  let url: URL;
  try {
    if (typeof raw !== "string" || raw.length > 2048) throw Error();
    url = new URL(raw);
  } catch {
    throw invalid("invalid_callback_url");
  }
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.hash ||
    !host ||
    (isIP(host) !== 0 && !isPublicAddress(host)) ||
    /(^|\.)(localhost|local|internal)$/i.test(host)
  )
    throw invalid("invalid_callback_url");
  return url;
}
type Lookup = (
  host: string,
) => Promise<readonly { address: string; family: number }[]>;
/**
 * POST over HTTPS to a public address: the name is resolved once, every answer must be
 * public, and the connection goes to the checked address while TLS still verifies the name.
 * No redirects, 10 s timeout, 64 KiB response cap.
 */
export function createHttpsPost(
  lookup: Lookup = (host) => dnsLookup(host, { all: true, verbatim: true }),
  timeoutMs = 10_000,
): WebhookPost {
  return async (raw, body, headers) => {
    const url = callbackUrl(raw);
    const host = url.hostname.replace(/^\[|\]$/g, "");
    const addresses =
      isIP(host) !== 0
        ? [{ address: host, family: isIP(host) }]
        : await lookup(host);
    if (
      !addresses.length ||
      !addresses.every((a) => isPublicAddress(a.address))
    )
      throw callbackFailed("callback_not_public");
    const target = addresses[0];
    return await new Promise((resolve, reject) => {
      const req = request(
        url,
        {
          method: "POST",
          headers: {
            ...headers,
            "Content-Length": String(Buffer.byteLength(body)),
          },
          timeout: timeoutMs,
          lookup: ((
            _hostname: string,
            options: { all?: boolean },
            callback: (...args: unknown[]) => void,
          ) =>
            options?.all
              ? callback(null, [target])
              : callback(null, target.address, target.family)) as never,
        },
        (res) => {
          const chunks: Buffer[] = [];
          let size = 0;
          res.on("data", (chunk: Buffer) => {
            size += chunk.length;
            if (size > 65_536) req.destroy(Error("response_too_large"));
            else chunks.push(chunk);
          });
          res.on("end", () =>
            resolve({
              status: res.statusCode ?? 0,
              body: Buffer.concat(chunks).toString("utf8"),
            }),
          );
          res.on("error", reject);
        },
      );
      req.on("timeout", () => req.destroy(Error("timeout")));
      req.on("error", reject);
      req.end(body);
    });
  };
}

// ---- Subscriptions ----

const subscribeParams = z.looseObject({
  name: z.string(),
  arguments: z.record(z.string(), z.unknown()).optional(),
  delivery: z.looseObject({
    mode: z.string(),
    url: z.unknown(),
    secret: z.unknown().optional(),
  }),
  ttlMs: z.number().int().positive().nullable().optional(),
  cursor: z.unknown().optional(),
});
export const habEventParamSchemas = Object.freeze({
  list: z.looseObject({ cursor: z.string().optional() }),
  subscribe: subscribeParams,
  unsubscribe: z.looseObject({
    name: z.string(),
    arguments: z.record(z.string(), z.unknown()).optional(),
    delivery: z.looseObject({ mode: z.string(), url: z.unknown() }),
  }),
});

interface Row {
  id: string;
  agent_id: string;
  url: string;
  secret: string;
  expires_at: number;
  cursor: string | null;
  failures: number;
  next_at: number;
}
export interface HabEventOptions {
  /** Absolute path of the owner-only subscription store. */
  store: string;
  /** Lifetime granted when the client asks for none (default 1 hour). */
  default_ttl_ms?: number;
  /** Longest lifetime granted; a revoked connection stops at the latest then (default 24 h). */
  max_ttl_ms?: number;
  /** Subscriptions per recipient (default 8). */
  max_per_agent?: number;
  /** How often the dispatcher looks for new mail (default 3 s). */
  poll_ms?: number;
  post?: WebhookPost;
  now?: () => number;
}
const MAX_ATTEMPTS = 8;

export class HabEvents {
  readonly #source: HabEventSource;
  readonly #db: DatabaseSync;
  readonly #post: WebhookPost;
  readonly #now: () => number;
  readonly #defaultTtl: number;
  readonly #maxTtl: number;
  readonly #maxPerAgent: number;
  readonly #pollMs: number;
  #timer: ReturnType<typeof setInterval> | undefined;
  #running: Promise<void> | undefined;
  constructor(source: HabEventSource, options: HabEventOptions) {
    this.#source = source;
    this.#post = options.post ?? createHttpsPost();
    this.#now = options.now ?? Date.now;
    this.#maxTtl = options.max_ttl_ms ?? 86_400_000;
    this.#defaultTtl = Math.min(
      options.default_ttl_ms ?? 3_600_000,
      this.#maxTtl,
    );
    this.#maxPerAgent = options.max_per_agent ?? 8;
    this.#pollMs = options.poll_ms ?? 3000;
    ensurePrivateFile(options.store, "unsafe_event_store");
    this.#db = new DatabaseSync(options.store, { timeout: 5000 });
    this.#db.exec(`PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS hab_event_subscriptions (
        id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, url TEXT NOT NULL,
        secret TEXT NOT NULL, expires_at INTEGER NOT NULL, cursor TEXT,
        failures INTEGER NOT NULL DEFAULT 0, next_at INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS hab_event_callbacks (
        agent_id TEXT NOT NULL, url TEXT NOT NULL, verified_until INTEGER NOT NULL,
        PRIMARY KEY(agent_id, url));`);
  }
  list(context: unknown) {
    this.#source.eventRecipient(context);
    return { events: [habEventDefinition] };
  }
  #identity(context: unknown, params: { name: string; arguments?: object }) {
    if (params.name !== HAB_EVENT_NAME) throw invalid("unknown_event");
    if (params.arguments && Object.keys(params.arguments).length)
      throw invalid("invalid_arguments");
    const recipient = this.#source.eventRecipient(context);
    return recipient;
  }
  /** Deterministic: the same recipient, callback, event and arguments give the same ID. */
  #id(agentId: string, url: string) {
    return (
      "hab_sub_" +
      createHash("sha256")
        .update(JSON.stringify([agentId, url, HAB_EVENT_NAME, {}]))
        .digest("hex")
        .slice(0, 32)
    );
  }
  async subscribe(context: unknown, raw: unknown) {
    const parsed = subscribeParams.safeParse(raw);
    if (!parsed.success) throw invalid("invalid_params");
    const params = parsed.data;
    if (params.delivery.mode !== "webhook")
      throw invalid("unsupported_delivery");
    const recipient = this.#identity(context, params);
    const url = callbackUrl(params.delivery.url).href;
    const secret = params.delivery.secret;
    webhookKey(secret);
    const id = this.#id(recipient.agent_id, url);
    const now = this.#now();
    const existing = this.#db
      .prepare("SELECT id FROM hab_event_subscriptions WHERE id=?")
      .get(id);
    if (!existing) {
      const count = this.#db
        .prepare(
          "SELECT count(*) n FROM hab_event_subscriptions WHERE agent_id=? AND expires_at>?",
        )
        .get(recipient.agent_id, now) as { n: number };
      if (count.n >= this.#maxPerAgent) throw invalid("too_many_subscriptions");
    }
    await this.#verify(recipient.agent_id, url, String(secret), id);
    const requested = params.ttlMs ?? this.#defaultTtl;
    const ttl = Math.max(60_000, Math.min(requested, this.#maxTtl));
    const expires = this.#now() + ttl;
    // A refresh keeps its place in the mail; only the secret and lifetime change.
    this.#db
      .prepare(
        `INSERT INTO hab_event_subscriptions (id,agent_id,url,secret,expires_at,created_at)
         VALUES (?,?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET secret=excluded.secret, expires_at=excluded.expires_at`,
      )
      .run(id, recipient.agent_id, url, String(secret), expires, now);
    return {
      id,
      refreshBefore: new Date(expires).toISOString(),
      cursor: null,
      truncated: false,
    };
  }
  unsubscribe(context: unknown, raw: unknown) {
    const parsed = habEventParamSchemas.unsubscribe.safeParse(raw);
    if (!parsed.success) throw invalid("invalid_params");
    const recipient = this.#identity(context, parsed.data);
    let url: string;
    try {
      url = callbackUrl(parsed.data.delivery.url).href;
    } catch {
      return {};
    }
    this.#db
      .prepare("DELETE FROM hab_event_subscriptions WHERE id=? AND agent_id=?")
      .run(this.#id(recipient.agent_id, url), recipient.agent_id);
    return {};
  }
  async #verify(agentId: string, url: string, secret: string, id: string) {
    const now = this.#now();
    const cached = this.#db
      .prepare(
        "SELECT verified_until FROM hab_event_callbacks WHERE agent_id=? AND url=?",
      )
      .get(agentId, url) as { verified_until: number } | undefined;
    if (cached && cached.verified_until > now) return;
    const challenge = randomBytes(24).toString("base64url");
    const body = JSON.stringify({ type: "verification", challenge });
    const messageId = `msg_verify_${randomBytes(12).toString("hex")}`;
    let answer: { status: number; body: string };
    try {
      answer = await this.#post(
        url,
        body,
        this.#headers(secret, messageId, id, body),
      );
    } catch (error) {
      if (error instanceof HabEventError) throw error;
      throw callbackFailed("timeout");
    }
    let echoed: unknown;
    try {
      echoed = (JSON.parse(answer.body) as { challenge?: unknown }).challenge;
    } catch {
      echoed = undefined;
    }
    if (
      answer.status < 200 ||
      answer.status > 299 ||
      typeof echoed !== "string" ||
      echoed.length !== challenge.length ||
      !timingSafeEqual(Buffer.from(echoed), Buffer.from(challenge))
    )
      throw callbackFailed("challenge_failed");
    this.#db
      .prepare(
        `INSERT INTO hab_event_callbacks (agent_id,url,verified_until) VALUES (?,?,?)
         ON CONFLICT(agent_id,url) DO UPDATE SET verified_until=excluded.verified_until`,
      )
      .run(agentId, url, now + 86_400_000);
  }
  #headers(
    secret: string,
    messageId: string,
    subscriptionId: string,
    body: string,
  ) {
    const timestamp = Math.floor(this.#now() / 1000);
    return {
      "Content-Type": "application/json",
      "webhook-id": messageId,
      "webhook-timestamp": String(timestamp),
      "webhook-signature": signWebhook(secret, messageId, timestamp, body),
      "X-MCP-Subscription-Id": subscriptionId,
    };
  }
  /** Active subscriptions, without secrets (for operators and tests). */
  subscriptions() {
    return (
      this.#db
        .prepare(
          "SELECT id,agent_id,url,expires_at,cursor,failures FROM hab_event_subscriptions ORDER BY id",
        )
        .all() as unknown as Omit<Row, "secret" | "next_at">[]
    ).map((row) => ({ ...row }));
  }
  /**
   * One pass: for each live subscription, send one event per new unread message, oldest
   * first. The cursor moves only after a 2xx (or a 413, or the last of 8 attempts), so a
   * message is announced once per subscription. 410 ends the subscription.
   */
  async dispatch() {
    const now = this.#now();
    this.#db
      .prepare("DELETE FROM hab_event_subscriptions WHERE expires_at<=?")
      .run(now);
    this.#db
      .prepare("DELETE FROM hab_event_callbacks WHERE verified_until<=?")
      .run(now);
    const rows = this.#db
      .prepare(
        "SELECT * FROM hab_event_subscriptions WHERE next_at<=? ORDER BY id",
      )
      .all(now) as unknown as Row[];
    for (const row of rows) await this.#dispatchOne(row);
  }
  async #dispatchOne(row: Row) {
    const address = this.#source.addressOf(row.agent_id);
    if (!address) {
      this.#db
        .prepare("DELETE FROM hab_event_subscriptions WHERE id=?")
        .run(row.id);
      return;
    }
    let cursor = row.cursor ? (JSON.parse(row.cursor) as Arrival) : null;
    let failures = row.failures;
    for (let sent = 0; sent < 10; sent++) {
      const [arrival] = this.#source.arrivals(row.agent_id, cursor, 1);
      if (!arrival) break;
      const eventId =
        "evt_" +
        createHash("sha256")
          .update(
            JSON.stringify([row.id, arrival.sender_id, arrival.message_id]),
          )
          .digest("hex")
          .slice(0, 32);
      const arrived = new Date(arrival.accepted_at).toISOString();
      const body = JSON.stringify({
        eventId,
        name: HAB_EVENT_NAME,
        timestamp: arrived,
        data: { to: address, arrived_at: arrived },
        cursor: null,
      });
      let status = 0;
      try {
        status = (
          await this.#post(
            row.url,
            body,
            this.#headers(row.secret, eventId, row.id, body),
          )
        ).status;
      } catch {
        status = 0;
      }
      if (status === 410) {
        this.#db
          .prepare("DELETE FROM hab_event_subscriptions WHERE id=?")
          .run(row.id);
        return;
      }
      const delivered = status >= 200 && status <= 299;
      if (delivered || status === 413 || failures + 1 >= MAX_ATTEMPTS) {
        cursor = arrival;
        failures = 0;
        this.#save(row.id, cursor, 0, 0);
        continue;
      }
      failures += 1;
      this.#save(
        row.id,
        cursor,
        failures,
        this.#now() + Math.min(300_000, 2000 * 2 ** failures),
      );
      return;
    }
  }
  #save(id: string, cursor: Arrival | null, failures: number, nextAt: number) {
    this.#db
      .prepare(
        "UPDATE hab_event_subscriptions SET cursor=?, failures=?, next_at=? WHERE id=?",
      )
      .run(cursor ? JSON.stringify(cursor) : null, failures, nextAt, id);
  }
  start() {
    if (this.#timer) return;
    this.#timer = setInterval(() => {
      if (this.#running) return;
      this.#running = this.dispatch()
        .catch(() => {})
        .finally(() => {
          this.#running = undefined;
        });
    }, this.#pollMs);
    this.#timer.unref?.();
  }
  async close() {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
    await this.#running;
    this.#db.close();
  }
}
/** Whether a thrown value is the forbidden refusal of an unauthorized caller. */
export const isForbidden = (error: unknown) =>
  error instanceof MessagingError && error.code === "forbidden";
