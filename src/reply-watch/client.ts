/** Fixed agent-catalog operations, using the caller's existing credential owner. */
import { z } from "zod";
import { HabMcpClient } from "../hab/mcp-client.ts";
import type { HabMcpClientOptions } from "../hab/mcp-client.ts";
import { MessagingError } from "../messaging/delivery-service.ts";

const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/);
const time = z.iso.datetime();
export const sentSchema = z.looseObject({
  message_id: id,
  accepted_at: time,
  expires_at: time,
});
export const statusSchema = sentSchema.extend({
  reply_state: z.enum(["waiting", "replied", "no_reply", "not_expected"]),
  replies: z.array(z.looseObject({ message_id: id })).max(50),
});
export type SentMessage = z.infer<typeof sentSchema>;
export type ReplyStatus = z.infer<typeof statusSchema>;
export type SendInput = {
  to: string;
  text: string;
  kind?: string;
  thread_id?: string;
};
class Endpoint extends HabMcpClient {
  protected override get distinguishAuthenticationRefusal() {
    return true;
  }
  agentCall(tool: "hab_send" | "hab_status", input: Record<string, unknown>) {
    return this.requestTool(tool, input);
  }
}
export class ReplyWatchClient {
  readonly #endpoint: Endpoint;
  readonly #ready: () => string | undefined;
  constructor(
    options: HabMcpClientOptions,
    ready = (): string | undefined => undefined,
  ) {
    if (!options.as_address) throw new MessagingError("invalid_request");
    this.#endpoint = new Endpoint(options);
    this.#ready = ready;
  }
  async #call(tool: "hab_send" | "hab_status", input: Record<string, unknown>) {
    const problem = this.#ready();
    if (problem) throw new MessagingError(problem);
    return this.#endpoint.agentCall(tool, input);
  }
  async send(input: SendInput): Promise<SentMessage> {
    return sentSchema.parse(await this.#call("hab_send", { ...input }));
  }
  async status(messageId: string): Promise<ReplyStatus> {
    id.parse(messageId);
    const result = statusSchema.parse(
      await this.#call("hab_status", { message_id: messageId }),
    );
    if (result.message_id !== messageId)
      throw new MessagingError("transport_failed");
    return result;
  }
}
