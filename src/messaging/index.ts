/** Public entry point for the backend-neutral messaging contract. Importing performs no IO. */
export {
  CONTRACT_VERSION,
  DELIVERY_TTL_MS,
  MAX_DELIVERY_TTL_MS,
  READ_BODY_RETENTION_MS,
  RECORD_RETENTION_MS,
  MAX_ACK_RETRY_MS,
  ContractError,
  validateLimits,
  parseSubmission,
  comparisonMaterial,
  parseAck,
  makeReplayBoundMessageId,
  isReplayBoundMessageId,
  replayBoundSentAt,
} from "./contract.ts";
export type {
  Json,
  Part,
  Submission,
  ContractLimits,
  AckRequest,
} from "./contract.ts";
export { MessagingError, denied } from "./delivery-service.ts";
export type {
  Receipt,
  Authorization,
  DeliveryService,
  Delivery,
  AckReceipt,
} from "./delivery-service.ts";
export { formatIncomingNotice } from "./incoming-notice.ts";
export type { IncomingNoticeInput } from "./incoming-notice.ts";
