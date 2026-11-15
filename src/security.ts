/** Audit categories and sink shared by the host HTTP and MCP entry points. */
export type AuditCategory =
  | "request"
  | "auth_denied"
  | "authenticated"
  | "access_denied"
  | "rate_limited"
  | "resource_rejected"
  | "tool_started"
  | "tool_succeeded"
  | "tool_error"
  | "transport_error"
  | "anomaly"
  | "aggregate";
export interface AuditSink {
  /**
   * `reason` is a fixed refusal code (`/^[a-z][a-z0-9_]{0,47}$/`), never a body or secret.
   * It comes with `tool_error` and `auth_denied` (why a credential was refused). With
   * `authenticated` it is instead the operator-registered connection ID
   * (`/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/`), never a token, claim, subject or client ID.
   */
  record(
    category: AuditCategory,
    correlation: string,
    reason?: string,
  ): void | Promise<void>;
  check?(): void;
  note?(category: AuditCategory): void;
}
export type ToolFinish = (
  outcome: "tool_succeeded" | "tool_error",
) => Promise<void>;
export interface SecurityContext {
  correlation: string;
  beginTool(): Promise<ToolFinish>;
  record(category: AuditCategory): Promise<void>;
}
