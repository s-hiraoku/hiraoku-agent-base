/**
 * NotifierHab over HTTP MCP at the delivery endpoint (`/mcp/delivery`), with the
 * recipient's own credential: hab_peek to list unread mail and hab_mark_read to mark a
 * decided message read by (sender_id, message_id). It never calls hab_reply: answering
 * belongs to the user's own session.
 */
import { MessagingError } from "../messaging/delivery-service.ts";
import { HabMcpClient } from "../hab/mcp-client.ts";
import type { HabMcpClientOptions } from "../hab/mcp-client.ts";
import { peekResultSchema } from "./contract.ts";
import type { NotifierHab, PeekPage } from "./contract.ts";

class Endpoint extends HabMcpClient {
  call(tool: "hab_peek" | "hab_mark_read", args: Record<string, unknown>) {
    return this.requestTool(tool, args);
  }
}

export class HabNotifierClient implements NotifierHab {
  readonly #delivery: Endpoint;
  /** `delivery.policy.resource_url` is the delivery endpoint, such as `…/mcp/delivery`. */
  constructor(delivery: HabMcpClientOptions) {
    this.#delivery = new Endpoint(delivery);
  }
  async peek(limit: number, after?: string): Promise<PeekPage> {
    const parsed = peekResultSchema.safeParse(
      await this.#delivery.call("hab_peek", {
        limit,
        ...(after !== undefined ? { after } : {}),
      }),
    );
    if (!parsed.success) throw new MessagingError("transport_failed");
    return parsed.data;
  }
  async markRead(messageId: string, senderId: string): Promise<boolean> {
    const value = (await this.#delivery.call("hab_mark_read", {
      sender_id: senderId,
      message_id: messageId,
    })) as { sender_id?: unknown; message_id?: unknown; read?: unknown };
    // read: false means HAB no longer offers it to this recipient (expired, past the 7-day
    // re-read window, or no longer authorized); anything else must name the message asked for.
    if (
      value.sender_id !== senderId ||
      value.message_id !== messageId ||
      typeof value.read !== "boolean"
    )
      throw new MessagingError("transport_failed");
    return value.read;
  }
}
