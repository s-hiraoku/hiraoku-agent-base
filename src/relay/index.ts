/** Public entry point for the standalone Relay contract. Importing performs no IO. */
export {
  RELAY_VERSION,
  DELIVERY_TTL_MS,
  ContractError,
  validateLimits,
  parseSubmission,
  comparisonMaterial,
  parseAck,
} from "./contract.ts";
export type {
  Json,
  Part,
  Submission,
  ContractLimits,
  AckRequest,
} from "./contract.ts";

export { RelayService, RelayError } from "./service.ts";
export type {
  Receipt,
  Authorization,
  AcceptanceStore,
  Acceptance,
  ReceiptQuery,
} from "./service.ts";

export type {
  Delivery,
  AckReceipt,
  ReceiveAuthorization,
  DeliveryStore,
} from "./service.ts";
