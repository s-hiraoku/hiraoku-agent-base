/** The arrival notifier (ADR-021). Importing performs no IO. */
export { ReceiptNotifier } from "./notifier.ts";
export type { AutoAccept, DecisionResult } from "./notifier.ts";
export {
  AutoAcceptPolicy,
  AutoAudit,
  autoAcceptConfigSchema,
  autoHandoffPrompt,
} from "./auto-accept.ts";
export type { AutoAcceptConfig, AutoAuditEvent } from "./auto-accept.ts";
export { SQLiteNotices, NOTICE_RETENTION_MS } from "./sqlite-notices.ts";
export { HabNotifierClient } from "./hab-client.ts";
export { JsonlScreen } from "./jsonl-screen.ts";
export {
  HermesDesktopScreen,
  hermesDesktopPage,
  hermesDesktopTarget,
  submissionId,
  fitHermesText,
  HERMES_TEXT_BYTES,
} from "./hermes-desktop.ts";
export type { HermesDesktopBinding } from "./hermes-desktop.ts";
export { ProductScreen } from "./product-screen.ts";
export type { ProductScreenOptions } from "./product-screen.ts";
export { runCommand } from "./command.ts";
export type { TrustedCommand } from "./command.ts";
export {
  codexHandoff,
  codexQueueHandoff,
  codexTarget,
  execArgv,
  websocketConnect,
} from "./codex.ts";
export type {
  CodexAppServer,
  CodexBinding,
  RpcConnect,
  RpcConnection,
} from "./codex.ts";
export {
  antigravityHandoff,
  antigravityTarget,
  spawnAgy,
} from "./antigravity.ts";
export type {
  AgyRun,
  AntigravityBinding,
  AntigravityCli,
  SpawnAgy,
} from "./antigravity.ts";
export {
  ANTIGRAVITY_REQUEST_BYTES,
  antigravityDesktopHandoff,
  antigravityDesktopPrecheck,
  antigravityDesktopTarget,
  conversationFileProbe,
  conversationIdSchema,
  defaultConversationsDir,
  spoolPath,
  spoolProblem,
  spoolRequestSchema,
} from "./antigravity-desktop.ts";
export type {
  AntigravityDesktopBinding,
  SpoolRequest,
} from "./antigravity-desktop.ts";
export {
  AntigravityRelay,
  RELAY_DIRS,
  RELAY_KEEP_MS,
  RELAY_MAX_AGE_MS,
  agentapiCommand,
  runAgentapi,
  runRelay,
} from "./antigravity-relay.ts";
export type { RelayOptions, RunAgentapi } from "./antigravity-relay.ts";
export {
  CHANNEL_REQUEST_BYTES,
  claudeCodeHandoff,
  claudeCodeStatusLine,
  claudeCodeTarget,
} from "./claude-code.ts";
export type { ChannelRequest, ClaudeCodeBinding } from "./claude-code.ts";
export { startChannelListener } from "./claude-channel.ts";
export {
  chatgptConnectorHandoff,
  chatgptConnectorTarget,
} from "./chatgpt-connector.ts";
export type { ChatGptConnectorBinding } from "./chatgpt-connector.ts";
export { choicesOf, peekedMessageSchema } from "./contract.ts";
export type {
  AgentScreen,
  HandoffResult,
  IncomingChoice,
  NoticeRecord,
  NoticeState,
  NotifierHab,
  PeekedMessage,
} from "./contract.ts";
export { NoticeStateProjection } from "./state-sync.ts";
export type { NoticeStates, NoticeStateSnapshot } from "./state-sync.ts";

export { bindingIdentity } from "./binding.ts";
export type { AgentBinding } from "./binding.ts";
export type { PublicationResult, ScreenCapabilities } from "./contract.ts";
