/** Operator management for the configured local Relay. Prints no secrets. */
import { pathToFileURL } from "node:url";
import {
  relayAdminStatus,
  relayAdminConnect,
  relayAdminDisconnect,
  relayAdminErrorCode,
  RelayAdminError,
} from "../src/relay-host/admin.ts";

const usage = `usage:
  hab-relay-admin --config <service.local.json> status
  hab-relay-admin --config <service.local.json> connect --address <bot@agent.hab> --connection-id <id> [--operations resolve,submit,status,poll,ack]
  hab-relay-admin --config <service.local.json> disconnect --address <bot@agent.hab>`;

function parse(args) {
  if (args[0] !== "--config" || !args[1] || !args[2])
    throw new RelayAdminError("usage");
  const [, config, command, ...rest] = args;
  const options = {};
  for (let i = 0; i < rest.length; i += 2) {
    const key = rest[i],
      value = rest[i + 1];
    if (
      !["--address", "--connection-id", "--operations"].includes(key) ||
      value === undefined ||
      Object.hasOwn(options, key)
    )
      throw new RelayAdminError("usage");
    options[key] = value;
  }
  return { config, command, options };
}

export function main(args = process.argv.slice(2)) {
  const { config, command, options } = parse(args);
  if (command === "status" && !Object.keys(options).length)
    return relayAdminStatus(config);
  if (
    command === "connect" &&
    options["--address"] &&
    options["--connection-id"]
  )
    return relayAdminConnect(config, {
      address: options["--address"],
      connection_id: options["--connection-id"],
      ...(options["--operations"]
        ? { operations: options["--operations"].split(",") }
        : {}),
    });
  if (
    command === "disconnect" &&
    options["--address"] &&
    Object.keys(options).length === 1
  )
    return relayAdminDisconnect(config, options["--address"]);
  throw new RelayAdminError("usage");
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    process.stdout.write(JSON.stringify(main(), null, 2) + "\n");
  } catch (error) {
    const code = relayAdminErrorCode(error);
    process.stderr.write(
      `relay_admin_rejected ${code}\n${code === "usage" ? usage + "\n" : ""}`,
    );
    process.exitCode = code === "usage" ? 2 : 1;
  }
}
