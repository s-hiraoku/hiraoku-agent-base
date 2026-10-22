/** Receiver-side automatic-reply policy. No dependency on HAB or Task execution. */
import { z } from "zod";
import type { Submission } from "../relay/contract.ts";
export class ReplyBudgetError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.code = code;
  }
}
export const id = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$(?![\s\S])/);
export const sourceKey = z.strictObject({ sender_id: id, message_id: id });
export const sourceSchema = z.strictObject({
  sender_id: id,
  message_id: id,
  recipient_id: id,
  thread_id: id,
  kind: id,
});
export type ReplySource = z.infer<typeof sourceSchema>;
export type ReplySourceKey = z.infer<typeof sourceKey>;
export const replyKind = z.enum([
  "answer",
  "execution_accepted",
  "execution_result",
]);
export type AutomaticReplyKind = z.infer<typeof replyKind>;
/** Trusted host port, not a wire API or authentication mechanism. */
export interface ReplyAdmission {
  readonly agentId: string;
  withReply<T>(
    source: ReplySource,
    message: Submission,
    guard: () => void,
    action: () => T,
  ): T;
}
export type ReplyAuthorization = (
  context: unknown,
  source: ReplySourceKey,
) => { agent_id: string; actor_id: string } | undefined;
export function authorizationGuard(
  authorize: ReplyAuthorization,
  context: unknown,
  source: ReplySourceKey,
  agentId: string,
) {
  const resolve = () => {
    try {
      const v = authorize(context, Object.freeze({ ...source }));
      if (v && typeof v === "object" && "then" in v) {
        void Promise.resolve(v).catch(() => {});
        throw Error();
      }
      if (!v || v.agent_id !== agentId) throw Error();
      return id.parse(v.actor_id);
    } catch {
      throw new ReplyBudgetError("reply_forbidden");
    }
  };
  const actor = resolve();
  return () => {
    if (resolve() !== actor) throw new ReplyBudgetError("reply_forbidden");
  };
}
export function checkGuard(guard: () => void) {
  if (typeof guard !== "function")
    throw new ReplyBudgetError("reply_forbidden");
  const result: unknown = guard();
  if (result && typeof result === "object" && "then" in result) {
    void Promise.resolve(result).catch(() => {});
    throw new ReplyBudgetError("reply_forbidden");
  }
}
