import { createHash } from "node:crypto";
import { z } from "zod";
import { boundedText, textBindingSchema } from "../text-task.ts";
import { RUN_ID_PATTERN, type Run, type Runs, type Task } from "../types.ts";
import {
  parseSubmission,
  DELIVERY_TTL_MS,
  type Submission,
  type ContractLimits,
} from "../messaging/contract.ts";
import type { InboxEntry, ReceiverTransport } from "../relay/receiver.ts";
import type { Receipt } from "../messaging/delivery-service.ts";

export const TEXT_NATS_CONTRACT = "hab-generic-nats-text-v1";
export const TEXT_NATS_SCHEMA = "hab.generic-text-nats";
export const textNatsLimits: ContractLimits = Object.freeze({
  envelope_bytes: 393216,
  text_bytes: 32768,
  data_bytes: 262144,
  parts: 1,
  json_depth: 20,
  json_nodes: 1000,
});
const identifier = z.string().min(1).max(200);
const peer = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/);
export const routeSchema = z.strictObject({
  id: peer,
  coordinator: peer,
  recipient: peer,
  ownerSubject: identifier,
  ownerClient: identifier,
  workerSubject: identifier,
  workerClient: identifier,
  binding: textBindingSchema,
  boundaryId: identifier,
  runtimeBoundaryId: identifier,
  retentionMs: z.number().int().positive().safe(),
});
export type RouteInput = z.infer<typeof routeSchema>;
export type TextRoute = Readonly<RouteInput & { scope: string }>;
export function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, item) =>
    item && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(
          Object.keys(item)
            .sort()
            .map((key) => [key, item[key]]),
        )
      : item,
  );
}
export const digest = (value: unknown): string =>
  createHash("sha256").update(canonical(value)).digest("hex");
export function defineRoute(input: RouteInput): TextRoute {
  const route = routeSchema.parse(input);
  if (route.coordinator === route.recipient) throw Error("invalid_text_route");
  return Object.freeze({
    ...route,
    binding: Object.freeze(route.binding),
    scope: digest(route),
  });
}
export const keySchema = z
  .string()
  .regex(/^hub-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/);
export const inputSchema = z.strictObject({
  idempotencyKey: keySchema,
  content: z.strictObject({
    origin: z.literal("external_agent"),
    text: boundedText,
    messageId: identifier,
    contextId: identifier,
    senderAgent: identifier,
    recipientAgent: identifier,
  }),
  tools: z.tuple([]),
  replay: z.strictObject({
    deadline: z.number().int().nonnegative().safe(),
    retentionMs: z.number().int().positive().safe(),
    contract: z.literal(TEXT_NATS_CONTRACT),
  }),
});
export type TextRunInput = z.infer<typeof inputSchema>;
export type CreateTextInput = Parameters<NonNullable<Runs["createText"]>>[0];
export const runSchema = z
  .strictObject({
    id: z.string().regex(RUN_ID_PATTERN),
    state: z.enum(["running", "succeeded", "failed", "cancelled"]),
    text: boundedText.optional(),
  })
  .refine((run) => run.state !== "succeeded" || !!run.text);
export function safeRun(value: unknown): Run {
  const run = runSchema.parse(value);
  return run.state === "succeeded" ? run : { id: run.id, state: run.state };
}
const base = {
  version: z.literal(1),
  route: peer,
  scope: z.string().regex(/^[a-f0-9]{64}$/),
  key: keySchema,
  handle: z.string().regex(/^gn_[a-f0-9]{64}$/),
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  requestId: peer,
};
export const executeSchema = z.strictObject({
  ...base,
  type: z.literal("execute"),
  acceptedAt: z.number().int().nonnegative().safe(),
  input: inputSchema,
});
export const inspectSchema = z.strictObject({
  ...base,
  type: z.literal("inspect"),
});
export const evidenceSchema = z
  .strictObject({
    ...base,
    type: z.literal("evidence"),
    replyTo: peer,
    phase: z.enum(["admission", "outcome", "inspection"]),
    outcome: z.enum(["known", "not_found", "unknown"]),
    run: runSchema.optional(),
  })
  .refine((packet) => (packet.outcome === "known") === !!packet.run);
export const packetSchema = z.union([
  executeSchema,
  inspectSchema,
  evidenceSchema,
]);
export type ExecutePacket = z.infer<typeof executeSchema>;
export type InspectPacket = z.infer<typeof inspectSchema>;
export type EvidencePacket = z.infer<typeof evidenceSchema>;
export type TextPacket = z.infer<typeof packetSchema>;
export type RequestPacket = ExecutePacket | InspectPacket;
export const messageId = (...parts: unknown[]) => "gnm_" + digest(parts);
export const handleFor = (route: TextRoute, key: string) =>
  "gn_" + digest([route.scope, key]);
export function executePacket(
  route: TextRoute,
  input: CreateTextInput,
  acceptedAt: number,
): ExecutePacket {
  const parsed = inputSchema.parse({
    idempotencyKey: input.idempotencyKey,
    content: input.content,
    tools: input.tools,
    replay: input.replay,
  });
  const key = parsed.idempotencyKey,
    handle = handleFor(route, key);
  return executeSchema.parse({
    version: 1,
    type: "execute",
    route: route.id,
    scope: route.scope,
    key,
    handle,
    acceptedAt,
    input: parsed,
    fingerprint: digest([route.scope, key, acceptedAt, parsed]),
    requestId: messageId(route.scope, key, "execute"),
  });
}
export function inspectPacket(
  request: ExecutePacket,
  sequence: number,
): InspectPacket {
  return inspectSchema.parse({
    ...commonPacket(request),
    type: "inspect",
    requestId: messageId(request.scope, request.key, "inspect", sequence),
  });
}
export function commonPacket(packet: TextPacket) {
  return {
    version: packet.version,
    route: packet.route,
    scope: packet.scope,
    key: packet.key,
    handle: packet.handle,
    fingerprint: packet.fingerprint,
    requestId: packet.requestId,
  };
}
export function evidencePacket(
  request: RequestPacket,
  phase: EvidencePacket["phase"],
  run: Run | null | undefined,
): EvidencePacket {
  return evidenceSchema.parse({
    ...commonPacket(request),
    type: "evidence",
    requestId: messageId(request.scope, request.key, request.requestId, phase),
    replyTo: request.requestId,
    phase,
    outcome:
      run === null ? "not_found" : run === undefined ? "unknown" : "known",
    ...(run ? { run: safeRun(run) } : {}),
  });
}
export function packetMessage(
  packet: TextPacket,
  route: TextRoute,
  firstAt: number,
): Submission {
  const evidence = packet.type === "evidence";
  return parseSubmission(
    {
      version: 1,
      message_id: packet.requestId,
      recipient_id: evidence ? route.coordinator : route.recipient,
      kind: evidence ? "generic_text_evidence" : "generic_text_request",
      thread_id: packet.handle,
      in_reply_to: evidence
        ? { sender_id: route.coordinator, message_id: packet.replyTo }
        : null,
      first_sent_at: new Date(firstAt).toISOString(),
      expires_at: new Date(firstAt + DELIVERY_TTL_MS).toISOString(),
      body: {
        parts: [
          {
            type: "data",
            schema_id: TEXT_NATS_SCHEMA,
            schema_version: 1,
            value: packet,
          },
        ],
      },
    },
    textNatsLimits,
  );
}
export function packetFrom(
  entry: InboxEntry,
  route: TextRoute,
  direction: "request" | "evidence",
): TextPacket {
  const m = entry.message,
    part = m.body.parts[0];
  if (
    m.body.parts.length !== 1 ||
    part.type !== "data" ||
    part.schema_id !== TEXT_NATS_SCHEMA ||
    part.schema_version !== 1 ||
    entry.sender_id !==
      (direction === "request" ? route.coordinator : route.recipient) ||
    m.recipient_id !==
      (direction === "request" ? route.recipient : route.coordinator) ||
    m.kind !==
      (direction === "request"
        ? "generic_text_request"
        : "generic_text_evidence")
  )
    throw Error("foreign_text_packet");
  const packet = packetSchema.parse(part.value);
  if (
    packet.route !== route.id ||
    packet.scope !== route.scope ||
    packet.handle !== handleFor(route, packet.key) ||
    packet.requestId !== m.message_id ||
    packet.handle !== m.thread_id ||
    (direction === "evidence") !== (packet.type === "evidence")
  )
    throw Error("text_packet_conflict");
  if (packet.type === "evidence") {
    if (
      m.in_reply_to?.sender_id !== route.coordinator ||
      m.in_reply_to.message_id !== packet.replyTo
    )
      throw Error("text_reply_conflict");
  } else if (
    m.in_reply_to !== null ||
    (packet.type === "execute" &&
      (Date.parse(m.first_sent_at) !== packet.acceptedAt ||
        packet.key !== packet.input.idempotencyKey ||
        canonical(packet) !==
          canonical(executePacket(route, packet.input, packet.acceptedAt))))
  )
    throw Error("text_request_conflict");
  return packet;
}
export interface TextRelayPort extends ReceiverTransport {
  readonly agentId: string;
  submit(message: Submission): Promise<Receipt>;
  status(messageId: string): Promise<Receipt>;
}
export interface TaskWitness {
  task: Task;
  epoch: number;
  now: number;
  admissionAllowed: boolean;
}
export interface TextTaskGate {
  inspect(route: TextRoute, key: string): Promise<TaskWitness>;
}
export type GateMode = "prepare" | "publish" | "execute" | "observe";
export function assertWitness(
  route: TextRoute,
  request: ExecutePacket,
  witness: TaskWitness,
  mode: GateMode,
): void {
  if (!Number.isSafeInteger(witness.now) || witness.now < 0)
    throw Error("invalid_text_clock");
  const task = witness.task,
    stored = task.text_request;
  if (
    !stored ||
    task.task_type !== "generic_text" ||
    request.key !== `hub-${task.id}` ||
    task.owner !== route.ownerSubject ||
    stored.owner !== route.ownerSubject ||
    stored.ownerClient !== route.ownerClient ||
    canonical(stored.binding) !== canonical(route.binding) ||
    task.runner_scope !== route.boundaryId ||
    task.destination !== route.binding.recipientAgent ||
    request.acceptedAt !== stored.acceptedAt ||
    request.scope !== route.scope ||
    request.handle !== handleFor(route, request.key)
  )
    throw Error("text_task_binding_denied");
  const expectedContent = {
    origin: "external_agent",
    text: stored.input.text,
    messageId: stored.input.messageId,
    contextId: stored.input.contextId,
    senderAgent: stored.binding.senderAgent,
    recipientAgent: stored.binding.recipientAgent,
  };
  if (
    canonical(request.input.content) !== canonical(expectedContent) ||
    request.input.replay.contract !== TEXT_NATS_CONTRACT ||
    request.input.replay.retentionMs !== route.retentionMs ||
    request.input.replay.deadline !==
      Math.min(stored.acceptedAt + route.retentionMs, stored.input.workDeadline)
  )
    throw Error("text_task_input_conflict");
  if (
    mode === "prepare" &&
    task.run_id !== null &&
    task.run_id !== request.handle
  )
    throw Error("text_run_identity_conflict");
  if (mode !== "prepare" && task.run_id !== request.handle)
    throw Error("text_handle_not_attached");
  if (
    mode !== "observe" &&
    (!witness.admissionAllowed ||
      task.state !== "running" ||
      task.execution_open !== 1 ||
      !task.lease ||
      task.lease <= witness.now ||
      witness.now >= stored.input.workDeadline ||
      witness.now >= stored.acceptedAt + DELIVERY_TTL_MS ||
      witness.now >= request.input.replay.deadline)
  )
    throw Error("text_admission_denied");
}
export function sameWitness(before: TaskWitness, after: TaskWitness): void {
  if (
    before.epoch !== after.epoch ||
    before.task.fence !== after.task.fence ||
    before.task.run_id !== after.task.run_id ||
    canonical(before.task.text_request) !== canonical(after.task.text_request)
  )
    throw Error("text_authorization_changed");
}
export interface RecoverableTextRuntime extends Runs {
  lookupText?(key: string, signal?: AbortSignal): Promise<Run | null>;
}
