import { successfulExecution } from "./p7-worker.mjs";
import { groups as required } from "../../test/p7/manifest.js";
export function observedCases(tap) {
  return [...tap.matchAll(/^(?:not )?ok \d+ - (.+)$/gm)].map((m) => m[1]);
}
export function assessP7(groups, definitions = required) {
  if (
    !definitions.length ||
    new Set(definitions.map((d) => d.id)).size !== definitions.length ||
    definitions.some((d) => typeof d.id !== "string" || !d.id) ||
    groups.length !== definitions.length ||
    new Set(groups.map((g) => g.id)).size !== groups.length
  )
    return false;
  return definitions.every((definition) => {
    const group = groups.find((g) => g.id === definition.id),
      totals = group?.totals;
    const count = definition.cases?.length ?? definition.count;
    if (
      !Number.isSafeInteger(count) ||
      count <= 0 ||
      !group ||
      !successfulExecution(group) ||
      group.parse_error ||
      !totals ||
      totals.tests !== count ||
      totals.pass !== count ||
      totals.fail ||
      totals.skipped ||
      totals.cancelled ||
      totals.todo
    )
      return false;
    if (!definition.cases) return true;
    const cases = group.cases ?? [];
    return (
      new Set(cases).size === cases.length &&
      JSON.stringify([...cases].sort()) ===
        JSON.stringify([...definition.cases].sort())
    );
  });
}
