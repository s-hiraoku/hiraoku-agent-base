/** Optional HAB upload policy. No MCP tools, maintenance privilege, routes or credentials. */
import { AttachmentUploadService } from "../relay/attachments.ts";
import type { AttachmentUploadStore } from "../relay/attachments.ts";
import type { SQLiteHabRegistry } from "./sqlite-registry.ts";

export class HabAttachmentUploads {
  readonly #registry: SQLiteHabRegistry;
  readonly #store: AttachmentUploadStore;
  readonly #limits: { max_attachment_bytes: number; chunk_bytes: number };
  constructor(
    registry: SQLiteHabRegistry,
    store: AttachmentUploadStore,
    limits: { max_attachment_bytes: number; chunk_bytes: number },
  ) {
    // Validate copied host policy before accepting any request. This creates no store or listener.
    new AttachmentUploadService(store, limits);
    this.#registry = registry;
    this.#store = store;
    this.#limits = Object.freeze({ ...limits });
  }
  #with<T>(
    context: unknown,
    operation: (service: AttachmentUploadService) => T,
  ): T {
    return this.#registry.withRelay(context, "submit", (authorization) => {
      const service = new AttachmentUploadService(this.#store, this.#limits, {
        authorize(incoming, op, recipient, kind) {
          if (incoming !== context || op === "maintenance") return undefined;
          return authorization.authorize(context, "submit", recipient, kind);
        },
      });
      return operation(service);
    });
  }
  begin(context: unknown, value: unknown) {
    return this.#with(context, (s) => s.begin(context, value));
  }
  status(context: unknown, id: string) {
    return this.#with(context, (s) => s.status(context, id));
  }
  put(context: unknown, id: string, offset: number, bytes: Uint8Array) {
    return this.#with(context, (s) => s.put(context, id, offset, bytes));
  }
  finalize(context: unknown, id: string) {
    return this.#with(context, (s) => s.finalize(context, id));
  }
  cancel(context: unknown, id: string) {
    return this.#with(context, (s) => s.cancel(context, id));
  }
}
