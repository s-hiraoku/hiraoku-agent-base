/** Operator management for the configured local Relay. Prints no secrets. */
import { pathToFileURL } from "node:url";
import {
  hostAdminStatus,
  hostAdminConnect,
  hostAdminDisconnect,
  hostAdminRename,
  hostAdminErrorCode,
  HostAdminError,
} from "../src/host/admin.ts";

const usage = `usage:
  hab-relay-admin --config <service.local.json> status
  hab-relay-admin --config <service.local.json> connect --address <bot@agent.hab> --connection-id <id> [--operations resolve,submit,status,poll,ack]
  hab-relay-admin --config <service.local.json> disconnect --address <bot@agent.hab>
  hab-relay-admin --config <service.local.json> rename --agent-id <id> --expected-address <old@agent.hab> --bot-name <new> --expected-epoch <epoch> --request-id <journaled-id>`;

function parse(args: string[]) {
  if (args[0] !== "--config" || !args[1] || !args[2])
    throw new HostAdminError("usage");
  const [, config, command, ...rest] = args;
  const options: Record<string, string | undefined> = {};
  for (let i = 0; i < rest.length; i += 2) {
    const key = rest[i],
      value = rest[i + 1];
    if (
      ![
        "--address",
        "--connection-id",
        "--operations",
        "--agent-id",
        "--expected-address",
        "--bot-name",
        "--expected-epoch",
        "--request-id",
      ].includes(key) ||
      value === undefined ||
      Object.hasOwn(options, key)
    )
      throw new HostAdminError("usage");
    options[key] = value;
  }
  return { config, command, options };
}

export function main(args = process.argv.slice(2)) {
  const { config, command, options } = parse(args);
  if (command === "status" && !Object.keys(options).length)
    return hostAdminStatus(config);
  if (
    command === "rename" &&
    Object.keys(options).length === 5 &&
    options["--agent-id"] &&
    options["--expected-address"] &&
    options["--bot-name"] &&
    options["--expected-epoch"] &&
    options["--request-id"]
  )
    return hostAdminRename(config, {
      agent_id: options["--agent-id"],
      expected_address: options["--expected-address"],
      bot_name: options["--bot-name"],
      expected_epoch: Number(options["--expected-epoch"]),
      request_id: options["--request-id"],
    });
  if (
    command === "connect" &&
    options["--address"] &&
    options["--connection-id"] &&
    Object.keys(options).every((key) =>
      ["--address", "--connection-id", "--operations"].includes(key),
    )
  )
    return hostAdminConnect(config, {
      address: options["--address"],
      connection_id: options["--connection-id"],
      ...(options["--operations"] !== undefined
        ? { operations: options["--operations"].split(",") }
        : {}),
    });
  if (
    command === "disconnect" &&
    options["--address"] &&
    Object.keys(options).length === 1
  )
    return hostAdminDisconnect(config, options["--address"]);
  throw new HostAdminError("usage");
}

export function runCli() {
  try {
    process.stdout.write(JSON.stringify(main(), null, 2) + "\n");
  } catch (error) {
    const code = hostAdminErrorCode(error);
    process.stderr.write(
      `relay_admin_rejected ${code}\n${code === "usage" ? usage + "\n" : ""}`,
    );
    process.exitCode = code === "usage" ? 2 : 1;
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  runCli();
}
