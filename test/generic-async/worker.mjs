import { join } from "node:path";
import process from "node:process";
import { Hub } from "../../src/sqlite.ts";
import { Adapter } from "../../src/adapter.ts";
import { Journal } from "../../src/journal.ts";
import { identities, SyntheticTextRuns } from "./fixtures.js";

const [root, product, mode] = process.argv.slice(2);
process.umask(0o077);
const hub = new Hub(join(root, "hub.db"));
const journal = new Journal(join(root, "journal.db"));
const runs = new SyntheticTextRuns(join(root, "runs.db"), product, mode);
try {
  const id = await new Adapter(
    hub,
    identities(product).worker,
    runs,
    journal,
  ).once();
  process.stdout.write(
    JSON.stringify({ id, admissions: runs.count(), receipt: journal.load() }),
  );
} catch (error) {
  if (
    mode !== "lose-response" ||
    error.message !== "synthetic_admission_response_lost"
  )
    throw error;
  process.stdout.write(
    JSON.stringify({
      expectedFailure: error.message,
      admissions: runs.count(),
      receipt: journal.load(),
    }),
  );
} finally {
  runs.close();
  journal.close();
  hub.close();
}
