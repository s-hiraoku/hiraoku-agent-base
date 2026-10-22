import { TaskBridgeError, identifier } from "./contract.ts";
import type {
  BridgeAuthorization,
  BridgeOperation,
  SourceKey,
} from "./contract.ts";
/** Host authority must remain synchronous and unchanged through each commit. */
export function bridgeGuard(
  authorize: BridgeAuthorization,
  context: unknown,
  operation: BridgeOperation,
  key: SourceKey,
  receiver: string,
) {
  const resolve = () => {
    try {
      const value = authorize(context, operation, Object.freeze({ ...key }));
      if (value && typeof value === "object" && "then" in value) {
        void Promise.resolve(value).catch(() => {});
        throw Error();
      }
      if (!value || value.receiver_id !== receiver) throw Error();
      return identifier.parse(value.actor_id);
    } catch {
      throw new TaskBridgeError("bridge_forbidden");
    }
  };
  const actor = resolve();
  return {
    actor,
    check: () => {
      if (resolve() !== actor) throw new TaskBridgeError("bridge_forbidden");
    },
  };
}
