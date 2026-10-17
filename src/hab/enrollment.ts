/** Separate human management workflow. No MCP tools, credential issuance or network IO. */
import { z } from "zod";
import {
  RegistryError,
  habAddress,
  habSlug,
  relayOperations,
} from "./registry.ts";
import type { AgentOperation, AgentRecord, ProductRecord } from "./registry.ts";
import type { SQLiteHabRegistry } from "./sqlite-registry.ts";

export class EnrollmentError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.name = "EnrollmentError";
    this.code = code;
  }
}
const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$(?![\s\S])/);
const slug = z.string().refine((v) => {
  try {
    habSlug(v);
    return true;
  } catch {
    return false;
  }
});
const positive = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const grants = z
  .array(z.enum(relayOperations))
  .min(1)
  .max(5)
  .refine((v) => new Set(v).size === v.length)
  .transform((v) => v.sort());
const base = {
  version: z.literal(1),
  flow_id: id,
  product_id: id,
  agent_name: slug,
  bot_name: slug,
  address: z.string().max(101),
};
const enrolled = { ...base, agent_id: id, expected_epoch: positive };
const bound = { ...enrolled, binding_id: id };
const checkpointSchema = z.discriminatedUnion("stage", [
  z.strictObject({ ...base, stage: z.literal("enroll_pending") }),
  z.strictObject({ ...enrolled, stage: z.literal("enrolled") }),
  z.strictObject({
    ...enrolled,
    stage: z.literal("bind_pending"),
    connection_fingerprint: z.string().regex(/^[a-f0-9]{64}$(?![\s\S])/),
  }),
  z.strictObject({ ...bound, stage: z.literal("bound") }),
  z.strictObject({
    ...bound,
    stage: z.literal("activation_pending"),
    operations: grants,
  }),
  z.strictObject({
    ...bound,
    stage: z.literal("complete"),
    operations: grants,
  }),
]);
export type EnrollmentCheckpoint = z.infer<typeof checkpointSchema>;
export function parseEnrollmentCheckpoint(
  value: unknown,
): EnrollmentCheckpoint {
  const parsed = checkpointSchema.safeParse(value);
  if (
    !parsed.success ||
    parsed.data.address !==
      habAddress(parsed.data.bot_name, parsed.data.agent_name)
  )
    throw new EnrollmentError("invalid_enrollment_checkpoint");
  return parsed.data;
}
export interface EnrollmentJournal {
  load(
    flowId: string,
  ): { revision: number; checkpoint: EnrollmentCheckpoint } | undefined;
  /** Must commit durably and atomically before returning; CAS 0 means create. */
  save(
    flowId: string,
    expectedRevision: number,
    checkpoint: EnrollmentCheckpoint,
  ): number;
}
export type EnrollmentConfirmation =
  | { kind: "reserve"; address: string; agent_name: string }
  | { kind: "bind"; address: string; connection_label: string }
  | {
      kind: "activate";
      address: string;
      operations: readonly AgentOperation[];
    };
export interface EnrollmentUI {
  product(page: {
    products: readonly ProductRecord[];
    next: string | null;
  }): Promise<string | null>;
  botName(product: ProductRecord): Promise<string | null>;
  /** Exact true is required; anything else pauses without a subsequent mutation. */
  confirm(proposal: EnrollmentConfirmation): Promise<boolean>;
  operations(
    agent: AgentRecord,
    allowed: readonly AgentOperation[],
  ): Promise<AgentOperation[] | null>;
}
type RegistryPort = Pick<
  SQLiteHabRegistry,
  | "catalog"
  | "preview"
  | "enroll"
  | "inspect"
  | "inspectBinding"
  | "inspectConnection"
  | "bindVerified"
  | "setAccess"
>;
export interface EnrollmentHost {
  registry: RegistryPort;
  journal: EnrollmentJournal;
  ui: EnrollmentUI;
  /** Host verifies current separate management authority; never a CLI --admin flag. */
  managementContext(): unknown;
  /** Select/reverify one exclusive individual. Matching a digest alone is not authentication. */
  connection(
    expectedFingerprint?: string,
  ): Promise<{ context: unknown; label: string }>;
}
export type EnrollmentResult =
  | {
      status: "paused";
      flow_id: string;
      stage: EnrollmentCheckpoint["stage"] | "unconfirmed";
    }
  | {
      status: "complete";
      flow_id: string;
      agent: AgentRecord;
      binding_id: string;
    };

const allowedErrors = new Set([
  "registry_forbidden",
  "invalid_registry_request",
  "registry_unavailable",
  "registry_not_migrated",
  "registry_busy",
  "registry_capacity_exceeded",
  "registry_not_found",
  "registry_name_reserved",
  "registry_idempotency_conflict",
  "registry_binding_reserved",
  "registry_binding_revoked",
  "registry_binding_required",
  "registry_stale_epoch",
  "registry_retired",
  "registry_connection_changed",
]);
const workflowErrors = new Set([
  "invalid_enrollment_checkpoint",
  "invalid_enrollment_flow",
  "invalid_enrollment_choice",
  "invalid_enrollment_connection",
  "invalid_enrollment_journal_options",
  "enrollment_journal_unavailable",
  "enrollment_journal_not_migrated",
  "enrollment_journal_conflict",
  "enrollment_journal_capacity_exceeded",
  "unknown_enrollment_journal_schema",
  "unsupported_enrollment_journal_schema",
  "enrollment_review_required",
  "enrollment_failed",
]);
/** Each invocation runs a finite six-stage sequence. No automatic retry or activation on import. */
export async function runHabEnrollment(
  host: EnrollmentHost,
  flowId: string,
): Promise<EnrollmentResult> {
  try {
    if (!id.safeParse(flowId).success || flowId.length > 96)
      throw new EnrollmentError("invalid_enrollment_flow");
    const { registry, journal, ui } = host;
    const admin = () => host.managementContext();
    // Recheck management before revealing a saved local checkpoint to the UI.
    let page = registry.catalog(admin(), { limit: 50 });
    const row = journal.load(flowId);
    let revision = row?.revision ?? 0;
    if (
      !Number.isSafeInteger(revision) ||
      revision < 0 ||
      (row && revision === 0)
    )
      throw new EnrollmentError("invalid_enrollment_checkpoint");
    let state = row ? parseEnrollmentCheckpoint(row.checkpoint) : undefined;
    if (state && state.flow_id !== flowId)
      throw new EnrollmentError("invalid_enrollment_checkpoint");
    const save = (next: EnrollmentCheckpoint) => {
      const clean = parseEnrollmentCheckpoint(next);
      const nextRevision = journal.save(flowId, revision, clean);
      if (nextRevision !== revision + 1)
        throw new EnrollmentError("enrollment_journal_unavailable");
      revision = nextRevision;
      state = clean;
    };
    const pause = (): EnrollmentResult => ({
      status: "paused",
      flow_id: flowId,
      stage: state?.stage ?? "unconfirmed",
    });
    if (!state) {
      let product: ProductRecord | undefined;
      // A product page is bounded. Pagination is explicit and this loop has a hard cap.
      for (let pages = 0; pages < 20000; pages++) {
        const choice = await ui.product(structuredClone(page));
        if (choice === null) return pause();
        if (choice === "next" && page.next !== null) {
          page = registry.catalog(admin(), { limit: 50, after: page.next });
          continue;
        }
        product = page.products.find((v) => v.product_id === choice);
        if (!product) throw new EnrollmentError("invalid_enrollment_choice");
        break;
      }
      if (!product) throw new EnrollmentError("invalid_enrollment_choice");
      const botName = await ui.botName(structuredClone(product));
      if (botName === null) return pause();
      const proposal = registry.preview(admin(), {
        product_id: product.product_id,
        bot_name: botName,
      });
      if (!proposal.available)
        throw new RegistryError("registry_name_reserved");
      if (
        (await ui.confirm({
          kind: "reserve",
          address: proposal.address,
          agent_name: proposal.agent_name,
        })) !== true
      )
        return pause();
      save({
        version: 1,
        flow_id: flowId,
        product_id: product.product_id,
        agent_name: proposal.agent_name,
        bot_name: proposal.bot_name,
        address: proposal.address,
        stage: "enroll_pending",
      });
    }
    // Parse once more for narrowing; journal failure never advances this invocation.
    let current = parseEnrollmentCheckpoint(state);
    const request = (op: string) => `${op}:${flowId}`;
    if (current.stage === "enroll_pending") {
      const proposal = registry.preview(admin(), {
        product_id: current.product_id,
        bot_name: current.bot_name,
      });
      if (proposal.address !== current.address)
        throw new EnrollmentError("enrollment_review_required");
      const receipt = registry.enroll(admin(), {
        request_id: request("enroll"),
        product_id: current.product_id,
        bot_name: current.bot_name,
      });
      const agent = registry.inspect(admin(), receipt.agent_id);
      if (
        agent.address !== current.address ||
        agent.product_id !== current.product_id ||
        agent.state !== "waiting_connection" ||
        agent.epoch !== receipt.epoch
      )
        throw new EnrollmentError("enrollment_review_required");
      save({
        ...current,
        stage: "enrolled",
        agent_id: agent.agent_id,
        expected_epoch: agent.epoch,
      });
    }
    current = parseEnrollmentCheckpoint(state);
    let candidate: { context: unknown; label: string } | undefined;
    if (current.stage === "enrolled") {
      const agent = registry.inspect(admin(), current.agent_id);
      assertWaiting(agent, current);
      candidate = await host.connection();
      if (
        typeof candidate.label !== "string" ||
        !/^[^\x00-\x1f\x7f]{1,80}$(?![\s\S])/.test(candidate.label)
      )
        throw new EnrollmentError("invalid_enrollment_connection");
      const connection = registry.inspectConnection(admin(), candidate.context);
      if (
        (await ui.confirm({
          kind: "bind",
          address: agent.address,
          connection_label: candidate.label,
        })) !== true
      )
        return pause();
      save({ ...current, stage: "bind_pending", ...connection });
    }
    current = parseEnrollmentCheckpoint(state);
    if (current.stage === "bind_pending") {
      candidate ??= await host.connection(current.connection_fingerprint);
      const binding = registry.bindVerified(
        admin(),
        {
          request_id: request("bind"),
          agent_id: current.agent_id,
          expected_epoch: current.expected_epoch,
          connection_fingerprint: current.connection_fingerprint,
        },
        candidate.context,
      );
      const agent = registry.inspect(admin(), current.agent_id);
      assertWaiting(agent, { ...current, expected_epoch: binding.agent_epoch });
      const live = registry.inspectBinding(admin(), binding.binding_id);
      if (
        live.agent_id !== agent.agent_id ||
        live.state !== "active" ||
        live.agent_epoch !== agent.epoch
      )
        throw new EnrollmentError("enrollment_review_required");
      const { connection_fingerprint: _digest, ...rest } = current;
      void _digest;
      save({
        ...rest,
        stage: "bound",
        binding_id: live.binding_id,
        expected_epoch: agent.epoch,
      });
    }
    current = parseEnrollmentCheckpoint(state);
    if (current.stage === "bound") {
      const agent = registry.inspect(admin(), current.agent_id);
      assertWaiting(agent, current);
      const live = registry.inspectBinding(admin(), current.binding_id);
      if (
        live.agent_id !== agent.agent_id ||
        live.state !== "active" ||
        live.agent_epoch !== agent.epoch
      )
        throw new EnrollmentError("enrollment_review_required");
      const choice = await ui.operations(structuredClone(agent), [
        ...relayOperations,
      ]);
      if (choice === null) return pause();
      const parsed = grants.safeParse(choice);
      if (!parsed.success)
        throw new EnrollmentError("invalid_enrollment_choice");
      const operations = parsed.data;
      if (
        (await ui.confirm({
          kind: "activate",
          address: agent.address,
          operations: [...operations],
        })) !== true
      )
        return pause();
      save({ ...current, stage: "activation_pending", operations });
    }
    current = parseEnrollmentCheckpoint(state);
    if (current.stage === "activation_pending") {
      const receipt = registry.setAccess(admin(), {
        request_id: request("activate"),
        agent_id: current.agent_id,
        expected_epoch: current.expected_epoch,
        state: "active",
        operations: current.operations,
      });
      save({ ...current, stage: "complete", expected_epoch: receipt.epoch });
    }
    current = parseEnrollmentCheckpoint(state);
    if (current.stage !== "complete")
      throw new EnrollmentError("enrollment_failed");
    const agent = registry.inspect(admin(), current.agent_id);
    const live = registry.inspectBinding(admin(), current.binding_id);
    if (
      agent.address !== current.address ||
      agent.epoch !== current.expected_epoch ||
      agent.state !== "active" ||
      live.agent_id !== agent.agent_id ||
      live.state !== "active" ||
      live.agent_epoch !== agent.epoch ||
      JSON.stringify(agent.operations) !== JSON.stringify(current.operations)
    )
      throw new EnrollmentError("enrollment_review_required");
    return {
      status: "complete",
      flow_id: flowId,
      agent,
      binding_id: live.binding_id,
    };
  } catch (error) {
    if (error instanceof EnrollmentError && workflowErrors.has(error.code))
      throw error;
    if (error instanceof RegistryError && allowedErrors.has(error.code))
      throw new EnrollmentError(error.code);
    throw new EnrollmentError("enrollment_failed");
  }
}
function assertWaiting(
  agent: AgentRecord,
  state: {
    address: string;
    expected_epoch: number;
  },
) {
  if (
    agent.address !== state.address ||
    agent.state !== "waiting_connection" ||
    agent.epoch !== state.expected_epoch ||
    agent.operations.length !== 0
  )
    throw new EnrollmentError("enrollment_review_required");
}
