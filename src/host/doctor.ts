/**
 * `hab:admin doctor`: where one address stands on the way from "registered" to "its
 * product reads the mail". It only reads `hostAdminStatus`, so it changes nothing and
 * prints nothing that status does not already print.
 */
import { hostAdminStatus, HostAdminError } from "./admin.ts";
import { deliveryOperations, parseHabAddress } from "../hab/registry.ts";

type Status = ReturnType<typeof hostAdminStatus>;
type Inbox = Status["inboxes"][number];
type Evidence = Record<string, string | number | boolean | null>;

export type CheckState = "ok" | "problem" | "unknown";
export interface Check {
  state: CheckState;
  reason: Reason;
  evidence: Evidence;
  next_action: string | null;
}
export interface Diagnosis {
  address: string;
  checks: {
    registration: Check;
    receive: Check;
    reading: Check;
    session: Check;
  };
}

const SETUP = "docs/connections/agent-setup.md";
/** Approval this close to its end is reported before it stops working. */
export const APPROVAL_WARN_MS = 14 * 86_400_000;
/** Time a product gets to read its inbox after taking a ring. */
export const READ_GRACE_MS = 2 * 60_000;

/** Every reason doctor can give, with its state and what the operator does next. */
const REASONS = {
  registered: ["ok", null],
  address_inactive: [
    "problem",
    `hab:admin status で状態を確かめ、使い続けるなら hab:admin connect でつなぎ直す（${SETUP}#共通の準備をする）。`,
  ],
  address_unbound: [
    "problem",
    `hab:admin connect --address <address> --connection-id <id> で接続を紐づける（${SETUP}#共通の準備をする）。`,
  ],
  operations_missing: [
    "problem",
    "hab:admin connect を --operations なしで実行し直し、5 操作を与える。",
  ],
  approval_revoked: [
    "problem",
    "接続台帳で取り消されている。新しい connection_id で登録し直す。",
  ],
  approval_expired: [
    "problem",
    "接続台帳の approved_until を延ばすか、新しい connection_id で登録し直す。",
  ],
  approval_expiring: [
    "problem",
    "接続台帳の approved_until が 14 日以内に切れる。期限を延ばす。",
  ],
  connection_unlisted: [
    "unknown",
    "このアドレスに紐づく接続が接続台帳に見つからない。hab:admin status の credentials を確かめる。",
  ],
  receive_unset: [
    "problem",
    "hab:admin receive --agent-name <product> --mode hook|poll|on_request で受け方を決める。",
  ],
  events_off: [
    "problem",
    "host の設定で ingress.events を有効にしないと、Hook の呼び鈴は鳴らない。",
  ],
  doorbell_missing: [
    "problem",
    `製品側で見張りを頼むか（MCP Events の購読）、運用者の呼び鈴を登録する（${SETUP}#製品ごとにできること）。`,
  ],
  doorbell_lapsed: [
    "problem",
    "製品側で見張りを頼み直す。HAB は切れた購読を自分では更新しない。",
  ],
  doorbell_failing: [
    "problem",
    "呼び鈴の宛先が受け取っていない。宛先が 127.0.0.1 なら、notifier が動いていて wake の鍵が同じかを確かめる。",
  ],
  doorbell_live: ["ok", null],
  poll_overdue: [
    "problem",
    "製品の予定タスクが間隔の 2 倍以上動いていない。製品の画面でタスクを確かめる。",
  ],
  poll_never_read: [
    "unknown",
    "まだ一度も受信箱を読んでいない。製品の予定タスクが動くのを待つか、製品の画面で確かめる。",
  ],
  poll_reading: ["ok", null],
  reads_untracked: [
    "unknown",
    "host の設定で ingress.events を有効にすると、受信箱を読んだ時刻が記録され、poll の遅れが分かる。",
  ],
  on_request: ["ok", null],
  no_unread: ["ok", null],
  unread_recent: ["ok", null],
  waiting_for_request: ["ok", null],
  rang_not_read: [
    "problem",
    "呼び鈴は受け取られたのに、そのあと受信箱が読まれていない。製品の実行履歴（タスク、routine）を確かめる。",
  ],
  unread_waiting: [
    "problem",
    "30 分以上読まれていないメールがある。製品の受け方と実行履歴を確かめる。",
  ],
  recipient_absent: [
    "problem",
    "製品がこの会話はもうないと答えた。hab:admin session で会話を付け直すか、製品で購読し直す。",
  ],
  session_not_reported: ["unknown", null],
} as const satisfies Record<string, readonly [CheckState, string | null]>;
export type Reason = keyof typeof REASONS;

const check = (reason: Reason, evidence: Evidence = {}): Check => ({
  state: REASONS[reason][0],
  reason,
  evidence,
  next_action: REASONS[reason][1],
});
const before = (a: string | null | undefined, b: string | null | undefined) =>
  !!a && (!b || Date.parse(b) < Date.parse(a));

function registration(status: Status, address: string, now: number): Check {
  const entry = status.addresses.find((a) => a.address === address)!;
  const evidence: Evidence = {
    state: entry.state,
    active_bindings: entry.active_bindings,
    operations: entry.operations.length,
  };
  if (entry.state !== "active") return check("address_inactive", evidence);
  if (!entry.active_bindings) return check("address_unbound", evidence);
  if (!deliveryOperations.every((op) => entry.operations.includes(op)))
    return check("operations_missing", evidence);
  const connections = status.credentials.filter((c) =>
    c.addresses.includes(address),
  );
  if (!connections.length) return check("connection_unlisted", evidence);
  // The connection that lasts longest decides: one live connection keeps the address working.
  const best = connections
    .map((c) => {
      const p = "participation" in c ? c.participation : undefined;
      return {
        id: c.connection_id,
        revoked: p?.state === "revoked" || c.binding?.state !== "active",
        remainingMs:
          (p
            ? p.expires_in_seconds
            : (c as { expires_in_seconds: number }).expires_in_seconds) * 1000,
        until: p?.approved_until ?? null,
      };
    })
    .sort(
      (a, b) =>
        Number(a.revoked) - Number(b.revoked) || b.remainingMs - a.remainingMs,
    )[0];
  Object.assign(evidence, {
    connection_id: best.id,
    approved_until: best.until,
  });
  if (best.revoked) return check("approval_revoked", evidence);
  if (best.remainingMs <= 0) return check("approval_expired", evidence);
  if (best.until && Date.parse(best.until) - now <= APPROVAL_WARN_MS)
    return check("approval_expiring", evidence);
  return check("registered", evidence);
}

function receive(
  status: Status,
  address: string,
  inbox: Inbox | undefined,
): Check {
  const mode = status.products.find(
    (p) => p.agent_name === parseHabAddress(address).agent_name,
  )?.receive;
  const has = (code: string) =>
    status.problems.some((p) => p.code === code && p.subject === address);
  if (!mode) return check("receive_unset");
  const evidence: Evidence = { mode: mode.mode };
  if (mode.mode === "on_request") return check("on_request", evidence);
  if (mode.mode === "poll") {
    Object.assign(evidence, {
      interval_ms: mode.interval_ms,
      last_inbox_read_at: inbox?.last_inbox_read_at ?? null,
    });
    // Inbox reads are recorded in the events store, which exists only with events on.
    if (!inbox || inbox.doorbell === "off")
      return check("reads_untracked", evidence);
    if (has("poll_overdue")) return check("poll_overdue", evidence);
    if (!inbox?.last_inbox_read_at) return check("poll_never_read", evidence);
    return check("poll_reading", evidence);
  }
  Object.assign(evidence, {
    doorbell: inbox?.doorbell ?? "none",
    operator_doorbell: !!inbox?.doorbell_operator,
    last_rang_at: inbox?.doorbell_last_rang_at ?? null,
    last_status: inbox?.doorbell_last_status ?? null,
  });
  if (!inbox || inbox.doorbell === "off") return check("events_off", evidence);
  if (inbox.doorbell === "none") return check("doorbell_missing", evidence);
  if (inbox.doorbell === "lapsed") return check("doorbell_lapsed", evidence);
  if (has("doorbell_failing")) return check("doorbell_failing", evidence);
  return check("doorbell_live", evidence);
}

function reading(
  status: Status,
  address: string,
  inbox: Inbox | undefined,
  now: number,
): Check {
  const evidence: Evidence = {
    unread: inbox?.unread ?? 0,
    oldest_unread_at: inbox?.oldest_unread_at ?? null,
    last_inbox_read_at: inbox?.last_inbox_read_at ?? null,
    last_accepted_ring_at: inbox?.doorbell_last_delivered_at ?? null,
  };
  if (!inbox?.unread) return check("no_unread", evidence);
  const mode = status.products.find(
    (p) => p.agent_name === parseHabAddress(address).agent_name,
  )?.receive?.mode;
  // Mail for a product that only reads when asked is expected to wait.
  if (mode === "on_request") return check("waiting_for_request", evidence);
  // An accepted ring for this mail, no read since, and the product has had time to act.
  const rang = inbox.doorbell_last_delivered_at;
  if (
    rang &&
    inbox.oldest_unread_at &&
    Date.parse(rang) >= Date.parse(inbox.oldest_unread_at) &&
    before(rang, inbox.last_inbox_read_at) &&
    now - Date.parse(rang) > READ_GRACE_MS
  )
    return check("rang_not_read", evidence);
  if (
    status.problems.some(
      (p) => p.code === "unread_waiting" && p.subject === address,
    )
  )
    return check("unread_waiting", evidence);
  return check("unread_recent", evidence);
}

function session(status: Status, address: string, inbox: Inbox | undefined) {
  const entry = status.addresses.find((a) => a.address === address)!;
  const evidence: Evidence = {
    session: entry.session?.session ?? null,
    provisional: entry.session?.provisional ?? null,
  };
  if (inbox?.recipient_absent_since)
    return check("recipient_absent", {
      ...evidence,
      absent_since: inbox.recipient_absent_since,
    });
  // No product reports which conversation it is in yet, so the match stays unobserved.
  return check("session_not_reported", evidence);
}

export function diagnose(
  status: Status,
  address: string,
  now = Date.now(),
): Diagnosis {
  if (!status.addresses.some((a) => a.address === address))
    throw new HostAdminError("address_not_found");
  const inbox = status.inboxes.find((i) => i.address === address);
  return {
    address,
    checks: {
      registration: registration(status, address, now),
      receive: receive(status, address, inbox),
      reading: reading(status, address, inbox, now),
      session: session(status, address, inbox),
    },
  };
}

export function hostAdminDoctor(
  configPath: string,
  address?: string,
  now = Date.now(),
) {
  const status = hostAdminStatus(configPath, now);
  if (address !== undefined) {
    let parsed: string;
    try {
      parsed = parseHabAddress(address).address;
    } catch {
      throw new HostAdminError("invalid_address");
    }
    return diagnose(status, parsed, now);
  }
  return {
    addresses: status.addresses.map((entry) => {
      const { checks } = diagnose(status, entry.address, now);
      const first = Object.entries(checks).find(
        ([, c]) => c.state === "problem",
      );
      return {
        address: entry.address,
        registration: checks.registration.state,
        receive: checks.receive.state,
        reading: checks.reading.state,
        session: checks.session.state,
        first_problem: first ? `${first[0]}:${first[1].reason}` : null,
      };
    }),
  };
}
