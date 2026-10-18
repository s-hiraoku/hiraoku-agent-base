/** Finite host-invoked staging: one read per call, no polling loop or delivery ACK. */
import { parseAttachmentMessage } from "./attachment-bindings.ts";
import type { ContractLimits } from "./contract.ts";
import type {
  AttachmentChunk,
  AttachmentReadRequest,
} from "./attachment-read.ts";
import type {
  AttachmentInboxStore,
  AttachmentInboxSnapshot,
} from "./attachment-inbox.ts";
import { RelayError } from "./service.ts";
export interface AttachmentReadTransport {
  read(request: AttachmentReadRequest): Promise<AttachmentChunk>;
}
export class AttachmentStager {
  readonly #store: AttachmentInboxStore;
  readonly #transport: AttachmentReadTransport;
  readonly #limits: ContractLimits;
  #running = false;
  constructor(
    store: AttachmentInboxStore,
    transport: AttachmentReadTransport,
    limits: ContractLimits,
  ) {
    this.#store = store;
    this.#transport = transport;
    this.#limits = Object.freeze({ ...limits });
  }
  async stageOnce(
    sender: string,
    input: unknown,
  ): Promise<AttachmentInboxSnapshot> {
    if (this.#running) throw new RelayError("attachment_stager_busy");
    this.#running = true;
    try {
      const message = parseAttachmentMessage(input, this.#limits);
      let snapshot = this.#store.prepare(sender, message);
      if (!["receiving", "verified"].includes(snapshot.state))
        throw new RelayError("attachment_inbox_closed");
      const next = snapshot.files.find((f) => f.next_offset < f.size_bytes);
      if (next) {
        let chunk: AttachmentChunk;
        try {
          chunk = await this.#transport.read({
            version: 1,
            sender_id: sender,
            message_id: message.message_id,
            attachment_id: next.attachment_id,
            offset: next.next_offset,
          });
        } catch (error) {
          if (
            error instanceof RelayError &&
            [
              "forbidden",
              "attachment_read_not_found",
              "attachment_integrity_failed",
            ].includes(error.code)
          )
            throw error;
          throw new RelayError("attachment_read_transport_failed");
        }
        if (
          !chunk ||
          typeof chunk !== "object" ||
          Object.getOwnPropertyDescriptor(chunk, "attachment_id")?.value !==
            next.attachment_id ||
          Object.getOwnPropertyDescriptor(chunk, "offset")?.value !==
            next.next_offset
        )
          throw new RelayError("invalid_attachment_chunk");
        snapshot = this.#store.put(sender, message.message_id, chunk);
      }
      if (snapshot.files.every((f) => f.next_offset === f.size_bytes)) {
        snapshot = this.#store.verify(sender, message.message_id);
        if (snapshot.state !== "verified")
          throw new RelayError("attachment_staging_rejected");
      }
      return snapshot;
    } finally {
      this.#running = false;
    }
  }
}
