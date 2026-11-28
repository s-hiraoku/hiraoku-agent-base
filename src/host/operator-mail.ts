import { createHmac } from "node:crypto";
import { lstatSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import {
  AuthenticationRecoveryError,
  authenticationRecoveryReason,
} from "../hab/authentication-recovery.ts";
import { HabMcpClient } from "../hab/mcp-client.ts";
import { HAB_ADDRESS_PATTERN } from "../hab/registry.ts";
import { replayBoundSentAt } from "../messaging/contract.ts";
import { MessagingError } from "../messaging/delivery-service.ts";
import { HostAdminError } from "./admin.ts";
import {
  HostStartError,
  readHostConfig,
  readOperatorBearer,
} from "./config.ts";
import { OperatorMailStore } from "./operator-mail-store.ts";
import type {
  OperatorMailInput,
  OperatorMailRecord,
  OperatorMailView,
  PreparedOperatorMailInput,
} from "./operator-mail-store.ts";

export type {
  OperatorMailInput,
  OperatorMailView,
} from "./operator-mail-store.ts";

export const OPERATOR_PING_TEXT =
  "HAB の接続確認です。届いていたら、このメッセージに返信してください。";

const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$(?![\s\S])/);
const operationIdSchema = id.refine(
  (value) => replayBoundSentAt(value) !== undefined,
);
const address = z.string().max(101).regex(new RegExp(HAB_ADDRESS_PATTERN));
const text = z.string().min(1);
const inputSchema = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("send"), to: address, text }),
  z.strictObject({ action: z.literal("reply"), message_id: id, text }),
  z.strictObject({ action: z.literal("ping"), to: address }),
]);
const time = z.iso.datetime();
const receipt = z.object({
  message_id: id,
  to: address.nullable(),
  state: z.enum(["pending", "leased", "acked", "expired", "quarantined"]),
  accepted_at: time,
  expires_at: time,
});
const status = receipt.extend({
  replies: z.array(z.object({ received_at: time })).max(5),
});
const inbox = z.object({
  messages: z
    .array(
      z.object({
        message_id: id,
        from: address.nullable(),
        text: z.string().nullable(),
        sent_at: time,
        read_at: time.nullable(),
        expires_at: time,
        in_reply_to: id.nullable(),
      }),
    )
    .max(10),
  next_cursor: z.string().max(512).nullable().optional(),
});
type Receipt = z.infer<typeof receipt>;

class AgentClient extends HabMcpClient {
  protected override get distinguishAuthenticationRefusal() {
    return true;
  }

  call(
    tool: "hab_send" | "hab_reply" | "hab_status" | "hab_inbox",
    args: Record<string, unknown>,
  ) {
    return this.requestTool(tool, args);
  }
}

function problem(error: unknown): string {
  if (error instanceof MessagingError) return error.code;
  if (authenticationRecoveryReason(error)) return "forbidden";
  return "transport_failed";
}

function readEvidence<T>(path: string, query: (db: DatabaseSync) => T) {
  try {
    const info = lstatSync(path);
    if (
      !info.isFile() ||
      info.nlink !== 1 ||
      info.uid !== process.getuid?.() ||
      (info.mode & 0o077) !== 0
    )
      return;
    const db = new DatabaseSync(path, { readOnly: true, timeout: 100 });
    try {
      return query(db);
    } finally {
      db.close();
    }
  } catch {
    // Evidence may be unavailable on a host without events or during a restart.
    return;
  }
}

function evidenceTime(ms: number | null | undefined): string | null {
  return typeof ms === "number" && Number.isFinite(new Date(ms).getTime())
    ? new Date(ms).toISOString()
    : null;
}

type DeliveryEvidence = {
  recipient_id: string;
  ack_request_id: string | null;
  ack_fingerprint: string | null;
  acked_at: number | null;
};

function messageEvidence(
  directory: string,
  fingerprintKey: Buffer,
  senderId: string,
  record: OperatorMailRecord,
  acceptedState: Receipt["state"],
) {
  const messageId = record.view.message_id;
  const row = readEvidence(
    join(directory, "delivery.sqlite"),
    (db) =>
      db
        .prepare(
          "SELECT recipient_id, ack_request_id, ack_fingerprint, acked_at FROM delivery_messages WHERE sender_id=? AND message_id=?",
        )
        .get(senderId, messageId) as DeliveryEvidence | undefined,
  );
  if (
    !row ||
    (record.recipient_id !== null && record.recipient_id !== row.recipient_id)
  )
    return { acked_at: null, read_at: null, doorbell_at: null };

  const acked_at =
    acceptedState === "acked" ? evidenceTime(row.acked_at) : null;
  const readFingerprint =
    row.ack_request_id === null
      ? null
      : createHmac("sha256", fingerprintKey)
          .update("inbox-read:" + row.ack_request_id)
          .digest("hex");
  const doorbell = readEvidence(
    join(directory, "events.sqlite"),
    (db) =>
      db
        .prepare(
          "SELECT accepted_at FROM hab_event_accepted WHERE agent_id=? AND sender_id=? AND message_id=?",
        )
        .get(row.recipient_id, senderId, messageId) as
        { accepted_at: number } | undefined,
  );
  return {
    acked_at,
    read_at:
      readFingerprint && readFingerprint === row.ack_fingerprint
        ? acked_at
        : null,
    doorbell_at: evidenceTime(doorbell?.accepted_at),
  };
}

export class OperatorMail {
  readonly address: string;
  readonly #role: "mailbox" | "ping";
  readonly #directory: string;
  readonly #fingerprintKey: Buffer;
  readonly #textLimit: number;
  readonly #client: AgentClient;
  readonly #directoryClient: HabMcpClient;
  readonly #store: OperatorMailStore;

  constructor(configPath: string, role: "mailbox" | "ping") {
    let loaded;
    try {
      loaded = readHostConfig(configPath);
    } catch (error) {
      throw new HostAdminError(
        error instanceof HostStartError ? error.reason : "config_invalid",
      );
    }
    const { config, delivery_fingerprint_key } = loaded;
    const identity = config.operator_mail?.[role];
    if (!identity) throw new HostAdminError("operator_mail_not_configured");
    if (!config.port)
      throw new HostAdminError("operator_mail_requires_fixed_port");

    this.address = identity.address;
    this.#role = role;
    this.#directory = config.directory;
    this.#fingerprintKey = delivery_fingerprint_key;
    this.#textLimit = config.limits.text_bytes;
    const policy = {
      resource_url: "http://127.0.0.1:" + config.port + "/mcp",
      agent_id: identity.agent_id,
      max_request_bytes: config.http.max_request_bytes,
      max_response_bytes: config.http.max_response_bytes,
      timeout_ms: config.http.timeout_ms,
      max_active_requests: config.http.max_active_requests,
      max_sse_events: 16,
      max_sse_lines: 4096,
      max_json_depth: 128,
      max_json_nodes: 1_000_000,
    };
    const options = {
      policy,
      limits: config.limits,
      authorization: () => {
        try {
          return "Bearer " + readOperatorBearer(identity.bearer_file);
        } catch {
          throw new AuthenticationRecoveryError("reauthentication_required");
        }
      },
      as_address: identity.address,
    };
    this.#client = new AgentClient(options);
    this.#directoryClient = new AgentClient({
      ...options,
      policy: { ...policy, resource_url: policy.resource_url + "/delivery" },
    });
    this.#store = new OperatorMailStore(
      config.directory,
      identity.agent_id,
      role,
      delivery_fingerprint_key,
    );
  }

  list(): OperatorMailView[] {
    return this.#store.list();
  }

  async submit(
    operationId: string,
    input: OperatorMailInput,
  ): Promise<OperatorMailView> {
    if (!operationIdSchema.safeParse(operationId).success)
      throw new HostAdminError("invalid_request");
    const parsed = inputSchema.safeParse(input);
    if (!parsed.success) throw new HostAdminError("invalid_request");
    const message = parsed.data;
    if ((message.action === "ping") !== (this.#role === "ping"))
      throw new HostAdminError("forbidden");
    const existing = this.#store.match(operationId, message);
    if (existing) return this.#refresh(existing, true);
    const messageText =
      message.action === "ping" ? OPERATOR_PING_TEXT : message.text;
    if (Buffer.byteLength(messageText) > this.#textLimit)
      throw new HostAdminError("text_too_long");
    let recipientId: string | null = null;
    if (message.action !== "reply") {
      try {
        recipientId = (await this.#directoryClient.resolve(message.to))
          .recipient_id;
      } catch (error) {
        throw new HostAdminError(problem(error));
      }
    }
    const record = this.#store.prepare(
      operationId,
      message,
      recipientId,
      message.action === "ping" ? OPERATOR_PING_TEXT : undefined,
    );
    return this.#refresh(record, true);
  }

  status(operationId: string): Promise<OperatorMailView> {
    return this.#refresh(this.#get(operationId), false);
  }

  retry(operationId: string): Promise<OperatorMailView> {
    return this.#refresh(this.#get(operationId), true);
  }

  async inbox(readHistory?: string) {
    if (this.#role !== "mailbox") throw new HostAdminError("forbidden");
    try {
      return inbox.parse(
        await this.#client.call("hab_inbox", {
          limit: 10,
          ...(readHistory === undefined
            ? { include_read: true }
            : { read_history: readHistory }),
        }),
      );
    } catch (error) {
      throw new HostAdminError(problem(error));
    }
  }

  #get(operationId: string) {
    if (!operationIdSchema.safeParse(operationId).success)
      throw new HostAdminError("invalid_request");
    const record = this.#store.get(operationId);
    if (!record) throw new HostAdminError("operation_not_found");
    return record;
  }

  async #refresh(
    record: OperatorMailRecord,
    retry: boolean,
  ): Promise<OperatorMailView> {
    let result;
    try {
      result = status.parse(
        await this.#client.call("hab_status", {
          message_id: record.view.message_id,
        }),
      );
    } catch (error) {
      const code = problem(error);
      if (retry && code === "not_found") {
        // A competing request may have confirmed acceptance while status was in flight.
        const current = this.#get(record.view.operation_id);
        if (current.view.accepted_at === null) {
          if (current.input) return this.#send(current, current.input);
          return this.#store.problem(
            record.view.operation_id,
            "operation_expired",
          ).view;
        }
      }
      return this.#store.problem(record.view.operation_id, code).view;
    }
    return this.#observe(
      record,
      result,
      result.replies[0]?.received_at ?? null,
    );
  }

  async #send(record: OperatorMailRecord, input: PreparedOperatorMailInput) {
    const request_id = record.view.message_id;
    let result;
    try {
      result = receipt.parse(
        input.action === "reply"
          ? await this.#client.call("hab_reply", {
              message_id: input.message_id,
              text: input.text,
              request_id,
            })
          : await this.#client.call("hab_send", {
              to: input.to,
              text: input.text,
              ...(input.action === "ping" ? { kind: "notice" } : {}),
              expected_recipient_id: record.recipient_id,
              request_id,
            }),
      );
    } catch (error) {
      return this.#store.problem(record.view.operation_id, problem(error)).view;
    }
    return this.#observe(record, result, null);
  }

  #observe(
    record: OperatorMailRecord,
    result: Receipt,
    replyAt: string | null,
  ) {
    const operationId = record.view.operation_id;
    if (
      result.message_id !== record.view.message_id ||
      result.expires_at !== record.view.expires_at
    )
      return this.#store.problem(operationId, "transport_failed").view;
    // Only consult host evidence after the actual sender's authenticated status or receipt.
    return this.#store.observe(operationId, {
      to: result.to,
      state: result.state,
      accepted_at: result.accepted_at,
      ...messageEvidence(
        this.#directory,
        this.#fingerprintKey,
        this.#client.agentId,
        record,
        result.state,
      ),
      reply_at: replyAt,
    }).view;
  }
}
