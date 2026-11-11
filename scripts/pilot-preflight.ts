import { readFileSync } from "node:fs";
import { preflightPilot } from "../src/pilot-config.ts";
try {
  const result = preflightPilot(
    JSON.parse(
      readFileSync(process.argv[2] ?? "config/pilot.example.json", "utf8"),
    ),
  );
  console.log(JSON.stringify(result));
  process.exitCode = result.offlineValid ? 0 : 1;
} catch {
  console.error("invalid_or_unreadable_config");
  process.exitCode = 1;
}
