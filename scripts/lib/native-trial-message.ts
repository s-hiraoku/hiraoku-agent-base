import { randomBytes } from "node:crypto";
import { Buffer } from "node:buffer";
import { z } from "zod";
import {
  DELIVERY_TTL_MS,
  makeReplayBoundMessageId,
  parseSubmission,
  type ContractLimits,
  type Submission,
} from "../../src/messaging/contract.ts";

const template = z.strictObject({
  recipient_id: z.string(),
  kind: z.string(),
  body: z.unknown(),
  thread_id: z.string(),
  in_reply_to: z.union([
    z.null(),
    z.strictObject({ sender_id: z.string(), message_id: z.string() }),
  ]),
});

/** Prepare a new intent only. Saved submissions must be checked, never repaired. */
export function prepareNativeTrialMessage(
  input: unknown,
  limits: ContractLimits,
  dependencies: { now?: () => number; entropy?: () => string } = {},
): Submission {
  const content = template.parse(input);
  const firstSentAt = new Date((dependencies.now ?? Date.now)()).toISOString();
  const entropy = (
    dependencies.entropy ?? (() => Buffer.from(randomBytes(16)).toString("hex"))
  )();
  return parseSubmission(
    {
      ...content,
      version: 1,
      message_id: makeReplayBoundMessageId(firstSentAt, entropy),
      first_sent_at: firstSentAt,
      expires_at: new Date(
        Date.parse(firstSentAt) + DELIVERY_TTL_MS,
      ).toISOString(),
    },
    limits,
  );
}

/** Offline check of the exact saved submission; no identity or send authority. */
export function checkNativeTrialMessage(
  input: unknown,
  limits: ContractLimits,
  now: () => number = Date.now,
): Submission {
  const message = parseSubmission(input, limits);
  if (Date.parse(message.expires_at) <= now())
    throw Error("trial_message_expired");
  return message;
}
