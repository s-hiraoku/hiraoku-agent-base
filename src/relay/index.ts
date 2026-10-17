/** Public entry point for the standalone Relay contract. Importing performs no IO. */
export {
  RELAY_VERSION,
  DELIVERY_TTL_MS,
  ContractError,
  validateLimits,
  parseSubmission,
  comparisonMaterial,
} from "./contract.ts";
export type { Json, Part, Submission, ContractLimits } from "./contract.ts";

export { RelayService, RelayError } from "./service.ts";
export type {
  Receipt,
  Authorization,
  AcceptanceStore,
  Acceptance,
  ReceiptQuery,
} from "./service.ts";
