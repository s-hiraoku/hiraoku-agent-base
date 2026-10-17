/** HAB directory wire contract; no SDK, database, credentials or network imports. */
import { RelayError } from "../relay/service.ts";
import { parseHabAddress } from "./registry.ts";
export interface HabResolution {
  recipient_id: string;
  address: string;
  normalization_version: 1;
}
export interface HabDirectory {
  resolve(context: unknown, address: string): HabResolution;
}
function record(input: unknown, fields: string[]): Record<string, unknown> {
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(input))
  )
    throw Error();
  const keys = Reflect.ownKeys(input);
  if (
    keys.length !== fields.length ||
    keys.some((key) => typeof key !== "string" || !fields.includes(key))
  )
    throw Error();
  for (const key of fields) {
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable)
      throw Error();
  }
  return input as Record<string, unknown>;
}
export function parseHabResolveInput(input: unknown): { address: string } {
  try {
    return {
      address: parseHabAddress(record(input, ["address"]).address).address,
    };
  } catch {
    throw new RelayError("invalid_request");
  }
}
export function parseHabResolution(
  input: unknown,
  expectedAddress: string,
): HabResolution {
  try {
    const value = record(input, [
      "recipient_id",
      "address",
      "normalization_version",
    ]);
    if (
      typeof value.recipient_id !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$(?![\s\S])/.test(
        value.recipient_id,
      ) ||
      value.normalization_version !== 1 ||
      parseHabAddress(value.address).address !== expectedAddress
    )
      throw Error();
    return {
      recipient_id: value.recipient_id,
      address: expectedAddress,
      normalization_version: 1,
    };
  } catch {
    throw new RelayError("relay_transport_failed");
  }
}
