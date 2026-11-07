/** Public entry point for the backend-neutral messaging contract. Importing performs no IO. */
export {
  CONTRACT_VERSION,
  DELIVERY_TTL_MS,
  RECORD_RETENTION_MS,
  MAX_ACK_RETRY_MS,
  ContractError,
  validateLimits,
  parseSubmission,
  comparisonMaterial,
  parseAck,
  makeReplayBoundMessageId,
  isReplayBoundMessageId,
} from "./contract.ts";
export type {
  Json,
  Part,
  Submission,
  ContractLimits,
  AckRequest,
} from "./contract.ts";
export { MessagingError } from "./delivery-service.ts";
export type {
  Receipt,
  Authorization,
  DeliveryService,
  Delivery,
  AckReceipt,
} from "./delivery-service.ts";
