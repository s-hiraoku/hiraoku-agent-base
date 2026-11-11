/** Bounded, discarded ACP v1 text/tool progress. Never native authority or model input. */
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
export const acpText = (value: unknown, max: number): value is string =>
  typeof value === "string" && Buffer.byteLength(value) <= max && Buffer.from(value).toString("utf8") === value;
const member = (value: unknown, values: readonly string[]) => typeof value === "string" && values.includes(value);
const optional = (value: unknown, check: (value: unknown) => boolean) => value === undefined || value === null || check(value);
const string = (value: unknown) => acpText(value, 65536);
const list = (value: unknown, check: (value: unknown) => boolean) => Array.isArray(value) && value.length <= 256 && value.every(check);
const textContent = (value: unknown) => record(value) && value.type === "text" && string(value.text);
const kind = (value: unknown) => member(value, ["read", "edit", "delete", "move", "search", "execute", "think", "fetch", "switch_mode", "other"]);
const status = (value: unknown) => member(value, ["pending", "in_progress", "completed", "failed"]);

/** Also checks escaped lone surrogates, nesting and object/array breadth after JSON decoding. */
function boundedJson(value: unknown): void {
  let nodes = 0;
  function visit(current: unknown, depth: number): void {
    if (++nodes > 4096 || depth > 16) throw Error("acp_invalid_update");
    if (typeof current === "string") {
      if (!string(current)) throw Error("acp_invalid_update");
    } else if (Array.isArray(current)) {
      if (current.length > 256) throw Error("acp_invalid_update");
      current.forEach(item => visit(item, depth + 1));
    } else if (record(current)) {
      const entries = Object.entries(current);
      if (entries.length > 256) throw Error("acp_invalid_update");
      for (const [key, item] of entries) {
        if (!acpText(key, 256)) throw Error("acp_invalid_update");
        visit(item, depth + 1);
      }
    } else if (current !== null && typeof current !== "boolean" &&
        !(typeof current === "number" && Number.isFinite(current))) throw Error("acp_invalid_update");
  }
  visit(value, 0);
}

/** Supported standard subset; other variants/content types fail closed, never silently execute. */
export function validateAcpUpdate(params: Record<string, unknown>, active: boolean): string {
  boundedJson(params);
  if (!acpText(params.sessionId, 512) || params.sessionId.length < 1 || !record(params.update))
    throw Error("acp_invalid_update");
  const u = params.update;
  let valid = false;
  if (u.sessionUpdate === "available_commands_update") {
    valid = list(u.availableCommands, item => record(item) && string(item.name) && string(item.description) &&
      optional(item.input, input => record(input) && string(input.hint)));
  } else if (u.sessionUpdate === "current_mode_update") {
    valid = string(u.currentModeId);
  } else if (active && member(u.sessionUpdate, ["user_message_chunk", "agent_message_chunk", "agent_thought_chunk"])) {
    valid = textContent(u.content);
  } else if (active && member(u.sessionUpdate, ["tool_call", "tool_call_update"])) {
    valid = string(u.toolCallId) && u.toolCallId.length > 0 &&
      (u.sessionUpdate === "tool_call" ? string(u.title) : optional(u.title, string)) &&
      optional(u.kind, kind) && optional(u.status, status) &&
      optional(u.locations, locations => list(locations, item => record(item) && string(item.path) &&
        optional(item.line, line => Number.isSafeInteger(line) && (line as number) >= 0))) &&
      optional(u.content, content => list(content, item => record(item) && (
        item.type === "content" ? textContent(item.content) :
        item.type === "diff" ? string(item.path) && optional(item.oldText, string) && string(item.newText) :
        item.type === "terminal" && string(item.terminalId))));
  } else if (active && u.sessionUpdate === "plan") {
    valid = list(u.entries, item => record(item) && string(item.content) &&
      member(item.priority, ["high", "medium", "low"]) && member(item.status, ["pending", "in_progress", "completed"]));
  }
  if (!valid) throw Error("acp_invalid_update");
  return params.sessionId;
}
