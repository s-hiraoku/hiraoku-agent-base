/** Durable local checkpoint for a single finite receiver. Full delivery stays private. */
import type { Delivery } from "./service.ts";
export type ReceiveFailure =
  "transport" | "forbidden" | "integrity" | "delivery_changed" | "local_store";
export interface ReceiveJob {
  fence: number;
  lease_until: string;
  delivery: Delivery | null;
}
export interface ReceiveCheckpoint {
  claim(): ReceiveJob | null;
  save(job: ReceiveJob, delivery: Delivery): void;
  release(job: ReceiveJob): void;
  complete(job: ReceiveJob): void;
  fail(job: ReceiveJob, reason: ReceiveFailure): void;
}
