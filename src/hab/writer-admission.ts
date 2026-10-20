/** Optional synchronous identity port; no scoped authorization escapes its registry guard. */
import type { SQLiteHabRegistry } from "./sqlite-registry.ts";
import type { WriterIdentity } from "../relay/writer-admission.ts";
export function habWriterIdentity(registry: SQLiteHabRegistry): WriterIdentity {
  return (context, operation) =>
    registry.withRelay(context, operation, (_authorization, id) => id);
}
