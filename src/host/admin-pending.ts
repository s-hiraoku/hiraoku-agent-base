/**
 * `hab:admin pending | approve | reject | revoke`: approve a sign-in the host kept as pending,
 * so the operator never looks up a subject in Auth0's logs or edits the ledger by hand.
 * Approval writes one participation row to the OAuth ledger (backup first, then an
 * atomic replace) and binds it with the same steps as `connect`. The host re-reads the
 * ledger on every request, so no restart is needed.
 */
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  copyFileSync,
  fsyncSync,
  openSync,
  renameSync,
  statSync,
  writeSync,
} from "node:fs";
import { readHostConfig } from "./config.ts";
import { isOAuthConnectionId, parseOAuthConfig } from "./oauth-auth.ts";
import { RUNTIME_CONFIG_MAX_BYTES } from "../runtime-config.ts";
import { readPending, removePending } from "./oauth-pending.ts";
import {
  HostAdminError,
  hostAdminConnect,
  hostAdminRevokeBinding,
  withLedgerLock,
} from "./admin.ts";
import { parseHabAddress } from "../hab/registry.ts";

const DAY_MS = 86_400_000;

const PENDING_ID = /^pend_[0-9a-f]{16}$/;

function paths(configPath: string) {
  const { config, readOAuth } = readHostConfig(configPath);
  if (!config.ingress) throw new HostAdminError("oauth_not_configured");
  return {
    directory: config.directory,
    ledger: config.ingress.oauth_file,
    resource: config.ingress.resource_url,
    readOAuth,
  };
}
/** Enough of a subject to match it with Auth0's screen, not the whole value. */
export function maskSubject(subject: string) {
  return subject.length > 12
    ? `${subject.slice(0, 6)}…${subject.slice(-4)}`
    : `${subject.slice(0, 2)}…`;
}

export function hostAdminPending(configPath: string, now = Date.now()) {
  const { directory } = paths(configPath);
  return {
    pending: readPending(directory, now).map((row) => ({
      pending_id: row.pending_id,
      subject: maskSubject(row.subject),
      client_id: row.client_id,
      issuer: row.issuer,
      first_seen_at: new Date(row.first_seen_at).toISOString(),
      last_seen_at: new Date(row.last_seen_at).toISOString(),
      attempts: row.attempts,
    })),
  };
}

export function hostAdminReject(configPath: string, pendingId: string) {
  if (!PENDING_ID.test(pendingId))
    throw new HostAdminError("invalid_pending_id");
  const { directory, ledger } = paths(configPath);
  return withLedgerLock(ledger, () => ({
    pending_id: pendingId,
    removed: removePending(directory, pendingId),
  }));
}

/** Write `text` beside `file` and swap it in, so a crash leaves the old or the new file. */
function replaceAtomically(file: string, text: string) {
  const mode = statSync(file).mode & 0o777;
  const temp = `${file}.tmp-${process.pid}-${randomUUID()}`;
  const fd = openSync(temp, "wx", mode);
  try {
    writeSync(fd, text);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  chmodSync(temp, mode);
  renameSync(temp, file);
}

type Ledger = Extract<ReturnType<typeof parseOAuthConfig>, { version: 2 }>;

/** Read the host's own private v2 ledger under its write lock. */
function readLedger({ readOAuth, resource }: ReturnType<typeof paths>): Ledger {
  let current: ReturnType<typeof parseOAuthConfig>;
  try {
    current = parseOAuthConfig(readOAuth());
  } catch {
    throw new HostAdminError("oauth_invalid");
  }
  if (current.resource !== resource)
    throw new HostAdminError("oauth_resource_mismatch");
  if (current.version !== 2) throw new HostAdminError("oauth_ledger_not_v2");
  return current;
}
/** Back up the ledger, then swap in `next`. Returns the backup path. Call under the ledger lock. */
function writeLedger(ledger: string, next: Ledger, at: number) {
  try {
    parseOAuthConfig(next);
  } catch {
    throw new HostAdminError("oauth_invalid");
  }
  const text = JSON.stringify(next, null, 2) + "\n";
  // The host refuses a ledger over the config size limit, which would stop every
  // OAuth connection, so such a ledger is never written.
  if (Buffer.byteLength(text) > RUNTIME_CONFIG_MAX_BYTES)
    throw new HostAdminError("ledger_too_large");
  const timestamp = new Date(at).toISOString().replace(/[:.]/g, "-");
  const backup = `${ledger}.bak-${timestamp}-${randomUUID()}`;
  copyFileSync(ledger, backup);
  chmodSync(backup, 0o600);
  replaceAtomically(ledger, text);
  return backup;
}

export interface ApproveInput {
  pending_id: string;
  address: string;
  days?: number;
}

export function hostAdminApprove(
  configPath: string,
  input: ApproveInput,
  now = Date.now(),
) {
  if (!PENDING_ID.test(input.pending_id))
    throw new HostAdminError("invalid_pending_id");
  const days = input.days ?? 365;
  if (!Number.isInteger(days) || days < 1 || days > 3650)
    throw new HostAdminError("invalid_days");
  let address: ReturnType<typeof parseHabAddress>;
  try {
    address = parseHabAddress(input.address);
  } catch {
    throw new HostAdminError("invalid_address");
  }
  const oauth = paths(configPath);
  const { directory, ledger } = oauth;
  return withLedgerLock(ledger, () => {
    const approvedAt = Math.max(now, Date.now());
    const row = readPending(directory, approvedAt).find(
      (entry) => entry.pending_id === input.pending_id,
    );
    if (!row) throw new HostAdminError("pending_not_found");
    const current = readLedger(oauth);
    if (current.issuer !== row.issuer)
      throw new HostAdminError("pending_issuer_mismatch");
    // A pair already in the ledger (an approval that stopped half way) is reused, never
    // added twice: a duplicate pair makes parseOAuthConfig refuse the whole ledger.
    const existing = current.connections.find(
      (c) => c.subject === row.subject && c.client_id === row.client_id,
    );
    if (existing?.state === "revoked")
      throw new HostAdminError("credential_revoked_use_new_connection_id");
    let connectionId = existing?.connection_id;
    let backup: string | null = null;
    if (!connectionId) {
      connectionId = `hab-${address.agent_name}-${randomUUID()}`;
      // Approval starts now (after any wait for the lock), never earlier: a token
      // issued before it still gets token_before_approval.
      const next: Ledger = {
        ...current,
        connections: [
          ...current.connections,
          {
            subject: row.subject,
            client_id: row.client_id,
            connection_id: connectionId,
            approved_at: new Date(approvedAt).toISOString(),
            approved_until: new Date(approvedAt + days * DAY_MS).toISOString(),
            state: "active",
          },
        ],
      };
      backup = writeLedger(ledger, next, approvedAt);
    }
    // Keep the access state and grants of addresses already in a group.
    const connected = hostAdminConnect(configPath, {
      address: address.address,
      connection_id: connectionId,
      preserve_access: true,
    });
    removePending(directory, row.pending_id);
    return {
      pending_id: row.pending_id,
      address: address.address,
      connection_id: connectionId,
      ledger: existing ? "existing" : "added",
      backup,
      connect: connected,
      next_action:
        connected.address.state === "active"
          ? "承認より前に発行された token は token_before_approval で断られる。製品が token を更新するまで（最長 10 分）待つか、製品の画面でコネクタをつなぎ直す。"
          : "接続は紐づけ済み。アドレスの利用を再開する場合は、運用者が hab:admin connect で必要な操作を指定する。",
    };
  });
}

/**
 * `hab:admin revoke --connection <id>`: stop one OAuth connection without touching the
 * group's other connections. The ledger row becomes `revoked` first, so its tokens are
 * refused at once, then its one Registry binding goes. Either step already done is
 * skipped, so a rerun after a stop half way converges.
 */
export function hostAdminRevoke(
  configPath: string,
  connectionId: string,
  now = Date.now(),
) {
  if (!isOAuthConnectionId(connectionId))
    throw new HostAdminError("invalid_connection_id");
  const oauth = paths(configPath);
  const { ledger } = oauth;
  return withLedgerLock(ledger, () => {
    const current = readLedger(oauth);
    const row = current.connections.find(
      (c) => c.connection_id === connectionId,
    );
    if (!row) throw new HostAdminError("connection_not_found");
    const wasActive = row.state === "active";
    const backup = wasActive
      ? writeLedger(
          ledger,
          {
            ...current,
            connections: current.connections.map((c) =>
              c === row ? { ...c, state: "revoked" } : c,
            ),
          },
          Math.max(now, Date.now()),
        )
      : null;
    return {
      connection_id: connectionId,
      ledger: wasActive ? ("revoked" as const) : ("already_revoked" as const),
      backup,
      // From the ledger row, not the host's credential list: that list drops OAuth
      // connections while OAuth is disabled and can hold a local one with this ID.
      registry: hostAdminRevokeBinding(configPath, {
        issuer: current.issuer,
        audience: current.resource,
        subject: row.subject,
        client_id: row.client_id,
        connection_id: connectionId,
      }),
    };
  });
}
