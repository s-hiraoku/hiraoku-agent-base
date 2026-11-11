/** Public entry point for the durable sender and receiver. Importing performs no IO. */
export { DurableReceiver } from "./receiver.ts";
export type {
  ReceiverTransport,
  ReceiverStore,
  InboxEntry,
  InboxLifecycleStore,
  InboxMaintenanceResult,
} from "./receiver.ts";
export { DurableSender } from "./sender.ts";
export type {
  SenderTransport,
  SenderStore,
  SendJob,
  OutboxRecord,
  OutboxState,
  OutboxMaintenanceResult,
} from "./sender.ts";

export {
  AuthenticationRecoveryError,
  AuthenticationRecoveryGate,
  authenticationRecoveryReason,
} from "./authentication-recovery.ts";
export type {
  AuthenticationRecoveryReason,
  AuthenticationRecoveryStatus,
  RecoveryIdentity,
} from "./authentication-recovery.ts";
