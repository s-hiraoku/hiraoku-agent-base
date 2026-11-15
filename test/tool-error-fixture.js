import { explainToolError } from "../src/messaging/tool-errors.ts";
/** The public tool error a caller sees: the code, its fixed explanation and safe details. */
export const publicError = (code, details = {}) => ({
  error: code,
  message: explainToolError(code),
  ...details,
});
