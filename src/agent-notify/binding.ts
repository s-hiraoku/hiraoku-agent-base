/** Product-neutral identity of one connection, recipient and existing conversation. */
import { createHash } from "node:crypto";

export interface AgentBinding {
  product: string;
  /** Authenticated backend/connection identity, including any account scope. */
  connection_id: string;
  recipient_id: string;
  session_id: string;
  profile?: string;
}

/** Fixed tuple encoding avoids delimiter collisions; changing any boundary requires rebind. */
export function bindingIdentity(binding: AgentBinding): string {
  const values = [
    binding.product,
    binding.connection_id,
    binding.recipient_id,
    binding.session_id,
    binding.profile ?? null,
  ];
  if (
    values
      .slice(0, 4)
      .some((value) => typeof value !== "string" || !value.length) ||
    (binding.profile !== undefined && !binding.profile.length)
  )
    throw new Error("invalid_agent_binding");
  return (
    "agent-binding-v1:" +
    createHash("sha256").update(JSON.stringify(values)).digest("hex")
  );
}
