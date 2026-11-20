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
import { request as httpRequest } from "node:http";
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
  /** Whether one message still waits unread; without it the doorbell is never rung again. */
  unread?(agentId: string, key: Omit<Arrival, "accepted_at">): boolean;
}
/**
 * What the recipient's own MCP results say about mail it has not read (ADR-027). The
 * recipient sees it the next time it calls any HAB tool, so an agent whose event task did
 * not run learns that the doorbell rang and nothing read the inbox.
 */
export interface InboxReminder {
  unread: number;
  /** More than `unread` messages wait. */
  more: boolean;
  oldest_unread_at: string;
  /** The earliest doorbell a callback accepted with a 2xx for mail still unread, if any. */
  doorbell_delivered_at: string | null;
  /** A doorbell was accepted for this mail at least `unanswered_after_ms` ago. */
  doorbell_unanswered: boolean;
  explanation: string;
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
/**
 * An operator-registered doorbell URL (ADR-029). Besides public HTTPS it may be plain HTTP
 * to the loopback address literal with a port (ADR-032: a notifier on the same machine,
 * such as Hermes's). Only the operator's config can name it; agent subscriptions still go
 * through `callbackUrl`.
 */
export function operatorCallbackUrl(raw: unknown): URL {
  try {
    return callbackUrl(raw);
  } catch (error) {
    let url: URL;
    try {
      if (typeof raw !== "string" || raw.length > 2048) throw Error();
      url = new URL(raw);
    } catch {
      throw error;
    }
    if (!isLoopbackUrl(url)) throw error;
    return url;
  }
}
function isLoopbackUrl(url: URL): boolean {
  return (
    url.protocol === "http:" &&
    (url.hostname === "127.0.0.1" || url.hostname === "[::1]") &&
    url.port !== "" &&
    !url.username &&
    !url.password &&
    !url.hash
  );
}
/** POST to an operator loopback doorbell: no name lookup, no redirects, 64 KiB, 10 s. */
export function createLoopbackPost(timeoutMs = 10_000): WebhookPost {
  return (raw, body, headers) =>
    new Promise((resolve, reject) => {
      const url = new URL(raw);
      if (!isLoopbackUrl(url)) {
        reject(callbackFailed("callback_not_public"));
        return;
      }
      const req = httpRequest(
        {
          host: url.hostname.replace(/^\[|\]$/g, ""),
          port: Number(url.port),
          path: url.pathname + url.search,
          method: "POST",
          headers: {
            ...headers,
            "Content-Length": String(Buffer.byteLength(body)),
          },
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
      const timer = setTimeout(() => {
        req.destroy();
        reject(callbackFailed("timeout"));
      }, timeoutMs);
      req.on("close", () => clearTimeout(timer));
      req.on("error", reject);
      req.end(body);
    });
}
/** Public HTTPS for every callback, plus loopback HTTP for operator doorbells (ADR-032). */
export function createWebhookPost(
  https: WebhookPost = createHttpsPost(),
  loopback: WebhookPost = createLoopbackPost(),
): WebhookPost {
  return (raw, body, headers) => {
    let url: URL | undefined;
    try {
      url = new URL(raw);
    } catch {
      url = undefined;
    }
    return url && isLoopbackUrl(url)
      ? loopback(raw, body, headers)
      : https(raw, body, headers);
  };
}
type Lookup = (
  host: string,
) => Promise<readonly { address: string; family: number }[]>;
/**
 * POST over HTTPS to a public address: the name is resolved once, every answer must be
 * public, and the connection goes to the checked address while TLS still verifies the name.
 * No redirects, 64 KiB response cap. `timeoutMs` (10 s) is a wall-clock deadline for the
 * whole call, name resolution and the complete response included, so a callback that
 * trickles bytes cannot hold the sequential dispatcher.
 */
export function createHttpsPost(
  lookup: Lookup = (host) => dnsLookup(host, { all: true, verbatim: true }),
  timeoutMs = 10_000,
): WebhookPost {
  return (raw, body, headers) => {
    let cancel: (() => void) | undefined;
    let expired = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        expired = true;
        cancel?.();
        reject(callbackFailed("timeout"));
      }, timeoutMs);
    });
    // A request created after the deadline (slow name resolution) is destroyed at once.
    const attempt = post(raw, body, headers, (destroy) => {
      cancel = destroy;
      if (expired) destroy();
    });
    attempt.catch(() => {});
    return Promise.race([attempt, deadline]).finally(() => clearTimeout(timer));
  };
  async function post(
    raw: string,
    body: string,
    headers: Record<string, string>,
    onRequest: (destroy: () => void) => void,
  ): Promise<{ status: number; body: string }> {
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
      onRequest(() => req.destroy(Error("timeout")));
      req.on("error", reject);
      req.end(body);
    });
  }
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
  /** The message the failures were counted for; another message starts from zero. */
  failing: string | null;
  next_at: number;
  created_at: number;
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
  /**
   * A gap longer than this between dispatcher ticks means the host was stopped or the
   * machine slept (default 60 s; never less than three polls). That time is not counted
   * against the subscriptions alive when the gap began.
   */
  outage_after_ms?: number;
  /**
   * How long a message may stay unread after its doorbell was accepted before HAB counts the
   * doorbell as unanswered: it rings once more and tells the recipient in its next tool
   * result (default 5 minutes; ADR-027).
   */
  unanswered_after_ms?: number;
  /** Ring once more for an unanswered doorbell (default true). */
  rering?: boolean;
  /**
   * Hold newer mail's doorbell while the subscription's last accepted doorbell is younger
   * than `unanswered_after_ms` and its mail is still unread (default true; ADR-030).
   */
  quiet?: boolean;
  /**
   * Inbox check (ADR-031): while mail waits unread, ring each live doorbell again once
   * this long after its last accepted ring (or the last check), so an agent that missed or
   * ignored the doorbell is asked to look at its inbox on a regular interval. 0 turns it
   * off (default 10 minutes).
   */
  inbox_check_ms?: number;
  /** Per recipient agent ID, overriding `inbox_check_ms` (0 turns it off for that agent). */
  inbox_check_by_agent?: Readonly<Record<string, number>>;
  /** Check rings for the same oldest unread message, per doorbell (default 6). */
  inbox_check_max_rings?: number;
  post?: WebhookPost;
  now?: () => number;
}
const MAX_ATTEMPTS = 8;
/**
 * Operator-registered doorbells (ADR-029) live in the same table under this ID prefix. They
 * never expire, take no subscriber slot and cannot be unsubscribed through MCP; the host
 * config is their only source, applied at start.
 */
const STATIC_PREFIX = "hab_static_";
const NEVER = 8_640_000_000_000_000;
const BEARER = /^[A-Za-z0-9._~+/=-]{16,512}$/;
/** A doorbell secret: a Standard Webhooks `whsec_` key, or a Bearer token. */
export function doorbellSecret(secret: unknown): string {
  if (typeof secret === "string" && secret.startsWith("whsec_")) {
    webhookKey(secret);
    return secret;
  }
  if (typeof secret !== "string" || !BEARER.test(secret))
    throw invalid("invalid_secret");
  return secret;
}
/** One doorbell the operator registered for an address (ADR-029). */
export interface StaticDoorbell {
  agent_id: string;
  url: string;
  secret: string;
}

export class HabEvents {
  readonly #source: HabEventSource;
  readonly #db: DatabaseSync;
  readonly #post: WebhookPost;
  readonly #now: () => number;
  readonly #defaultTtl: number;
  readonly #maxTtl: number;
  readonly #maxPerAgent: number;
  readonly #pollMs: number;
  readonly #outageAfter: number;
  readonly #unansweredAfter: number;
  readonly #rering: boolean;
  readonly #quiet: boolean;
  readonly #checkMs: number;
  readonly #checkByAgent: ReadonlyMap<string, number>;
  readonly #checkMaxRings: number;
  #timer: ReturnType<typeof setInterval> | undefined;
  #running: Promise<void> | undefined;
  constructor(source: HabEventSource, options: HabEventOptions) {
    this.#source = source;
    this.#post = options.post ?? createWebhookPost();
    this.#now = options.now ?? Date.now;
    this.#maxTtl = options.max_ttl_ms ?? 86_400_000;
    this.#defaultTtl = Math.min(
      options.default_ttl_ms ?? 3_600_000,
      this.#maxTtl,
    );
    this.#maxPerAgent = options.max_per_agent ?? 8;
    this.#pollMs = options.poll_ms ?? 3000;
    // Never at or below the ordinary tick spacing, or every tick would extend lifetimes.
    this.#outageAfter = Math.max(
      options.outage_after_ms ?? 60_000,
      3 * this.#pollMs,
    );
    this.#unansweredAfter = options.unanswered_after_ms ?? 300_000;
    this.#rering = options.rering ?? true;
    this.#quiet = options.quiet ?? true;
    this.#checkMs = options.inbox_check_ms ?? 600_000;
    this.#checkByAgent = new Map(
      Object.entries(options.inbox_check_by_agent ?? {}),
    );
    this.#checkMaxRings = options.inbox_check_max_rings ?? 6;
    ensurePrivateFile(options.store, "unsafe_event_store");
    this.#db = new DatabaseSync(options.store, { timeout: 5000 });
    this.#db.exec(`PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS hab_event_subscriptions (
        id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, url TEXT NOT NULL,
        secret TEXT NOT NULL, expires_at INTEGER NOT NULL, cursor TEXT,
        failures INTEGER NOT NULL DEFAULT 0, failing TEXT, next_at INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS hab_event_callbacks (
        agent_id TEXT NOT NULL, url TEXT NOT NULL, verified_until INTEGER NOT NULL,
        PRIMARY KEY(agent_id, url));
      CREATE TABLE IF NOT EXISTS hab_event_clock (
        id INTEGER PRIMARY KEY CHECK(id=1), alive_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS hab_event_lapses (
        agent_id TEXT PRIMARY KEY, lapsed_at INTEGER NOT NULL,
        reason TEXT NOT NULL CHECK(reason IN ('expired','gone','unsubscribed')));
      CREATE TABLE IF NOT EXISTS hab_event_rings (
        agent_id TEXT PRIMARY KEY, rang_at INTEGER NOT NULL, status INTEGER NOT NULL,
        delivered_at INTEGER);
      CREATE TABLE IF NOT EXISTS hab_event_rerings (
        subscription_id TEXT NOT NULL, sender_id TEXT NOT NULL, message_id TEXT NOT NULL,
        accepted_at INTEGER NOT NULL, due_at INTEGER NOT NULL,
        PRIMARY KEY(subscription_id, sender_id, message_id));
      CREATE TABLE IF NOT EXISTS hab_event_accepted (
        agent_id TEXT NOT NULL, sender_id TEXT NOT NULL, message_id TEXT NOT NULL,
        accepted_at INTEGER NOT NULL,
        PRIMARY KEY(agent_id, sender_id, message_id));
      CREATE TABLE IF NOT EXISTS hab_event_quiet (
        subscription_id TEXT PRIMARY KEY, sender_id TEXT NOT NULL, message_id TEXT NOT NULL,
        rang_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS hab_event_checks (
        subscription_id TEXT PRIMARY KEY, sender_id TEXT NOT NULL, message_id TEXT NOT NULL,
        rings INTEGER NOT NULL, checked_at INTEGER NOT NULL);`);
  }
  /**
   * Bring the store up to the present. A long gap since the last tick is an outage (the
   * host was stopped or the Mac slept): the subscriber could not refresh during it, so the
   * subscriptions alive when it began get the gap back, at most `max_ttl_ms`. Then expired
   * subscriptions end and are remembered as lapsed for operators.
   */
  #settle() {
    const now = this.#now();
    const clock = this.#db
      .prepare("SELECT alive_at FROM hab_event_clock WHERE id=1")
      .get() as { alive_at: number } | undefined;
    if (clock && now - clock.alive_at > this.#outageAfter)
      this.#db
        .prepare(
          `UPDATE hab_event_subscriptions SET expires_at=expires_at+? WHERE expires_at>? AND id NOT LIKE '${STATIC_PREFIX}%'`,
        )
        .run(Math.min(now - clock.alive_at, this.#maxTtl), clock.alive_at);
    this.#db
      .prepare(
        `INSERT INTO hab_event_clock (id,alive_at) VALUES (1,?)
         ON CONFLICT(id) DO UPDATE SET alive_at=max(alive_at,excluded.alive_at)`,
      )
      .run(now);
    const expired = this.#db
      .prepare(
        "SELECT id,agent_id,expires_at FROM hab_event_subscriptions WHERE expires_at<=? ORDER BY expires_at",
      )
      .all(now) as unknown as {
      id: string;
      agent_id: string;
      expires_at: number;
    }[];
    for (const row of expired)
      this.#end(row.id, row.agent_id, "expired", row.expires_at);
    this.#db
      .prepare("DELETE FROM hab_event_callbacks WHERE verified_until<=?")
      .run(now);
    // Mail expires unread after 7 days, so older first acceptances can no longer matter.
    this.#db
      .prepare("DELETE FROM hab_event_accepted WHERE accepted_at<=?")
      .run(now - 8 * 86_400_000);
  }
  /** Remove a subscription and remember when and why the recipient's doorbell stopped. */
  #end(
    id: string,
    agentId: string,
    reason: "expired" | "gone" | "unsubscribed",
    at = this.#now(),
  ) {
    const removed = this.#db
      .prepare("DELETE FROM hab_event_subscriptions WHERE id=? AND agent_id=?")
      .run(id, agentId);
    this.#db
      .prepare("DELETE FROM hab_event_quiet WHERE subscription_id=?")
      .run(id);
    this.#db
      .prepare("DELETE FROM hab_event_checks WHERE subscription_id=?")
      .run(id);
    if (!removed.changes) return;
    this.#db
      .prepare(
        `INSERT INTO hab_event_lapses (agent_id,lapsed_at,reason) VALUES (?,?,?)
         ON CONFLICT(agent_id) DO UPDATE SET lapsed_at=excluded.lapsed_at, reason=excluded.reason`,
      )
      .run(agentId, at, reason);
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
    this.#settle();
    const now = this.#now();
    if (!this.#has(id) && this.#count(recipient.agent_id) >= this.#maxPerAgent)
      throw invalid("too_many_subscriptions");
    await this.#verify(recipient.agent_id, url, String(secret), id);
    // Settled again after the network wait and before the write: the new lifetime must
    // not be mistaken for one that was alive before a gap.
    this.#settle();
    const requested = params.ttlMs ?? this.#defaultTtl;
    const ttl = Math.max(60_000, Math.min(requested, this.#maxTtl));
    const expires = this.#now() + ttl;
    // Checked again after the network wait, with no await before the insert, so
    // concurrent subscribes cannot together pass the per-recipient limit.
    if (!this.#has(id) && this.#count(recipient.agent_id) >= this.#maxPerAgent)
      throw invalid("too_many_subscriptions");
    // A refresh keeps its place in the mail; only the secret and lifetime change.
    this.#db
      .prepare(
        `INSERT INTO hab_event_subscriptions (id,agent_id,url,secret,expires_at,created_at)
         VALUES (?,?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET secret=excluded.secret, expires_at=excluded.expires_at`,
      )
      .run(id, recipient.agent_id, url, String(secret), expires, now);
    this.#db
      .prepare("DELETE FROM hab_event_lapses WHERE agent_id=?")
      .run(recipient.agent_id);
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
    this.#end(
      this.#id(recipient.agent_id, url),
      recipient.agent_id,
      "unsubscribed",
    );
    return {};
  }
  /** Whether a live subscription exists: an expired one awaiting cleanup takes a new slot. */
  #has(id: string) {
    return !!this.#db
      .prepare(
        "SELECT 1 FROM hab_event_subscriptions WHERE id=? AND expires_at>?",
      )
      .get(id, this.#now());
  }
  #count(agentId: string) {
    return (
      this.#db
        .prepare(
          `SELECT count(*) n FROM hab_event_subscriptions WHERE agent_id=? AND expires_at>? AND id NOT LIKE '${STATIC_PREFIX}%'`,
        )
        .get(agentId, this.#now()) as { n: number }
    ).n;
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
  ): Record<string, string> {
    const timestamp = Math.floor(this.#now() / 1000);
    // An operator-registered doorbell may use a Bearer token instead of a signing key.
    if (!secret.startsWith("whsec_"))
      return {
        "Content-Type": "application/json",
        Authorization: `Bearer ${secret}`,
        "webhook-id": messageId,
        "webhook-timestamp": String(timestamp),
      };
    return {
      "Content-Type": "application/json",
      "webhook-id": messageId,
      "webhook-timestamp": String(timestamp),
      "webhook-signature": signWebhook(secret, messageId, timestamp, body),
      "X-MCP-Subscription-Id": subscriptionId,
    };
  }
  /**
   * Apply the operator-registered doorbells (ADR-029): add or update these, remove the
   * ones no longer listed. A new doorbell starts after the mail already waiting, so a
   * restart or a new entry does not ring for old messages. No challenge is sent: the
   * operator vouches for the URL, which must be public HTTPS or a loopback
   * notifier on this machine (`operatorCallbackUrl`).
   */
  configureStatic(doorbells: readonly StaticDoorbell[]) {
    const keep = new Set<string>();
    const now = this.#now();
    for (const doorbell of doorbells) {
      const url = operatorCallbackUrl(doorbell.url).href;
      const secret = doorbellSecret(doorbell.secret);
      const id =
        STATIC_PREFIX +
        createHash("sha256")
          .update(JSON.stringify([doorbell.agent_id, url]))
          .digest("hex")
          .slice(0, 32);
      keep.add(id);
      if (this.#has(id)) {
        this.#db
          .prepare("UPDATE hab_event_subscriptions SET secret=? WHERE id=?")
          .run(secret, id);
        continue;
      }
      let cursor: Arrival | null = null;
      for (;;) {
        const page = this.#source.arrivals(doorbell.agent_id, cursor, 50);
        if (!page.length) break;
        cursor = page[page.length - 1];
      }
      this.#db
        .prepare(
          `INSERT INTO hab_event_subscriptions (id,agent_id,url,secret,expires_at,cursor,created_at)
           VALUES (?,?,?,?,?,?,?)`,
        )
        .run(
          id,
          doorbell.agent_id,
          url,
          secret,
          NEVER,
          cursor ? JSON.stringify(cursor) : null,
          now,
        );
    }
    const existing = this.#db
      .prepare(
        `SELECT id FROM hab_event_subscriptions WHERE id LIKE '${STATIC_PREFIX}%'`,
      )
      .all() as { id: string }[];
    for (const { id } of existing)
      if (!keep.has(id)) {
        this.#db
          .prepare("DELETE FROM hab_event_subscriptions WHERE id=?")
          .run(id);
        this.#db
          .prepare("DELETE FROM hab_event_checks WHERE subscription_id=?")
          .run(id);
      }
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
   * message is announced once per subscription. 410 ends the subscription. While the last
   * accepted doorbell is quiet (ADR-030) newer mail waits behind the cursor without a ring.
   * Rings again go first, so a ring again starts a new quiet time instead of sounding
   * together with newer mail. Inbox checks (ADR-031) go last and only fill the silence: any
   * accepted ring restarts their interval.
   */
  async dispatch() {
    this.#settle();
    if (this.#rering) await this.#ringAgain();
    const now = this.#now();
    const rows = this.#db
      .prepare(
        "SELECT * FROM hab_event_subscriptions WHERE next_at<=? ORDER BY id",
      )
      .all(now) as unknown as Row[];
    for (const row of rows) await this.#dispatchOne(row);
    await this.#checkInboxes();
  }
  /** The inbox check interval for a recipient (ADR-031); 0 is off. */
  inboxCheckMs(agentId: string): number {
    return this.#checkByAgent.get(agentId) ?? this.#checkMs;
  }
  /**
   * The inbox check (ADR-031): polling for agents that only a doorbell can start. While the
   * recipient has unread mail, each live doorbell rings for the oldest unread message once
   * the interval has passed since its last accepted ring, its last check or its creation.
   * The ring is the same content-free doorbell; the agent reads with its own hab_inbox. A
   * check is not retried (the next interval is the retry), and the same oldest message is
   * checked at most `inbox_check_max_rings` times per doorbell, so an agent whose task never
   * runs is not woken all week. Mail that waited before the doorbell existed is checked too:
   * that is what polling would find. At most ten checks per pass.
   */
  async #checkInboxes() {
    const rows = this.#db
      .prepare(
        "SELECT * FROM hab_event_subscriptions WHERE expires_at>? ORDER BY id",
      )
      .all(this.#now()) as unknown as Row[];
    let rung = 0;
    for (const listed of rows) {
      if (rung >= 10) return;
      // Re-read before every check: an unsubscribe, expiry or refreshed secret during an
      // earlier check's POST must take effect before this one.
      const row = this.#db
        .prepare(
          "SELECT * FROM hab_event_subscriptions WHERE id=? AND expires_at>?",
        )
        .get(listed.id, this.#now()) as unknown as Row | undefined;
      if (!row) continue;
      const interval = this.inboxCheckMs(row.agent_id);
      if (!interval) continue;
      const check = this.#db
        .prepare(
          "SELECT sender_id,message_id,rings,checked_at FROM hab_event_checks WHERE subscription_id=?",
        )
        .get(row.id) as
        | {
            sender_id: string;
            message_id: string;
            rings: number;
            checked_at: number;
          }
        | undefined;
      const [oldest] = this.#source.arrivals(row.agent_id, null, 1);
      if (!oldest) {
        // Everything was read: the next unread mail starts a fresh count.
        if (check)
          this.#db
            .prepare("DELETE FROM hab_event_checks WHERE subscription_id=?")
            .run(row.id);
        continue;
      }
      const quiet = this.#db
        .prepare("SELECT rang_at FROM hab_event_quiet WHERE subscription_id=?")
        .get(row.id) as { rang_at: number } | undefined;
      const now = this.#now();
      const last = Math.max(
        row.created_at,
        quiet?.rang_at ?? 0,
        check?.checked_at ?? 0,
      );
      if (now - last < interval) continue;
      const same =
        check?.sender_id === oldest.sender_id &&
        check?.message_id === oldest.message_id;
      const rings = same ? check!.rings : 0;
      if (rings >= this.#checkMaxRings) continue;
      const address = this.#source.addressOf(row.agent_id);
      if (!address) continue;
      // Recorded before the POST, so a slow or failed check waits a whole interval.
      this.#db
        .prepare(
          `INSERT INTO hab_event_checks (subscription_id,sender_id,message_id,rings,checked_at)
           VALUES (?,?,?,?,?) ON CONFLICT(subscription_id) DO UPDATE SET
             sender_id=excluded.sender_id, message_id=excluded.message_id,
             rings=excluded.rings, checked_at=excluded.checked_at`,
        )
        .run(row.id, oldest.sender_id, oldest.message_id, rings + 1, now);
      rung += 1;
      if (
        (await this.#ring(row, address, oldest, `check-${rings + 1}`)) === 410
      )
        this.#end(row.id, row.agent_id, "gone");
    }
  }
  /**
   * Whether the subscription's last accepted doorbell still covers newer mail (ADR-030): it
   * is younger than `unanswered_after_ms` and its message is still unread. Then the
   * subscriber has been told that mail waits and has not read yet, and one more ring would
   * only repeat it. Reading ends the quiet, and so does time, after the ring again.
   */
  #isQuiet(row: Row): boolean {
    if (!this.#quiet || !this.#source.unread) return false;
    // A ring again that is already due (one pass rings at most ten) goes first: ringing new
    // mail now would put two accepted doorbells one poll apart.
    // Only while rings again run: rows left from before `rering: false` must not hold forever.
    if (
      this.#rering &&
      this.#db
        .prepare(
          "SELECT 1 FROM hab_event_rerings WHERE subscription_id=? AND due_at<=? LIMIT 1",
        )
        .get(row.id, this.#now())
    )
      return true;
    const last = this.#db
      .prepare(
        "SELECT sender_id,message_id,rang_at FROM hab_event_quiet WHERE subscription_id=?",
      )
      .get(row.id) as
      { sender_id: string; message_id: string; rang_at: number } | undefined;
    if (!last || this.#now() - last.rang_at >= this.#unansweredAfter)
      return false;
    return this.#source.unread(row.agent_id, {
      sender_id: last.sender_id,
      message_id: last.message_id,
    });
  }
  async #dispatchOne(row: Row) {
    const address = this.#source.addressOf(row.agent_id);
    if (!address) {
      this.#db
        .prepare("DELETE FROM hab_event_subscriptions WHERE id=?")
        .run(row.id);
      this.#db
        .prepare("DELETE FROM hab_event_quiet WHERE subscription_id=?")
        .run(row.id);
      this.#db
        .prepare("DELETE FROM hab_event_checks WHERE subscription_id=?")
        .run(row.id);
      return;
    }
    let cursor = row.cursor ? (JSON.parse(row.cursor) as Arrival) : null;
    let failures = row.failures;
    for (let sent = 0; sent < 10; sent++) {
      // Re-read before every POST: an unsubscribe, expiry or refreshed secret during an
      // earlier await must take effect before the next delivery.
      const current = this.#db
        .prepare(
          "SELECT * FROM hab_event_subscriptions WHERE id=? AND expires_at>?",
        )
        .get(row.id, this.#now()) as unknown as Row | undefined;
      if (!current) return;
      row = current;
      const [arrival] = this.#source.arrivals(row.agent_id, cursor, 1);
      if (!arrival) break;
      const key = JSON.stringify([arrival.sender_id, arrival.message_id]);
      if (row.failing !== key) failures = 0;
      // Held, not skipped: the cursor stays, so the mail is rung after the quiet if it is
      // still unread then, and never if it was read.
      if (row.failing !== key && this.#isQuiet(row)) return;
      const status = await this.#ring(row, address, arrival, null);
      if (status === 410) {
        this.#end(row.id, row.agent_id, "gone");
        return;
      }
      const delivered = status >= 200 && status <= 299;
      if (delivered && this.#rering && this.#source.unread)
        this.#db
          .prepare(
            `INSERT OR IGNORE INTO hab_event_rerings
               (subscription_id,sender_id,message_id,accepted_at,due_at) VALUES (?,?,?,?,?)`,
          )
          .run(
            row.id,
            arrival.sender_id,
            arrival.message_id,
            arrival.accepted_at,
            this.#now() + this.#unansweredAfter,
          );
      if (delivered || status === 413 || failures + 1 >= MAX_ATTEMPTS) {
        cursor = arrival;
        failures = 0;
        this.#save(row.id, cursor, 0, null, 0);
        continue;
      }
      failures += 1;
      this.#save(
        row.id,
        cursor,
        failures,
        key,
        this.#now() + Math.min(300_000, 2000 * 2 ** failures),
      );
      return;
    }
  }
  /**
   * POST one doorbell and remember how it was answered (0: no answer). A ring again or an
   * inbox check for the same message has its own eventId (`variant`), so a subscriber that
   * deduplicates still sees it.
   */
  async #ring(
    row: Row,
    address: string,
    arrival: Arrival,
    variant: "again" | `check-${number}` | null,
  ) {
    const eventId =
      "evt_" +
      createHash("sha256")
        .update(
          JSON.stringify([
            row.id,
            arrival.sender_id,
            arrival.message_id,
            ...(variant ? [variant] : []),
          ]),
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
    const at = this.#rang(row.agent_id, status);
    // The first doorbell a subscriber accepted for each message: a later ring (again, or
    // for newer mail) must not hide that this one went unanswered.
    if (status >= 200 && status <= 299)
      this.#db
        .prepare(
          `INSERT OR IGNORE INTO hab_event_accepted (agent_id,sender_id,message_id,accepted_at)
           VALUES (?,?,?,?)`,
        )
        .run(row.agent_id, arrival.sender_id, arrival.message_id, at);
    if (status >= 200 && status <= 299)
      this.#db
        .prepare(
          `INSERT INTO hab_event_quiet (subscription_id,sender_id,message_id,rang_at)
           VALUES (?,?,?,?) ON CONFLICT(subscription_id) DO UPDATE SET
             sender_id=excluded.sender_id, message_id=excluded.message_id, rang_at=excluded.rang_at`,
        )
        .run(row.id, arrival.sender_id, arrival.message_id, at);
    return status;
  }
  /**
   * Ring once more for each message still unread `unanswered_after_ms` after its doorbell was
   * accepted (ADR-027). One extra ring per message and subscription, never retried: it is a
   * nudge for a subscriber that accepted the event and did not act, not a delivery guarantee.
   */
  async #ringAgain() {
    const due = this.#db
      .prepare(
        "SELECT * FROM hab_event_rerings WHERE due_at<=? ORDER BY due_at LIMIT 10",
      )
      .all(this.#now()) as unknown as {
      subscription_id: string;
      sender_id: string;
      message_id: string;
      accepted_at: number;
    }[];
    for (const due_row of due) {
      this.#db
        .prepare(
          "DELETE FROM hab_event_rerings WHERE subscription_id=? AND sender_id=? AND message_id=?",
        )
        .run(due_row.subscription_id, due_row.sender_id, due_row.message_id);
      const row = this.#db
        .prepare(
          "SELECT * FROM hab_event_subscriptions WHERE id=? AND expires_at>?",
        )
        .get(due_row.subscription_id, this.#now()) as unknown as
        Row | undefined;
      if (!row) continue;
      const address = this.#source.addressOf(row.agent_id);
      if (
        !address ||
        !this.#source.unread?.(row.agent_id, {
          sender_id: due_row.sender_id,
          message_id: due_row.message_id,
        })
      )
        continue;
      if ((await this.#ring(row, address, due_row, "again")) === 410)
        this.#end(row.id, row.agent_id, "gone");
    }
  }
  /**
   * The verified caller's unread mail and whether its doorbell went unanswered, for the
   * caller's own tool results (ADR-027). `unread` is the caller's unread mail as its own
   * inbox would return it (authorization-filtered, oldest first, at most 50), so mail the
   * caller may no longer read never keeps a reminder alive. Null when nothing waits or the
   * caller may not read an inbox. `reading` is true for hab_inbox, which is about to read.
   */
  reminder(
    context: unknown,
    unread: readonly Arrival[],
    reading: boolean,
  ): InboxReminder | null {
    let agentId: string;
    try {
      agentId = this.#source.eventRecipient(context).agent_id;
    } catch {
      return null;
    }
    if (!unread.length) return null;
    // The earliest doorbell accepted for mail that is still unread.
    const first = this.#db.prepare(
      "SELECT accepted_at FROM hab_event_accepted WHERE agent_id=? AND sender_id=? AND message_id=?",
    );
    let delivered: number | null = null;
    for (const key of unread) {
      const row = first.get(agentId, key.sender_id, key.message_id) as
        { accepted_at: number } | undefined;
      if (row && (delivered === null || row.accepted_at < delivered))
        delivered = row.accepted_at;
    }
    const oldest = unread[0].accepted_at;
    const unanswered =
      delivered !== null && this.#now() - delivered >= this.#unansweredAfter;
    if (reading && !unanswered) return null;
    const rang = delivered === null ? "" : new Date(delivered).toISOString();
    return {
      unread: unread.length,
      more: unread.length >= 50,
      oldest_unread_at: new Date(oldest).toISOString(),
      doorbell_delivered_at: delivered === null ? null : rang,
      doorbell_unanswered: unanswered,
      explanation: unanswered
        ? `HAB rang your doorbell (${HAB_EVENT_NAME}) at ${rang} and it was accepted, but the mail is still unread, so the task that should react to the event may not be running. ${reading ? "Show each notice to your user" : "Call hab_inbox now, show each notice to your user"} and tell them that the doorbell rang but nothing read the inbox, so they can check that the event task is on.`
        : "Unread HAB mail is waiting. Call hab_inbox and show each notice to your user.",
    };
  }
  /**
   * Remember the recipient's latest ring and how the callback answered (0: no answer), so
   * an operator can tell a doorbell the subscriber refused from one it accepted and ignored.
   */
  #rang(agentId: string, status: number): number {
    const now = this.#now();
    this.#db
      .prepare(
        `INSERT INTO hab_event_rings (agent_id,rang_at,status,delivered_at) VALUES (?,?,?,?)
         ON CONFLICT(agent_id) DO UPDATE SET rang_at=excluded.rang_at, status=excluded.status,
           delivered_at=coalesce(excluded.delivered_at, delivered_at)`,
      )
      .run(agentId, now, status, status >= 200 && status <= 299 ? now : null);
    return now;
  }
  #save(
    id: string,
    cursor: Arrival | null,
    failures: number,
    failing: string | null,
    nextAt: number,
  ) {
    this.#db
      .prepare(
        "UPDATE hab_event_subscriptions SET cursor=?, failures=?, failing=?, next_at=? WHERE id=?",
      )
      .run(
        cursor ? JSON.stringify(cursor) : null,
        failures,
        failing,
        nextAt,
        id,
      );
  }
  start() {
    if (this.#timer) return;
    this.#timer = setInterval(() => {
      // Every tick counts as alive, also while a slow pass runs, so only a stopped
      // process or a sleeping machine looks like an outage.
      try {
        this.#settle();
      } catch {
        // The next tick tries again.
      }
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

export interface DoorbellState {
  /** Live subscriptions and the latest lifetime among them. */
  live: number;
  /** How many of the live ones the operator registered (ADR-029); they never expire. */
  operator: number;
  until: number | null;
  /** When the last subscription ended without a renewal, and why. */
  lapsed_at: number | null;
  reason: "expired" | "gone" | "unsubscribed" | null;
  /** The latest ring, the HTTP status the callback answered (0: no answer) and the last 2xx. */
  rang_at: number | null;
  status: number | null;
  delivered_at: number | null;
}
/**
 * Read-only view of every recipient's doorbell for operators (`hab-admin status`). No
 * callback URLs or secrets. Subscriptions past their lifetime count as lapsed even before
 * the dispatcher removes them, since a stopped host cannot ring them either.
 */
export function readDoorbells(
  store: string,
  now = Date.now(),
): Map<string, DoorbellState> {
  const result = new Map<string, DoorbellState>();
  const db = new DatabaseSync(store, { readOnly: true, timeout: 5000 });
  try {
    const tables = new Set(
      (
        db
          .prepare("SELECT name FROM sqlite_master WHERE type='table'")
          .all() as { name: string }[]
      ).map((row) => row.name),
    );
    const entry = (agentId: string) => {
      let state = result.get(agentId);
      if (!state) {
        state = {
          live: 0,
          operator: 0,
          until: null,
          lapsed_at: null,
          reason: null,
          rang_at: null,
          status: null,
          delivered_at: null,
        };
        result.set(agentId, state);
      }
      return state;
    };
    if (tables.has("hab_event_lapses"))
      for (const row of db
        .prepare("SELECT agent_id,lapsed_at,reason FROM hab_event_lapses")
        .all() as unknown as {
        agent_id: string;
        lapsed_at: number;
        reason: DoorbellState["reason"];
      }[]) {
        const state = entry(row.agent_id);
        state.lapsed_at = row.lapsed_at;
        state.reason = row.reason;
      }
    if (tables.has("hab_event_rings"))
      for (const row of db
        .prepare(
          "SELECT agent_id,rang_at,status,delivered_at FROM hab_event_rings",
        )
        .all() as unknown as {
        agent_id: string;
        rang_at: number;
        status: number;
        delivered_at: number | null;
      }[]) {
        const state = entry(row.agent_id);
        state.rang_at = row.rang_at;
        state.status = row.status;
        state.delivered_at = row.delivered_at;
      }
    if (tables.has("hab_event_subscriptions"))
      for (const row of db
        .prepare(
          "SELECT id,agent_id,expires_at FROM hab_event_subscriptions ORDER BY expires_at",
        )
        .all() as unknown as {
        id: string;
        agent_id: string;
        expires_at: number;
      }[]) {
        const state = entry(row.agent_id);
        // Operator-registered doorbells (ADR-029) never expire; they have no lifetime to show.
        if (row.id.startsWith(STATIC_PREFIX)) {
          state.live += 1;
          state.operator += 1;
        } else if (row.expires_at > now) {
          state.live += 1;
          state.until = row.expires_at;
        } else if ((state.lapsed_at ?? 0) < row.expires_at) {
          state.lapsed_at = row.expires_at;
          state.reason = "expired";
        }
      }
  } finally {
    db.close();
  }
  return result;
}
