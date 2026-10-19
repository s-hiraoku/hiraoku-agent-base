/** Explicit trusted-host delivery admission; not a caller-selected flag. */
import type { ContractLimits } from "./contract.ts";
import type { Acceptance, Receipt } from "./service.ts";
export interface AttachmentDeliveryPolicy {
  limits: ContractLimits;
  check(acceptance: Acceptance, receipt: Receipt): void;
}
