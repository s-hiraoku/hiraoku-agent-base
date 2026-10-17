/** Fixed public tool errors shared by the optional MCP server and narrow client. */
const relayMcpErrors = new Set([
  "forbidden",
  "invalid_contract",
  "unsupported_version",
  "capacity_exceeded",
  "idempotency_conflict",
  "invalid_reference",
  "attachment_store_unavailable",
  "expired_before_acceptance",
  "clock_skew",
  "not_found",
  "invalid_ack",
  "ack_idempotency_conflict",
  "invalid_request",
]);
export function isRelayMcpError(code: string): boolean {
  return relayMcpErrors.has(code);
}
