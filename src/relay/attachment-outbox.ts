/** Optional trusted local admission capability. No network, authentication or task routing. */
import type { ContractLimits, Submission } from "./contract.ts";
export interface AttachmentOutboxAdmission {
  /** Check retained complete sources before a new durable message handoff. */
  withReady<T>(
    ownerId: string,
    message: Submission,
    limits: ContractLimits,
    action: () => T,
  ): T;
  /** Hold the journal guard before the outbox guard; checker is synchronous and scoped. */
  withClaim<T>(
    ownerId: string,
    limits: ContractLimits,
    action: (check: (message: Submission) => void) => T,
  ): T;
}
