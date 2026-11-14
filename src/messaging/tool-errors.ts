/**
 * Fixed public tool errors shared by the MCP server and the narrow client. Each code has a
 * fixed, secret-free explanation telling the calling agent what to change. Input mistakes have
 * their own codes; `forbidden` is only for authentication, permission and stopped access.
 */
const publicToolErrors: Readonly<Record<string, string>> = Object.freeze({
  forbidden:
    "This connection is not allowed to do this (authentication, permission or a stopped address). Changing the arguments will not help; ask the HAB operator.",
  invalid_request:
    "The arguments are not valid. Check `field` and correct that value.",
  invalid_contract:
    "The message does not follow the HAB message contract. Prefer hab_send or hab_reply, which fill the envelope for you.",
  unsupported_version: "Only message contract version 1 is supported.",
  capacity_exceeded:
    "The message or the queue is over its size limit. Send a shorter text or try again later.",
  idempotency_conflict:
    "This message_id was already used for a different message. Do not reuse message IDs.",
  invalid_reference:
    "in_reply_to does not point to a message this agent received.",
  expired_before_acceptance:
    "The message deadline had already passed. Send it again as a new message.",
  clock_skew: "first_sent_at is in the future. Check the sending clock.",
  not_found: "No such message is visible to this agent.",
  invalid_ack: "The ACK does not match a current delivery lease.",
  ack_idempotency_conflict:
    "This ACK request_id was already used for a different delivery.",
  kind_not_allowed:
    "This kind is not allowed on this host. Use one of `allowed_kinds`.",
  unknown_address:
    "No active agent with this address can receive from you. Check the address with hab_discover or ask the operator.",
  recipient_unavailable:
    "The recipient cannot receive from you (unknown, stopped or blocked).",
  reply_target_not_found:
    "No message with this message_id was received by you. Use a message_id from hab_inbox.",
  reply_target_expired:
    "The reply deadline of that message has passed. Send a new message with hab_send instead.",
  text_too_long:
    "The text is longer than this host allows. Shorten it to at most `max_bytes` UTF-8 bytes.",
});
export function isPublicToolError(code: string): boolean {
  return Object.hasOwn(publicToolErrors, code);
}
/** The fixed explanation of a public error code. */
export function explainToolError(code: string): string {
  return Object.hasOwn(publicToolErrors, code)
    ? publicToolErrors[code]
    : "The operation failed. It may or may not have taken effect; check with hab_status before retrying.";
}
