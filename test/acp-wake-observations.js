/** Synthetic fixture observations only, not a native admission or durability journal. */
import { writeFileSync, renameSync } from "node:fs";

export function publishWakeObservations(path, events, write = writeFileSync) {
  // One writer owns this private directory. Readers keep the previous whole snapshot
  // until same-directory rename publishes the next whole snapshot.
  const staged = `${path}.next`;
  write(staged, JSON.stringify({ events }), { mode: 0o600 });
  renameSync(staged, path);
}
