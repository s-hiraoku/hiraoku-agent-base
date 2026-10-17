/** Optional HAB receiver reads. No new tools, receiver journal, ACK or credentials. */
import { AttachmentReadService } from "../relay/attachment-read.ts";
import type {
  AttachmentReadRelay,
  AttachmentChunkStore,
} from "../relay/attachment-read.ts";
import type { ContractLimits } from "../relay/contract.ts";
import type { SQLiteHabRegistry } from "./sqlite-registry.ts";

export class HabAttachmentRead {
  readonly #registry: SQLiteHabRegistry;
  readonly #relay: AttachmentReadRelay;
  readonly #blobs: AttachmentChunkStore;
  readonly #limits: ContractLimits;
  constructor(
    registry: SQLiteHabRegistry,
    relay: AttachmentReadRelay,
    blobs: AttachmentChunkStore,
    limits: ContractLimits,
  ) {
    this.#registry = registry;
    this.#relay = relay;
    this.#blobs = blobs;
    this.#limits = Object.freeze({ ...limits });
  }
  read(context: unknown, input: unknown) {
    return this.#registry.withRelay(context, "poll", (authorization) =>
      new AttachmentReadService(
        this.#relay,
        this.#blobs,
        this.#limits,
        authorization,
      ).read(context, input),
    );
  }
}
