/** Local sender contract. No credentials, network, product integration or automatic retries. */
import type { UploadIntent, UploadReceipt } from "./attachments.ts";
export type UploadJournalState =
  | "preparing"
  | "queued"
  | "running"
  | "finalized"
  | "quarantined"
  | "expired"
  | "released";
export interface UploadJournalSnapshot {
  request_id: string;
  message_id: string;
  recipient_id: string;
  expires_at: string;
  state: UploadJournalState;
  source_bytes: number;
  source_retained: boolean;
  attachment_id: string | null;
  next_offset: number;
  attempts: number;
  total_attempts: number;
  reason: string | null;
  receipt: UploadReceipt | null;
}
export interface UploadJournalJob {
  request_id: string;
  fence: number;
  lease_until: string;
  operation: "begin" | "put" | "finalize";
  intent: UploadIntent;
  attachment_id: string | null;
  offset: number;
  data: Uint8Array | null;
}
export type UploadJournalFailure =
  "transport" | "forbidden" | "invalid_receipt" | "remote_conflict";
export interface UploadJournalStore {
  claim(): UploadJournalJob | null;
  accept(job: UploadJournalJob, receipt: UploadReceipt): UploadJournalSnapshot;
  fail(job: UploadJournalJob, reason: UploadJournalFailure): void;
}
export interface UploadJournalSources {
  prepare(intent: UploadIntent): UploadJournalSnapshot;
  putSource(
    requestId: string,
    offset: number,
    bytes: Uint8Array,
  ): UploadJournalSnapshot;
  seal(requestId: string): UploadJournalSnapshot;
  status(requestId: string): UploadJournalSnapshot;
  /** Trusted local synchronous capability for later durable message handoff. */
  withFinalized<T>(requestId: string, action: (receipt: UploadReceipt) => T): T;
  release(requestId: string): boolean;
  maintain(limit: number): { expired: number; purged: number };
}
