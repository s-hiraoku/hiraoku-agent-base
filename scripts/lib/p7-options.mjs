import { parseArgs } from "node:util";
import { isAbsolute } from "node:path";
export function parseP7Options(args) {
  const parsed = parseArgs({
    args,
    options: { full: { type: "boolean" }, "nats-server": { type: "string" } },
    strict: true,
    allowPositionals: false,
    tokens: true,
  });
  const seen = new Set();
  for (const token of parsed.tokens) {
    if (token.kind !== "option" || seen.has(token.name))
      throw Error("P7 duplicate argument");
    seen.add(token.name);
  }
  const natsServer = parsed.values["nats-server"];
  if (
    typeof natsServer !== "string" ||
    !isAbsolute(natsServer) ||
    natsServer.includes("\0")
  )
    throw Error("P7 absolute official binary required");
  return { full: parsed.values.full ?? false, natsServer };
}
