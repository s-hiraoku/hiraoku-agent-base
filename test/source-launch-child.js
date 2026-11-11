/** Owned synthetic crash fixture, never imports or starts a native product. */
import process from "node:process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { sourceFixture } from "./source-launch-fixture.js";
const directory = process.argv[2], fixture = sourceFixture(directory);
const claim = fixture.journal.claim(fixture.context, fixture.receive());
writeFileSync(join(directory, "claim.json"), JSON.stringify(claim), { mode: 0o600 });
process.kill(process.pid, "SIGKILL");
