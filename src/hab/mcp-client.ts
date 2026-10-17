/** Fixed HAB directory client using the same bounded Relay transport/admission. */
import { RelayMcpClient } from "../relay/mcp-client.ts";
import { parseHabResolveInput, parseHabResolution } from "./directory.ts";
import type { HabResolution } from "./directory.ts";
export class HabMcpClient extends RelayMcpClient {
  async resolve(address: string): Promise<HabResolution> {
    const input = parseHabResolveInput({ address });
    return parseHabResolution(
      await this.requestTool("relay_resolve", input),
      input.address,
    );
  }
}
