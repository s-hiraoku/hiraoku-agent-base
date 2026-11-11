/** Shared local identifier and guard checks for agent-side durable stores. */
import { z } from "zod";
/** An error with a fixed, non-secret code. */
export class GuardError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.code = code;
  }
}
export const id = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$(?![\s\S])/);
/** Runs a synchronous guard; a missing or asynchronous guard is refused. */
export function checkGuard(guard: () => void) {
  if (typeof guard !== "function") throw new GuardError("reply_forbidden");
  const result: unknown = guard();
  if (result && typeof result === "object" && "then" in result) {
    void Promise.resolve(result).catch(() => {});
    throw new GuardError("reply_forbidden");
  }
}
