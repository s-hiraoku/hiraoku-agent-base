/** Local OAuth lifecycle signals. Never populated from a server body or received message.
 * The product owns credential storage, refresh, login and verified identity evidence.
 */
export const authenticationRecoveryReasons = Object.freeze([
  "verification_required",
  "reauthentication_required",
  "identity_mismatch",
  "participation_inactive",
  "authentication_uncertain",
] as const);
export type AuthenticationRecoveryReason =
  (typeof authenticationRecoveryReasons)[number];
const reasons = new WeakMap<object, AuthenticationRecoveryReason>();

/** Only trusted local providers construct this error. No token, response or cause is retained. */
export class AuthenticationRecoveryError extends Error {
  constructor(reason: AuthenticationRecoveryReason) {
    if (!(authenticationRecoveryReasons as readonly unknown[]).includes(reason))
      throw new Error("invalid_authentication_recovery_reason");
    super(reason);
    this.name = "AuthenticationRecoveryError";
    reasons.set(this, reason);
  }
  get code(): AuthenticationRecoveryReason {
    return reasons.get(this)!;
  }
}
/** A matching string/code from an untrusted error is deliberately insufficient. */
export function authenticationRecoveryReason(
  error: unknown,
): AuthenticationRecoveryReason | undefined {
  return error && typeof error === "object" ? reasons.get(error) : undefined;
}

export interface RecoveryIdentity {
  issuer: string;
  resource: string;
  subject: string;
  client_id: string;
  connection_id: string;
  agent_id: string;
}
const identityFields = [
  "issuer",
  "resource",
  "subject",
  "client_id",
  "connection_id",
  "agent_id",
] as const;
function identity(value: RecoveryIdentity): Readonly<RecoveryIdentity> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).length !== identityFields.length ||
    identityFields.some(
      (key) =>
        !Object.hasOwn(value, key) ||
        typeof value[key] !== "string" ||
        !value[key].length ||
        value[key].length > 2048 ||
        /[\x00-\x1f\x7f]/.test(value[key]),
    )
  )
    throw new Error("invalid_recovery_identity");
  return Object.freeze(
    Object.fromEntries(identityFields.map((key) => [key, value[key]])),
  ) as Readonly<RecoveryIdentity>;
}
export interface AuthenticationRecoveryStatus {
  readonly state: "ready" | "blocked";
  readonly reason: AuthenticationRecoveryReason | null;
  readonly revision: number;
}

/** Optional owner-local receive gate, not authentication or durable authorization.
 * Starts blocked after every process start. Only independently verified evidence of
 * the exact approved identity can reopen it. Tokens and refresh are never handled here.
 */
export class AuthenticationRecoveryGate {
  readonly #expected: Readonly<RecoveryIdentity>;
  readonly #tickets = new WeakMap<object, number>();
  #revision = 0;
  #reason: AuthenticationRecoveryReason | null = "verification_required";
  constructor(expected: RecoveryIdentity) {
    this.#expected = identity(expected);
  }
  status(): AuthenticationRecoveryStatus {
    return Object.freeze({
      state: this.#reason === null ? "ready" : "blocked",
      reason: this.#reason,
      revision: this.#revision,
    });
  }
  #advance() {
    if (this.#revision === Number.MAX_SAFE_INTEGER) {
      this.#reason = "authentication_uncertain";
      throw new Error("authentication_recovery_exhausted");
    }
    this.#revision++;
  }
  block(reason: AuthenticationRecoveryReason): AuthenticationRecoveryError {
    const error = new AuthenticationRecoveryError(reason);
    this.#advance();
    this.#reason = reason;
    return error;
  }
  /** Call from the trusted owner after native work has settled, never from an MCP tool.
   * This only starts evidence checking; it does not perform login, refresh or network IO.
   */
  beginVerification(): object {
    this.block("verification_required");
    const ticket = Object.freeze({});
    this.#tickets.set(ticket, this.#revision);
    return ticket;
  }
  /** Evidence must come from signature/claim validation AND the existing HAB identity check.
   * A file change, tools/list, decoded JWT or successful login is not sufficient evidence.
   */
  confirmVerified(ticket: object, verified: RecoveryIdentity): boolean {
    const revision = this.#tickets.get(ticket);
    this.#tickets.delete(ticket);
    if (revision === undefined || revision !== this.#revision) return false;
    let candidate: Readonly<RecoveryIdentity>;
    try {
      candidate = identity(verified);
    } catch {
      this.block("identity_mismatch");
      return false;
    }
    if (identityFields.some((key) => candidate[key] !== this.#expected[key])) {
      this.block("identity_mismatch");
      return false;
    }
    this.#advance();
    this.#reason = null;
    return true;
  }
  assertReady(): void {
    if (this.#reason !== null)
      throw new AuthenticationRecoveryError(this.#reason);
  }
}
