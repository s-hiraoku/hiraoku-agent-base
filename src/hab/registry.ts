/** HAB naming/administration contract. Relay core never imports this module. */
export const ADDRESS_NORMALIZATION_VERSION = 1 as const;
export class RegistryError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.name = "RegistryError";
    this.code = code;
  }
}
export const relayOperations = [
  "submit",
  "status",
  "poll",
  "ack",
  "resolve",
] as const;
export type AgentOperation = (typeof relayOperations)[number];
export type AgentState =
  "waiting_connection" | "active" | "stopped" | "retired";
export interface ProductRecord {
  product_id: string;
  agent_name: string;
  created_at: string;
}
export interface AgentRecord {
  agent_id: string;
  product_id: string;
  agent_name: string;
  bot_name: string;
  address: string;
  normalization_version: 1;
  state: AgentState;
  epoch: number;
  operations: AgentOperation[];
  created_at: string;
}
/** Non-secret claims attested by the host; no field is accepted from MCP arguments. */
export interface IndividualPrincipal {
  issuer: string;
  audience: string;
  subject: string;
  client_id: string;
  connection_id: string;
}
export interface VerifiedIndividual {
  principal: IndividualPrincipal;
  expires_at: string;
}
export interface BindingRecord {
  binding_id: string;
  agent_id: string;
  state: "active" | "revoked";
  created_at: string;
  revoked_at: string | null;
  agent_epoch: number;
}
export type AdminOperation =
  | "preview"
  | "inspect"
  | "product"
  | "enroll"
  | "bind"
  | "revoke"
  | "access"
  | "block"
  | "emergency_stop";
export interface RegistryAuthority {
  /** Separate host-owned management authority. Default is deny. Synchronous/current. */
  administrator?(
    context: unknown,
    operation: AdminOperation,
  ): { actor_id: string } | undefined;
  /** Host has actually authenticated a specific individual, not just its owner. */
  individual?(context: unknown): VerifiedIndividual | undefined;
}
const slugExpression = "[a-z0-9](?:[a-z0-9-]{0,46}[a-z0-9])?";
// JavaScript $ alone also matches before a final line terminator.
const endOfInput = "$(?![\\s\\S])";
export const HAB_ADDRESS_PATTERN = `^${slugExpression}@${slugExpression}\\.hab${endOfInput}`;
const slugPattern = new RegExp(`^${slugExpression}${endOfInput}`);
export function habSlug(value: unknown): string {
  if (typeof value !== "string" || !slugPattern.test(value))
    throw new RegistryError("invalid_registry_request");
  return value;
}
export function habAddress(botName: unknown, agentName: unknown): string {
  return `${habSlug(botName)}@${habSlug(agentName)}.hab`;
}
export function parseHabAddress(value: unknown): {
  bot_name: string;
  agent_name: string;
  address: string;
  normalization_version: 1;
} {
  if (typeof value !== "string" || value.length > 101)
    throw new RegistryError("invalid_registry_request");
  const match = /^([^@]+)@([^@]+)\.hab$/.exec(value);
  if (!match || habAddress(match[1], match[2]) !== value)
    throw new RegistryError("invalid_registry_request");
  return {
    bot_name: match[1],
    agent_name: match[2],
    address: value,
    normalization_version: ADDRESS_NORMALIZATION_VERSION,
  };
}
