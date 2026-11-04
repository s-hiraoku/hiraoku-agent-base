import { test } from "node:test";
import { genericNatsImplementations } from "./cases.js";

for (const [name, run] of genericNatsImplementations)
  test(name, { timeout: 60000 }, run);
