/** Operator management for the configured HAB host. Prints no secrets. */
import { pathToFileURL } from "node:url";
import {
  hostAdminStatus,
  hostAdminConnect,
  hostAdminDisconnect,
  hostAdminRename,
  hostAdminReceive,
  hostAdminSession,
  hostAdminErrorCode,
  HostAdminError,
} from "../src/host/admin.ts";
import { hostAdminDoctor } from "../src/host/doctor.ts";

const usage = `usage:
  hab-admin --config <service.local.json> status
  hab-admin --config <service.local.json> doctor [--address <bot@agent.hab>]
  hab-admin --config <service.local.json> connect --address <bot@agent.hab> --connection-id <id> [--operations resolve,submit,status,poll,ack]
  hab-admin --config <service.local.json> disconnect --address <bot@agent.hab>
  hab-admin --config <service.local.json> receive --agent-name <product> --mode hook|poll|on_request [--interval-ms <60000..86400000>] --request-id <journaled-id>
  hab-admin --config <service.local.json> session --address <bot@agent.hab> --session <name> [--replace true] --request-id <journaled-id>
  hab-admin --config <service.local.json> rename --agent-id <id> --expected-address <old@agent.hab> --bot-name <new> --expected-epoch <epoch> --request-id <journaled-id>`;

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
        "--agent-name",
        "--mode",
        "--interval-ms",
        "--session",
        "--replace",
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
    command === "doctor" &&
    Object.keys(options).every((key) => key === "--address")
  )
    return hostAdminDoctor(config, options["--address"]);
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
    command === "receive" &&
    options["--agent-name"] &&
    options["--mode"] &&
    options["--request-id"] &&
    Object.keys(options).every((key) =>
      ["--agent-name", "--mode", "--interval-ms", "--request-id"].includes(key),
    )
  )
    return hostAdminReceive(config, {
      agent_name: options["--agent-name"],
      mode: options["--mode"],
      request_id: options["--request-id"],
      ...(options["--interval-ms"] !== undefined
        ? { interval_ms: Number(options["--interval-ms"]) }
        : {}),
    });
  if (
    command === "session" &&
    options["--address"] &&
    options["--session"] &&
    options["--request-id"] &&
    (options["--replace"] === undefined || options["--replace"] === "true") &&
    Object.keys(options).every((key) =>
      ["--address", "--session", "--replace", "--request-id"].includes(key),
    )
  )
    return hostAdminSession(config, {
      address: options["--address"],
      session: options["--session"],
      request_id: options["--request-id"],
      ...(options["--replace"] === "true" ? { replace: true } : {}),
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
      `admin_rejected ${code}\n${code === "usage" ? usage + "\n" : ""}`,
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
