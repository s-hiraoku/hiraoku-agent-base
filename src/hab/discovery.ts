/** Optional read-only HAB discovery contract. No enrollment or host-session inference. */
import { z } from "zod";
import { HAB_ADDRESS_PATTERN } from "./registry.ts";

export const discoveryId = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$(?![\s\S])/);
const address = z.string().max(101).regex(new RegExp(HAB_ADDRESS_PATTERN));
export const habDiscoverySchema = z.discriminatedUnion("action", [
  z.strictObject({
    action: z.literal("whoami"),
    as_address: address.optional(),
    expected_agent_id: discoveryId.optional(),
  }),
  z.strictObject({
    action: z.literal("directory"),
    limit: z.number().int().min(1).max(100).default(25),
    cursor: z.string().min(1).max(512).optional(),
    state: z
      .enum(["waiting_connection", "active", "stopped", "retired"])
      .optional(),
    address_prefix: z
      .string()
      .max(101)
      .regex(/^[a-z0-9@.-]*$(?![\s\S])/)
      .optional(),
  }),
  z.strictObject({ action: z.literal("check_address"), address }),
]);
/** Host-owned attestation, read from durable identity storage, never tool arguments.
 * owner_reference is opaque and stable across display/profile renames. No paths or chat content.
 */
export const habHostIdentitySchema = z.strictObject({
  agent_id: discoveryId,
  address,
  owner_kind: z.enum(["session", "bot"]),
  owner_reference: discoveryId,
  binding_generation: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  observed_at: z.string(),
  expires_at: z.string(),
});
export type HabHostIdentity = z.infer<typeof habHostIdentitySchema>;
export const habDiscoveryPolicySchema = z.strictObject({
  availability_namespaces: z
    .array(z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,46}[a-z0-9])?$(?![\s\S])/))
    .max(100),
});
export interface HabDiscoveryPolicy {
  /** Explicit permission to reveal only occupancy for exact candidates in these namespaces.
   * Directory visibility remains restricted to the verified binding/group.
   */
  availability_namespaces: readonly string[];
}
export interface HabDiscoveryService {
  readonly discoveryEnabled?: boolean;
  discover?(context: unknown, input: unknown): unknown;
}
