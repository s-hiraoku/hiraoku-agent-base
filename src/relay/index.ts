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
export { DurableReceiver } from "./receiver.ts";
export type {
  ReceiverTransport,
  ReceiverStore,
  InboxEntry,
} from "./receiver.ts";
export { DurableSender } from "./sender.ts";
export type {
  SenderTransport,
  SenderStore,
  SendJob,
  OutboxRecord,
  OutboxState,
} from "./sender.ts";

export {
  RECORD_RETENTION_MS,
  MAX_ACK_RETRY_MS,
  makeReplayBoundMessageId,
  isReplayBoundMessageId,
} from "./contract.ts";
export type { MaintenanceResult, MaintenanceStore } from "./service.ts";
