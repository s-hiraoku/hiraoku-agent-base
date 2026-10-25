/** Fixed HAB directory client using the same bounded Relay transport/admission. */
import { RelayMcpClient } from "../relay/mcp-client.ts";
import type { RelayMcpClientOptions } from "../relay/mcp-client.ts";
import { parseHabAddress } from "./registry.ts";
import { parseHabResolveInput, parseHabResolution } from "./directory.ts";
import type { HabResolution } from "./directory.ts";
export interface HabMcpClientOptions extends RelayMcpClientOptions {
  /** Immutable local address; added to every call, including recovery status and ACK. */
  as_address?: string;
}
export class HabMcpClient extends RelayMcpClient {
  readonly #asAddress: string | undefined;
  readonly #expectedAgentId: string;
  constructor(options: HabMcpClientOptions) {
    const address =
      options?.as_address === undefined
        ? undefined
        : parseHabAddress(options.as_address).address;
    super(options);
    this.#asAddress = address;
    this.#expectedAgentId = options.policy.agent_id;
  }
  protected override requestTool(name: string, args: Record<string, unknown>) {
    return super.requestTool(
      name,
      this.#asAddress === undefined
        ? args
        : {
            ...args,
            as_address: this.#asAddress,
            expected_agent_id: this.#expectedAgentId,
          },
    );
  }
  async resolve(address: string): Promise<HabResolution> {
    const input = parseHabResolveInput({ address });
    return parseHabResolution(
      await this.requestTool("relay_resolve", input),
      input.address,
    );
  }
}
