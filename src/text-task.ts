import { z } from "zod";
import type { Principal } from "./types.ts";
const identifier = z.string().min(1).max(200);
export const boundedText = z
  .string()
  .min(1)
  .refine((text) => new TextEncoder().encode(text).length <= 32768);
export const textBindingSchema = z.strictObject({
  ownerScope: identifier,
  senderAgent: identifier,
  recipientAgent: identifier,
  recipientOwner: identifier,
  conversationBinding: identifier,
});
export const textInputSchema = z.strictObject({
  messageId: identifier,
  contextId: identifier,
  text: boundedText,
  workDeadline: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
});
export type TextBinding = z.infer<typeof textBindingSchema>;
export type TextInput = z.infer<typeof textInputSchema>;
export const storedTextSchema = z.strictObject({
  version: z.literal(1),
  acceptedAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  owner: identifier,
  ownerClient: identifier,
  binding: textBindingSchema,
  input: textInputSchema,
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
});
export type StoredTextRequest = z.infer<typeof storedTextSchema>;
export const textBoundarySchema = z.strictObject({
  version: z.literal(1),
  inputAuthority: z.literal("external_agent"),
  effects: z.literal("none"),
  automaticReply: z.literal(false),
});
export type TextBoundary = z.infer<typeof textBoundarySchema>;
export function textBinding(p: Principal): TextBinding {
  if (
    !p.clientId ||
    p.clientId.length > 200 ||
    !p.taskTypes?.includes("generic_text")
  )
    throw Error("text_binding_required");
  return textBindingSchema.parse(p.textBinding);
}
export async function textDigest(value: unknown): Promise<string> {
  const hash = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify(value)),
  );
  return Array.from(new Uint8Array(hash), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
}
export function sameTextBinding(a: TextBinding, b: TextBinding): boolean {
  return (
    JSON.stringify(textBindingSchema.parse(a)) ===
    JSON.stringify(textBindingSchema.parse(b))
  );
}
