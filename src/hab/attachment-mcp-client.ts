/** Optional HAB directory and attachment tools share one bounded transport admission. */
import { AttachmentMcpClient } from "../relay/attachment-mcp-client.ts";
import { parseHabResolveInput, parseHabResolution } from "./directory.ts";
import type { HabResolution } from "./directory.ts";
export class HabAttachmentMcpClient extends AttachmentMcpClient {
  async resolve(address: string): Promise<HabResolution> {
    const input = parseHabResolveInput({ address });
    return parseHabResolution(
      await this.requestTool("relay_resolve", input),
      input.address,
    );
  }
}
