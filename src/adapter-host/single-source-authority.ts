/** Opt-in owner policy for one fixed question and a dedicated outbox. Not authentication. */
import { id, sourceKey } from "../adapter-policy/contract.ts";
import { AdapterHostCycle } from "./cycle.ts";
import type { AdapterHostOptions, HostAuthorization } from "./cycle.ts";
import type { SQLiteHostOwner } from "./sqlite-owner.ts";

/**
 * The trusted composition supplies already verified, distinct opaque contexts.
 * Use with exactly one host/owner, one fixed source and its dedicated outbox;
 * no other producer may enqueue there. Native required approvals still apply.
 * No context, policy update or control method is exposed as an MCP tool.
 */
export function createSingleSourceHost(options: {
  hostOptions: Omit<AdapterHostOptions, "authorization" | "owner"> & { owner: SQLiteHostOwner };
  actorId: string;
  verifiedRecipientContext: object;
  verifiedOperatorContext: object;
  source: { sender_id: string; message_id: string };
}) {
  const agent_id = id.parse(options.hostOptions?.control?.agentId), actor_id = id.parse(options.actorId);
  const source = sourceKey.parse(options.source);
  const recipient = options.verifiedRecipientContext, operator = options.verifiedOperatorContext;
  if (!recipient || !operator || typeof recipient !== "object" ||
      typeof operator !== "object" || recipient === operator)
    throw Error("invalid_single_source_authority");
  let enabled = false, revoked = false;
  if (!options.hostOptions.owner || !options.hostOptions.control.snapshot().paused)
    throw Error("single_source_requires_paused_owned_host");
  /** Current recipient guards include terminal revocation; operator cleanup keeps its own scope. */
  const authorization: HostAuthorization = (context, operation, key) => {
    if (context === operator && ["status", "control", "release_owner"].includes(operation))
      return { agent_id, actor_id };
    if (context !== recipient || !enabled || revoked) return undefined;
    // send has no source argument: this is a grant for the WHOLE dedicated outbox.
    if (["receive", "send"].includes(operation) && key === null)
      return { agent_id, actor_id };
    if (["inbox_read", "answer_prepare", "answer_inspect", "answer_enqueue"].includes(operation) &&
        key?.sender_id === source.sender_id && key.message_id === source.message_id)
      return { agent_id, actor_id };
    return undefined;
  };
  // Never expose the callback or accept a separate host as the policy-update target.
  const host = new AdapterHostCycle({ ...options.hostOptions, authorization });
  if (host.status(operator).owner !== "held")
    throw Error("single_source_requires_paused_owned_host");
  return Object.freeze({
    host,
    /**
     * Irreversible local denial before shutdown IO. It also fences in-flight guards
     * if durable control cannot be read/paused; it does not claim durable pause.
     * Operator cleanup remains authorized, and this composition cannot regrant.
     */
    revokePermanently(context: unknown) {
      if (context !== operator) throw Error("single_source_policy_denied");
      revoked = true;
      enabled = false;
    },
    /**
     * Owner-only synchronous fence. A busy/draining host stays paused on failure.
     * Only after committed pause and complete drain may the permission change.
     * Resume is a separate, explicitly authorized host operation, never automatic.
     */
    updateWhilePaused(context: unknown, expectedEpoch: number, allow: boolean) {
      if (context !== operator || typeof allow !== "boolean")
        throw Error("single_source_policy_denied");
      if (revoked) throw Error("single_source_authority_revoked");
      host.setPaused(operator, true, expectedEpoch);
      const state = host.status(operator);
      if (!state.paused || state.running || state.draining || state.owner !== "held")
        throw Error("single_source_host_not_drained");
      enabled = allow;
    },
  });
}
