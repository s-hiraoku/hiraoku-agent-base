/**
 * `hab:admin pending | approve | reject`: approve a sign-in the host kept as pending,
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
  readFileSync,
  renameSync,
  statSync,
  writeSync,
} from "node:fs";
import { readHostConfig } from "./config.ts";
import { parseOAuthConfig } from "./oauth-auth.ts";
import { readPending, removePending } from "./oauth-pending.ts";
import { HostAdminError, hostAdminConnect, hostAdminStatus } from "./admin.ts";
import { parseHabAddress } from "../hab/registry.ts";
import type { AgentOperation } from "../hab/registry.ts";

const DAY_MS = 86_400_000;
const PENDING_ID = /^pend_[0-9a-f]{16}$/;

function paths(configPath: string) {
  const { config } = readHostConfig(configPath);
  if (!config.ingress) throw new HostAdminError("oauth_not_configured");
  return { directory: config.directory, ledger: config.ingress.oauth_file };
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
  const { directory } = paths(configPath);
  return {
    pending_id: pendingId,
    removed: removePending(directory, pendingId),
  };
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
  const { directory, ledger } = paths(configPath);
  const row = readPending(directory, now).find(
    (entry) => entry.pending_id === input.pending_id,
  );
  if (!row) throw new HostAdminError("pending_not_found");
  let current: Record<string, unknown> & {
    connections: Record<string, unknown>[];
  };
  try {
    current = JSON.parse(readFileSync(ledger, "utf8"));
    parseOAuthConfig(current);
  } catch {
    throw new HostAdminError("oauth_invalid");
  }
  if (current.version !== 2) throw new HostAdminError("oauth_ledger_not_v2");
  if (current.issuer !== row.issuer)
    throw new HostAdminError("pending_issuer_mismatch");
  // A pair already in the ledger (an approval that stopped half way) is reused, never
  // added twice: a duplicate pair makes parseOAuthConfig refuse the whole ledger.
  const existing = current.connections.find(
    (c) => c.subject === row.subject && c.client_id === row.client_id,
  ) as { connection_id: string; state: string } | undefined;
  if (existing?.state === "revoked")
    throw new HostAdminError("credential_revoked_use_new_connection_id");
  let connectionId = existing?.connection_id;
  let backup: string | null = null;
  if (!connectionId) {
    connectionId = `hab-${address.agent_name}-${randomUUID()}`;
    // Approval starts now, never earlier: a token issued before it still gets
    // token_before_approval.
    const approvedAt = now;
    const next = {
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
    try {
      parseOAuthConfig(next);
    } catch {
      throw new HostAdminError("oauth_invalid");
    }
    backup = `${ledger}.bak-${new Date(now).toISOString().replace(/[:.]/g, "-")}`;
    copyFileSync(ledger, backup);
    chmodSync(backup, 0o600);
    replaceAtomically(ledger, JSON.stringify(next, null, 2) + "\n");
  }
  // An address already in use keeps what it is allowed to do: a product that comes
  // back with a new client neither gains nor loses operations.
  const known = hostAdminStatus(configPath, now).addresses.find(
    (entry) => entry.address === address.address,
  );
  const operations =
    known?.state === "active" && known.operations.length
      ? (known.operations as AgentOperation[])
      : undefined;
  const connected = hostAdminConnect(configPath, {
    address: address.address,
    connection_id: connectionId,
    ...(operations ? { operations } : {}),
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
      "承認より前に発行された token は token_before_approval で断られる。製品が token を更新するまで（最長 10 分）待つか、製品の画面でコネクタをつなぎ直す。",
  };
}
