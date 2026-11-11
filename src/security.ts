/** Audit categories and sink shared by the host HTTP and MCP entry points. */
export type AuditCategory =
  | "request"
  | "auth_denied"
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
  record(category: AuditCategory, correlation: string): void | Promise<void>;
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
