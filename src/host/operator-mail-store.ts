import { createHmac, randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  realpathSync,
} from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  makeReplayBoundMessageId,
  MAX_DELIVERY_TTL_MS,
  RECORD_RETENTION_MS,
  replayBoundSentAt,
} from "../messaging/contract.ts";
import type { Receipt } from "../messaging/delivery-service.ts";
import { HostAdminError } from "./admin.ts";

export type OperatorMailInput =
  | { action: "send"; to: string; text: string }
  | { action: "reply"; message_id: string; text: string }
  | { action: "ping"; to: string };

export type PreparedOperatorMailInput =
  | Exclude<OperatorMailInput, { action: "ping" }>
  | { action: "ping"; to: string; text: string };

export interface OperatorMailView {
  operation_id: string;
  action: OperatorMailInput["action"];
  message_id: string;
  to: string | null;
  state: Receipt["state"] | "unknown";
  accepted_at: string | null;
  expires_at: string;
  acked_at: string | null;
  read_at: string | null;
  doorbell_at: string | null;
  reply_at: string | null;
  problem: string | null;
}

export type OperatorMailObservation = Pick<
  OperatorMailView,
  | "to"
  | "state"
  | "accepted_at"
  | "acked_at"
  | "read_at"
  | "doorbell_at"
  | "reply_at"
>;

export interface OperatorMailRecord {
  input: PreparedOperatorMailInput | null;
  recipient_id: string | null;
  view: OperatorMailView;
}

type Row = {
  input: string | null;
  fingerprint: string;
  recipient_id: string | null;
  expires: number;
  view: string;
};

const schema = `
  CREATE TABLE operator_mail (
    owner TEXT NOT NULL, role TEXT NOT NULL, id TEXT NOT NULL,
    input TEXT, fingerprint TEXT NOT NULL, recipient_id TEXT,
    created INTEGER NOT NULL, expires INTEGER NOT NULL, view TEXT NOT NULL,
    PRIMARY KEY(owner, role, id)
  ) STRICT;
  CREATE INDEX operator_mail_recent ON operator_mail(owner, role, created DESC);
  CREATE INDEX operator_mail_expiry ON operator_mail(expires);
  PRAGMA user_version = 1;
`;
const limit = 4096;
const finalStates = new Set(["acked", "expired", "quarantined"]);

function record(row: Row, now = Date.now()): OperatorMailRecord {
  return {
    input:
      row.input !== null && row.expires > now
        ? (JSON.parse(row.input) as PreparedOperatorMailInput)
        : null,
    recipient_id: row.recipient_id,
    view: JSON.parse(row.view) as OperatorMailView,
  };
}

export class OperatorMailStore {
  readonly #path: string;
  readonly #owner: string;
  readonly #role: "mailbox" | "ping";
  readonly #fingerprintKey: Uint8Array;
  constructor(
    directory: string,
    owner: string,
    role: "mailbox" | "ping",
    fingerprintKey: Uint8Array,
  ) {
    const dir = lstatSync(directory);
    if (
      !dir.isDirectory() ||
      dir.uid !== process.getuid?.() ||
      (dir.mode & 0o077) !== 0 ||
      realpathSync(directory) !== directory
    )
      throw new HostAdminError("operator_mail_store_unavailable");
    this.#path = join(directory, "operator-mail.sqlite");
    this.#owner = owner;
    this.#role = role;
    this.#fingerprintKey = Uint8Array.from(fingerprintKey);
  }

  #open(write: boolean): DatabaseSync {
    const flags = write
      ? constants.O_RDWR | constants.O_CREAT
      : constants.O_RDONLY;
    const fd = openSync(this.#path, flags | constants.O_NOFOLLOW, 0o600);
    try {
      const info = fstatSync(fd);
      if (
        !info.isFile() ||
        info.uid !== process.getuid?.() ||
        info.nlink !== 1 ||
        (info.mode & 0o077) !== 0
      )
        throw new HostAdminError("operator_mail_store_unavailable");
    } finally {
      closeSync(fd);
    }
    return new DatabaseSync(this.#path, { readOnly: !write, timeout: 1000 });
  }

  #read<T>(action: (db: DatabaseSync) => T): T | undefined {
    let db: DatabaseSync;
    try {
      db = this.#open(false);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
    try {
      const version = db.prepare("PRAGMA user_version").get()?.user_version;
      if (version === 0) return undefined;
      if (version !== 1)
        throw new HostAdminError("operator_mail_store_unavailable");
      return action(db);
    } finally {
      db.close();
    }
  }

  #write<T>(action: (db: DatabaseSync) => T): T {
    const db = this.#open(true);
    try {
      db.exec("BEGIN IMMEDIATE");
      const version = db.prepare("PRAGMA user_version").get()?.user_version;
      if (version === 0) db.exec(schema);
      else if (version !== 1)
        throw new HostAdminError("operator_mail_store_unavailable");
      const result = action(db);
      db.exec("COMMIT");
      return result;
    } finally {
      db.close();
    }
  }

  #row(db: DatabaseSync, id: string): Row | undefined {
    return db
      .prepare(
        "SELECT input, fingerprint, recipient_id, expires, view FROM operator_mail WHERE owner=? AND role=? AND id=?",
      )
      .get(this.#owner, this.#role, id) as Row | undefined;
  }

  #fingerprint(input: OperatorMailInput) {
    const fields =
      input.action === "reply"
        ? [input.action, input.message_id, input.text]
        : [input.action, input.to, input.action === "send" ? input.text : null];
    return createHmac("sha256", this.#fingerprintKey)
      .update("operator-mail-v1\0")
      .update(JSON.stringify(fields))
      .digest("hex");
  }

  #match(row: Row, fingerprint: string) {
    if (row.fingerprint !== fingerprint)
      throw new HostAdminError("operation_conflict");
    return record(row);
  }

  list(): OperatorMailView[] {
    const values = this.#read((db) =>
      db
        .prepare(
          "SELECT view FROM operator_mail WHERE owner=? AND role=? ORDER BY created DESC, id DESC LIMIT 50",
        )
        .all(this.#owner, this.#role),
    );
    return (values ?? []).map(
      ({ view }) => JSON.parse(String(view)) as OperatorMailView,
    );
  }

  get(id: string): OperatorMailRecord | undefined {
    const row = this.#read((db) => this.#row(db, id));
    return row ? record(row) : undefined;
  }

  match(id: string, input: OperatorMailInput): OperatorMailRecord | undefined {
    const row = this.#read((db) => this.#row(db, id));
    return row ? this.#match(row, this.#fingerprint(input)) : undefined;
  }

  prepare(
    id: string,
    input: OperatorMailInput,
    recipientId: string | null,
    pingText?: string,
  ): OperatorMailRecord {
    const fingerprint = this.#fingerprint(input);
    return this.#write((db) => {
      const existing = this.#row(db, id);
      if (existing) return this.#match(existing, fingerprint);

      const created = replayBoundSentAt(id);
      const now = Date.now();
      if (created === undefined || created > now + 60_000)
        throw new HostAdminError("invalid_request");
      const expires = created + MAX_DELIVERY_TTL_MS;
      if (expires <= now) throw new HostAdminError("operation_expired");
      db.prepare("DELETE FROM operator_mail WHERE expires<=?").run(
        now - RECORD_RETENTION_MS,
      );
      db.prepare(
        "UPDATE operator_mail SET input=NULL WHERE input IS NOT NULL AND expires<=?",
      ).run(now);
      const count = db
        .prepare(
          "SELECT count(*) AS records FROM operator_mail WHERE owner=? AND role=?",
        )
        .get(this.#owner, this.#role)?.records;
      if (typeof count !== "number" || count >= limit)
        throw new HostAdminError("operator_mail_full");

      let prepared: PreparedOperatorMailInput;
      if (input.action === "ping") {
        if (pingText === undefined) throw new HostAdminError("invalid_request");
        prepared = { ...input, text: pingText };
      } else prepared = input;

      const view: OperatorMailView = {
        operation_id: id,
        message_id: makeReplayBoundMessageId(
          new Date(created).toISOString(),
          randomBytes(16).toString("hex"),
        ),
        action: input.action,
        to: input.action === "reply" ? null : input.to,
        state: "unknown",
        accepted_at: null,
        expires_at: new Date(expires).toISOString(),
        acked_at: null,
        read_at: null,
        doorbell_at: null,
        reply_at: null,
        problem: null,
      };
      db.prepare(
        "INSERT INTO operator_mail(owner, role, id, input, fingerprint, recipient_id, created, expires, view) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ).run(
        this.#owner,
        this.#role,
        id,
        JSON.stringify(prepared),
        fingerprint,
        recipientId,
        created,
        expires,
        JSON.stringify(view),
      );
      return { input: prepared, recipient_id: recipientId, view };
    });
  }

  #update(id: string, apply: (view: OperatorMailView) => OperatorMailView) {
    return this.#write((db) => {
      const row = this.#row(db, id);
      if (!row) throw new HostAdminError("operation_not_found");
      const current = record(row);
      const view = apply(current.view);
      const input = view.accepted_at ? null : current.input;
      db.prepare(
        "UPDATE operator_mail SET view=?, input=? WHERE owner=? AND role=? AND id=?",
      ).run(
        JSON.stringify(view),
        input === null ? null : row.input,
        this.#owner,
        this.#role,
        id,
      );
      return { ...current, input, view };
    });
  }

  observe(
    id: string,
    observation: OperatorMailObservation,
  ): OperatorMailRecord {
    return this.#update(id, (current) => ({
      ...current,
      to: observation.to ?? current.to,
      state: finalStates.has(current.state) ? current.state : observation.state,
      accepted_at: current.accepted_at ?? observation.accepted_at,
      acked_at: current.acked_at ?? observation.acked_at,
      read_at: current.read_at ?? observation.read_at,
      doorbell_at: current.doorbell_at ?? observation.doorbell_at,
      reply_at: current.reply_at ?? observation.reply_at,
      problem: null,
    }));
  }

  problem(id: string, problem: string): OperatorMailRecord {
    return this.#update(id, (current) => ({ ...current, problem }));
  }
}
