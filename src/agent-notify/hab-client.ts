/**
 * NotifierHab over HTTP MCP, with the recipient's own credential: hab_peek at the delivery
 * endpoint (`/mcp/delivery`) and hab_inbox with one message_id at the agent endpoint
 * (`/mcp`) to mark a decided message read. It never calls hab_reply: answering belongs to
 * the user's own session.
 */
import { MessagingError } from "../messaging/delivery-service.ts";
import { HabMcpClient } from "../hab/mcp-client.ts";
import type { HabMcpClientOptions } from "../hab/mcp-client.ts";
import { peekResultSchema } from "./contract.ts";
import type { NotifierHab, PeekedMessage } from "./contract.ts";

class Endpoint extends HabMcpClient {
  call(tool: "hab_peek" | "hab_inbox", args: Record<string, unknown>) {
    return this.requestTool(tool, args);
  }
}

export class HabNotifierClient implements NotifierHab {
  readonly #delivery: Endpoint;
  readonly #agent: Endpoint;
  /**
   * `delivery` and `agent` share the credential and address; only `policy.resource_url`
   * differs (`…/mcp/delivery` and `…/mcp`).
   */
  constructor(delivery: HabMcpClientOptions, agent: HabMcpClientOptions) {
    this.#delivery = new Endpoint(delivery);
    this.#agent = new Endpoint(agent);
  }
  async peek(limit: number): Promise<PeekedMessage[]> {
    const parsed = peekResultSchema.safeParse(
      await this.#delivery.call("hab_peek", { limit }),
    );
    if (!parsed.success) throw new MessagingError("transport_failed");
    return parsed.data.messages;
  }
  async markRead(messageId: string): Promise<void> {
    const value = (await this.#agent.call("hab_inbox", {
      message_id: messageId,
      limit: 1,
    })) as { messages?: { message_id?: unknown }[] };
    // An empty result means it is gone (expired or past the 7-day re-read window), which is
    // as read as it will get; anything else must be the message asked for.
    const ids = (value.messages ?? []).map((message) => message.message_id);
    if (ids.length > 1 || (ids.length === 1 && ids[0] !== messageId))
      throw new MessagingError("transport_failed");
  }
}
