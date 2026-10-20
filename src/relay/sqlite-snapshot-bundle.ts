/** Private grouped SQLite snapshots. Restores only to a new offline directory; never touches authority/configuration. */
import { Buffer } from "node:buffer";
import type { Stats } from "node:fs";
import { DatabaseSync, backup } from "node:sqlite";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import {
  constants,
  openSync,
  closeSync,
  fstatSync,
  statSync,
  realpathSync,
  existsSync,
  mkdirSync,
  readSync,
  writeSync,
  fsyncSync,
  unlinkSync,
  readdirSync,
} from "node:fs";
import { dirname, isAbsolute, resolve, join } from "node:path";
import { RelayError } from "./service.ts";
const profiles = {
  server: ["relay", "uploads"],
  sender: ["upload_journal", "outbox"],
  receiver: ["receive_checkpoint", "attachment_inbox", "inbox"],
} as const;
type Profile = keyof typeof profiles;
type Role = (typeof profiles)[Profile][number];
const schemas: Record<Role, { table: string; version: number; key: string }> = {
  relay: { table: "relay_schema", version: 5, key: "fingerprint_key_check" },
  uploads: { table: "attachment_schema", version: 2, key: "key_check" },
  upload_journal: {
    table: "upload_journal_meta",
    version: 1,
    key: "key_check",
  },
  outbox: { table: "relay_outbox_meta", version: 2, key: "key_check" },
  receive_checkpoint: {
    table: "receive_checkpoint_meta",
    version: 1,
    key: "key_check",
  },
  attachment_inbox: {
    table: "attachment_inbox_meta",
    version: 1,
    key: "key_check",
  },
  inbox: { table: "relay_inbox_meta", version: 3, key: "key_check" },
};
const tables: Record<Role, string[]> = {
  relay: [
    "relay_schema",
    "relay_poll_cursors",
    "relay_poll_senders",
    "relay_message_attachments",
    "relay_attachment_deletions",
    "relay_threads",
    "relay_messages",
    "relay_deliveries",
    "relay_delivery_audit",
    "relay_ack_receipts",
    "relay_maintenance_totals",
  ],
  uploads: [
    "attachment_schema",
    "attachment_uploads",
    "attachment_chunks",
    "attachment_bindings",
    "attachment_refs",
  ],
  upload_journal: [
    "upload_journal_meta",
    "upload_journal_entries",
    "upload_journal_chunks",
  ],
  outbox: [
    "relay_outbox_meta",
    "relay_outbox",
    "relay_outbox_maintenance_totals",
  ],
  receive_checkpoint: ["receive_checkpoint_meta", "receive_checkpoint"],
  attachment_inbox: [
    "attachment_inbox_meta",
    "attachment_inbox_messages",
    "attachment_inbox_files",
    "attachment_inbox_chunks",
  ],
  inbox: [
    "relay_inbox_meta",
    "relay_inbox",
    "relay_receiver_acks",
    "relay_inbox_maintenance_totals",
  ],
};
const schemaSupported = (role: Role, version: unknown) =>
  version === schemas[role].version || (role === "relay" && version === 4);
type Operation = "create" | "verify" | "restore";
export interface SnapshotAuthorization {
  authorize(
    context: unknown,
    operation: Operation,
  ): { subject_id: string } | undefined;
}
export interface SQLiteSnapshotOptions {
  profile: Profile;
  owner_id?: string;
  sources: Array<{ role: Role; path: string }>;
  snapshot_root: string;
  restore_root: string;
  integrity_key: Uint8Array;
  max_database_bytes: number;
  max_total_bytes: number;
  busy_timeout_ms: number;
  deadline_ms: number;
}
type FileRecord = {
  role: Role;
  file: string;
  size_bytes: number;
  sha256: string;
  schema_version: number;
};
type Manifest = {
  format: "hab-sqlite-snapshot-v1";
  snapshot_id: string;
  profile: Profile;
  created_at: string;
  files: FileRecord[];
  hmac: string;
};
const id = (v: unknown): v is string =>
  typeof v === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(v);
const absolute = (v: unknown): v is string =>
  typeof v === "string" &&
  isAbsolute(v) &&
  resolve(v) === v &&
  !v.includes("\0");
const privateInfo = (info: Stats) =>
  (info.mode & 0o077) === 0 &&
  (typeof process.getuid !== "function" || info.uid === process.getuid());
const same = (a: Stats, b: Stats) => a.dev === b.dev && a.ino === b.ino;
function directory(path: string) {
  const info = statSync(path);
  if (!info.isDirectory() || !privateInfo(info) || realpathSync(path) !== path)
    throw Error();
}
function file(path: string, max: number) {
  directory(dirname(path));
  if (realpathSync(path) !== path) throw Error();
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = fstatSync(fd);
    if (
      !info.isFile() ||
      !privateInfo(info) ||
      info.nlink !== 1 ||
      info.size > max
    )
      throw Error();
    return info;
  } finally {
    closeSync(fd);
  }
}
function syncDirectory(path: string) {
  const fd = openSync(
    path,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
function exclusive(path: string) {
  return openSync(
    path,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_EXCL |
      constants.O_NOFOLLOW,
    0o600,
  );
}
function writeDocument(path: string, value: unknown) {
  const fd = exclusive(path);
  try {
    const bytes = Buffer.from(JSON.stringify(value) + "\n");
    let n = 0;
    while (n < bytes.length) n += writeSync(fd, bytes, n, bytes.length - n);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
export class SQLiteSnapshotBundle {
  readonly #options: SQLiteSnapshotOptions;
  readonly #authorization?: SnapshotAuthorization;
  #running = false;
  #closed = false;
  constructor(
    options: SQLiteSnapshotOptions,
    authorization?: SnapshotAuthorization,
  ) {
    if (
      !options ||
      !Object.hasOwn(profiles, options.profile) ||
      (options.profile !== "server" &&
        (typeof options.owner_id !== "string" ||
          !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(options.owner_id))) ||
      !absolute(options.snapshot_root) ||
      !absolute(options.restore_root) ||
      options.snapshot_root === options.restore_root ||
      !(options.integrity_key instanceof Uint8Array) ||
      options.integrity_key.length < 32 ||
      options.integrity_key.length > 128
    )
      throw new RelayError("invalid_snapshot_options");
    const roles = profiles[options.profile];
    if (
      !Array.isArray(options.sources) ||
      options.sources.length !== roles.length ||
      !options.sources.every(
        (v) =>
          v &&
          typeof v === "object" &&
          absolute(v.path) &&
          roles.some((role) => role === v.role),
      ) ||
      roles.some(
        (role) =>
          options.sources.filter((v) => v.role === role && absolute(v.path))
            .length !== 1,
      ) ||
      new Set(options.sources.map((v) => v.path)).size !== roles.length
    )
      throw new RelayError("invalid_snapshot_options");
    for (const k of [
      "max_database_bytes",
      "max_total_bytes",
      "busy_timeout_ms",
      "deadline_ms",
    ] as const)
      if (!Number.isSafeInteger(options[k]) || options[k] < 1)
        throw new RelayError("invalid_snapshot_options");
    if (
      options.max_database_bytes > 1073741824 ||
      options.max_total_bytes > 2147483648 ||
      options.max_total_bytes < options.max_database_bytes ||
      options.busy_timeout_ms > 1000 ||
      options.deadline_ms > 30000
    )
      throw new RelayError("invalid_snapshot_options");
    this.#options = {
      ...options,
      integrity_key: Uint8Array.from(options.integrity_key),
      sources: roles.map((role) => ({
        ...options.sources.find((v) => v.role === role)!,
      })),
    };
    this.#authorization = authorization;
  }
  #hmac(value: object) {
    return createHmac("sha256", this.#options.integrity_key)
      .update("hab-sqlite-snapshot-v1\0")
      .update(JSON.stringify(value))
      .digest("hex");
  }
  #schema(db: DatabaseSync, role: Role) {
    db.exec("PRAGMA trusted_schema=OFF");
    const actual = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name LIMIT 32",
      )
      .all()
      .map((r) => String(r.name));
    const spec = schemas[role],
      rows = db.prepare("SELECT * FROM " + spec.table + " LIMIT 2").all();
    if (
      rows.length !== 1 ||
      !schemaSupported(role, rows[0].version) ||
      typeof rows[0][spec.key] !== "string" ||
      !/^[a-f0-9]{64}$/.test(String(rows[0][spec.key])) ||
      (this.#options.profile !== "server" &&
        rows[0].agent_id !== this.#options.owner_id)
    )
      throw new RelayError("snapshot_schema_mismatch");
    const expected =
      role === "relay" && rows[0].version === 4
        ? tables[role].filter(
            (name) =>
              !["relay_poll_cursors", "relay_poll_senders"].includes(name),
          )
        : tables[role];
    if (actual.join(",") !== [...expected].sort().join(","))
      throw new RelayError("snapshot_schema_mismatch");
    if (
      db.prepare("PRAGMA integrity_check(1)").get()?.integrity_check !== "ok" ||
      db.prepare("SELECT 1 FROM pragma_foreign_key_check LIMIT 1").get()
    )
      throw new RelayError("snapshot_integrity_failed");
    const size =
      Number(db.prepare("PRAGMA page_count").get()!.page_count) *
      Number(db.prepare("PRAGMA page_size").get()!.page_size);
    if (
      !Number.isSafeInteger(size) ||
      size < 1 ||
      size > this.#options.max_database_bytes
    )
      throw new RelayError("snapshot_capacity");
    return Number(rows[0].version);
  }
  #read(
    path: string,
    max: number,
    check: () => void,
    target?: string,
  ): { size_bytes: number; sha256: string; bytes?: Buffer } {
    const before = file(path, max),
      input = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    let output: number | undefined;
    try {
      if (!same(before, fstatSync(input))) throw Error();
      if (target) output = exclusive(target);
      const hash = createHash("sha256"),
        buffer = Buffer.alloc(Math.min(65536, max + 1)),
        parts: Buffer[] = [];
      let total = 0;
      for (;;) {
        check();
        const n = readSync(input, buffer, 0, buffer.length, null);
        if (!n) break;
        total += n;
        if (total > max) throw new RelayError("snapshot_capacity");
        const chunk = buffer.subarray(0, n);
        hash.update(chunk);
        if (output !== undefined) {
          let at = 0;
          while (at < n) at += writeSync(output, chunk, at, n - at);
        } else if (max <= 16384) parts.push(Buffer.from(chunk));
      }
      if (!same(before, file(path, max)) || fstatSync(input).size !== total)
        throw Error();
      if (output !== undefined) fsyncSync(output);
      return {
        size_bytes: total,
        sha256: hash.digest("hex"),
        ...(max <= 16384 && output === undefined
          ? { bytes: Buffer.concat(parts) }
          : {}),
      };
    } finally {
      closeSync(input);
      if (output !== undefined) closeSync(output);
    }
  }
  async #run<T>(
    context: unknown,
    operation: Operation,
    action: (check: () => void) => Promise<T>,
  ): Promise<T> {
    if (this.#closed || this.#running) throw new RelayError("snapshot_busy");
    this.#running = true;
    let live = true,
      subject: string | undefined;
    const until = Date.now() + this.#options.deadline_ms;
    const check = () => {
      if (!live || Date.now() >= until)
        throw new RelayError("snapshot_deadline");
      try {
        const decision = this.#authorization?.authorize(context, operation);
        if (decision && typeof decision === "object" && "then" in decision) {
          void Promise.resolve(decision).catch(() => {});
          throw Error();
        }
        if (
          !decision ||
          !id(decision.subject_id) ||
          (subject !== undefined && subject !== decision.subject_id)
        )
          throw Error();
        subject = decision.subject_id;
      } catch {
        throw new RelayError("forbidden");
      }
      if (Date.now() >= until) throw new RelayError("snapshot_deadline");
    };
    try {
      check();
      return await action(check);
    } catch (error) {
      if (error instanceof RelayError) throw error;
      throw new RelayError("snapshot_unavailable");
    } finally {
      live = false;
      this.#running = false;
    }
  }
  async create(context: unknown, snapshotId: string) {
    return this.#run(context, "create", async (check) => {
      if (!id(snapshotId)) throw new RelayError("invalid_snapshot_request");
      directory(this.#options.snapshot_root);
      const target = join(this.#options.snapshot_root, snapshotId);
      const locks: DatabaseSync[] = [],
        readers: DatabaseSync[] = [],
        files: FileRecord[] = [];
      let reserved = false,
        published = false;
      try {
        const sources = this.#options.sources.map((v) => {
          check();
          const info = file(v.path, this.#options.max_database_bytes);
          for (const suffix of ["-wal", "-shm", "-journal"])
            if (existsSync(v.path + suffix))
              file(v.path + suffix, this.#options.max_database_bytes);
          return { ...v, info };
        });
        if (
          new Set(sources.map((v) => v.info.dev + ":" + v.info.ino)).size !==
          sources.length
        )
          throw Error();
        // Acquire every writer lock before starting any backup reader or copy.
        for (const source of sources) {
          check();
          const db = new DatabaseSync(source.path);
          locks.push(db);
          db.exec("PRAGMA busy_timeout=" + this.#options.busy_timeout_ms);
          db.exec("BEGIN IMMEDIATE");
          if (
            !same(
              source.info,
              file(source.path, this.#options.max_database_bytes),
            )
          )
            throw Error();
        }
        check();
        mkdirSync(target, { mode: 0o700 });
        reserved = true;
        let total = 0;
        for (const source of sources) {
          check();
          if (
            !same(
              source.info,
              file(source.path, this.#options.max_database_bytes),
            )
          )
            throw Error();
          const reader = new DatabaseSync(source.path, { readOnly: true });
          readers.push(reader);
          const version = this.#schema(reader, source.role);
          const name = source.role + ".sqlite",
            output = join(target, name);
          closeSync(exclusive(output));
          // Await completion before releasing locks, even if a deadline/authority changes.
          await backup(reader, output, { rate: 128 });
          check();
          const copy = new DatabaseSync(output);
          try {
            copy.exec("PRAGMA journal_mode=DELETE");
            this.#schema(copy, source.role);
          } finally {
            copy.close();
          }
          const digest = this.#read(
            output,
            this.#options.max_database_bytes,
            check,
          );
          const fd = openSync(
            output,
            constants.O_RDONLY | constants.O_NOFOLLOW,
          );
          try {
            fsyncSync(fd);
          } finally {
            closeSync(fd);
          }
          total += digest.size_bytes;
          if (total > this.#options.max_total_bytes)
            throw new RelayError("snapshot_capacity");
          files.push({
            role: source.role,
            file: name,
            size_bytes: digest.size_bytes,
            sha256: digest.sha256,
            schema_version: version,
          });
        }
        check();
        for (const source of sources)
          if (
            !same(
              source.info,
              file(source.path, this.#options.max_database_bytes),
            )
          )
            throw Error();
        const data = {
          format: "hab-sqlite-snapshot-v1" as const,
          snapshot_id: snapshotId,
          profile: this.#options.profile,
          created_at: new Date().toISOString(),
          files,
        };
        writeDocument(join(target, "manifest.json"), {
          ...data,
          hmac: this.#hmac(data),
        });
        syncDirectory(target);
        syncDirectory(this.#options.snapshot_root);
        check();
        published = true;
        return {
          snapshot_id: snapshotId,
          database_count: files.length,
          total_bytes: total,
        };
      } finally {
        for (const reader of readers.reverse()) reader.close();
        for (const db of locks.reverse()) {
          try {
            db.exec("ROLLBACK");
          } catch {
            /* no successful transaction */
          }
          db.close();
        }
        if (reserved && !published && existsSync(join(target, "manifest.json")))
          unlinkSync(join(target, "manifest.json"));
      }
    });
  }
  #manifest(
    snapshotId: string,
    check: () => void,
  ): { path: string; manifest: Manifest } {
    if (!id(snapshotId)) throw new RelayError("invalid_snapshot_request");
    directory(this.#options.snapshot_root);
    const path = join(this.#options.snapshot_root, snapshotId);
    directory(path);
    let manifest: Manifest;
    try {
      manifest = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(
          this.#read(join(path, "manifest.json"), 16384, check).bytes!,
        ),
      );
      const { hmac, ...data } = manifest;
      if (
        Object.keys(manifest).sort().join(",") !==
          "created_at,files,format,hmac,profile,snapshot_id" ||
        manifest.format !== "hab-sqlite-snapshot-v1" ||
        manifest.snapshot_id !== snapshotId ||
        manifest.profile !== this.#options.profile ||
        !Array.isArray(manifest.files) ||
        manifest.files.length !== this.#options.sources.length ||
        typeof hmac !== "string" ||
        !/^[a-f0-9]{64}$/.test(hmac) ||
        !timingSafeEqual(
          Buffer.from(hmac, "hex"),
          Buffer.from(this.#hmac(data), "hex"),
        ) ||
        new Date(manifest.created_at).toISOString() !== manifest.created_at
      )
        throw Error();
      let total = 0;
      for (const [i, record] of manifest.files.entries()) {
        const role = this.#options.sources[i].role;
        if (
          Object.keys(record).sort().join(",") !==
            "file,role,schema_version,sha256,size_bytes" ||
          record.role !== role ||
          record.file !== role + ".sqlite" ||
          !schemaSupported(role, record.schema_version) ||
          !Number.isSafeInteger(record.size_bytes) ||
          record.size_bytes < 1 ||
          record.size_bytes > this.#options.max_database_bytes ||
          typeof record.sha256 !== "string" ||
          !/^[a-f0-9]{64}$/.test(record.sha256)
        )
          throw Error();
        total += record.size_bytes;
      }
      if (
        total > this.#options.max_total_bytes ||
        readdirSync(path).sort().join(",") !==
          ["manifest.json", ...manifest.files.map((v) => v.file)]
            .sort()
            .join(",")
      )
        throw Error();
    } catch (e) {
      if (e instanceof RelayError) throw e;
      throw new RelayError("snapshot_manifest_invalid");
    }
    return { path, manifest };
  }
  #verify(path: string, manifest: Manifest, check: () => void) {
    for (const record of manifest.files) {
      check();
      const dbPath = join(path, record.file);
      const digest = this.#read(
        dbPath,
        this.#options.max_database_bytes,
        check,
      );
      if (
        digest.size_bytes !== record.size_bytes ||
        digest.sha256 !== record.sha256
      )
        throw new RelayError("snapshot_integrity_failed");
      const db = new DatabaseSync(dbPath, { readOnly: true });
      try {
        if (this.#schema(db, record.role) !== record.schema_version)
          throw new RelayError("snapshot_integrity_failed");
      } finally {
        db.close();
      }
    }
  }
  async verify(context: unknown, snapshotId: string) {
    return this.#run(context, "verify", async (check) => {
      const { path, manifest } = this.#manifest(snapshotId, check);
      this.#verify(path, manifest, check);
      check();
      return {
        snapshot_id: snapshotId,
        database_count: manifest.files.length,
        verified: true as const,
      };
    });
  }
  async restore(context: unknown, snapshotId: string, restoredId: string) {
    return this.#run(context, "restore", async (check) => {
      if (!id(restoredId)) throw new RelayError("invalid_snapshot_request");
      const { path, manifest } = this.#manifest(snapshotId, check);
      this.#verify(path, manifest, check);
      directory(this.#options.restore_root);
      const target = join(this.#options.restore_root, restoredId);
      check();
      mkdirSync(target, { mode: 0o700 });
      let published = false;
      try {
        for (const record of manifest.files) {
          check();
          const output = join(target, record.file);
          const digest = this.#read(
            join(path, record.file),
            this.#options.max_database_bytes,
            check,
            output,
          );
          if (
            digest.size_bytes !== record.size_bytes ||
            digest.sha256 !== record.sha256
          )
            throw new RelayError("snapshot_integrity_failed");
          const db = new DatabaseSync(output, { readOnly: true });
          try {
            if (this.#schema(db, record.role) !== record.schema_version)
              throw new RelayError("snapshot_integrity_failed");
          } finally {
            db.close();
          }
        }
        check();
        writeDocument(join(target, "restore.json"), {
          format: "hab-sqlite-offline-restore-v1",
          snapshot_id: snapshotId,
          restored_id: restoredId,
          profile: manifest.profile,
          network_enabled: false,
          requires_reconciliation: true,
        });
        syncDirectory(target);
        syncDirectory(this.#options.restore_root);
        check();
        published = true;
        return {
          snapshot_id: snapshotId,
          restored_id: restoredId,
          database_count: manifest.files.length,
          state: "offline" as const,
        };
      } finally {
        if (!published && existsSync(join(target, "restore.json")))
          unlinkSync(join(target, "restore.json"));
      }
    });
  }
  close(): void {
    if (this.#running) throw new RelayError("snapshot_busy");
    this.#closed = true;
    this.#options.integrity_key.fill(0);
  }
}
