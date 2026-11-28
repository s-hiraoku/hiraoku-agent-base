/** Operator management for the configured HAB host. Prints no secrets. */
import { randomBytes } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
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
import {
  hostAdminPending,
  hostAdminApprove,
  hostAdminReject,
  hostAdminRevoke,
} from "../src/host/admin-pending.ts";
import {
  hostAdminDoorbellAdd,
  hostAdminDoorbellRemove,
  hostAdminDoorbellList,
} from "../src/host/admin-doorbells.ts";
import {
  fillRecipe,
  listRecipes,
  loadRecipe,
} from "../src/host/product-recipes.ts";
import { OperatorMail } from "../src/host/operator-mail.ts";
import type { OperatorMailView } from "../src/host/operator-mail.ts";
import { makeReplayBoundMessageId } from "../src/messaging/contract.ts";

const usage = `usage:
  hab-admin --config <service.local.json> status
  hab-admin --config <service.local.json> doctor [--address <bot@agent.hab>]
  hab-admin --config <service.local.json> ping --address <bot@agent.hab> [--wait <0..60>] [--request-id <operation_id>]
  hab-admin --config <service.local.json> ping --status <operation_id> [--wait <0..60>]
  hab-admin --config <service.local.json> pending
  hab-admin --config <service.local.json> approve --pending <pending_id> --address <bot@agent.hab> [--days <1..3650>]
  hab-admin --config <service.local.json> reject --pending <pending_id>
  hab-admin --config <service.local.json> revoke --connection <connection_id>
  hab-admin --config <service.local.json> doorbell add --address <bot@agent.hab> --url <url> --secret-file <path>
  hab-admin --config <service.local.json> doorbell remove --address <bot@agent.hab>
  hab-admin --config <service.local.json> doorbell list
  hab-admin --config <service.local.json> recipe [--product <product> [--address <bot@agent.hab>] [--allowed <bot@agent.hab>] [--conversation <name>]]
  hab-admin --config <service.local.json> connect --address <bot@agent.hab> --connection-id <id> [--operations resolve,submit,status,poll,ack]
  hab-admin --config <service.local.json> disconnect --address <bot@agent.hab>
  hab-admin --config <service.local.json> receive --agent-name <product> --mode hook|poll|on_request [--interval-ms <60000..86400000>] --request-id <journaled-id>
  hab-admin --config <service.local.json> session --address <bot@agent.hab> --session <name> [--replace true] --request-id <journaled-id>
  hab-admin --config <service.local.json> rename --agent-id <id> --expected-address <old@agent.hab> --bot-name <new> --expected-epoch <epoch> --request-id <journaled-id>`;

function parse(args: string[]) {
  if (args[0] !== "--config" || !args[1] || !args[2])
    throw new HostAdminError("usage");
  const [, config, first, ...rest] = args;
  // `doorbell add|remove|list` reads as one command.
  const command =
    first === "doorbell" && ["add", "remove", "list"].includes(rest[0])
      ? `doorbell-${rest.shift()}`
      : first;
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
        "--pending",
        "--days",
        "--connection",
        "--url",
        "--secret-file",
        "--wait",
        "--status",
        "--product",
        "--allowed",
        "--conversation",
      ].includes(key) ||
      value === undefined ||
      Object.hasOwn(options, key)
    )
      throw new HostAdminError("usage");
    options[key] = value;
  }
  return { config, command, options };
}

async function waitForPing(
  mail: OperatorMail,
  result: Promise<OperatorMailView>,
  wait: number,
) {
  let view = await result;
  const deadline = performance.now() + wait * 1000;
  while (
    !view.problem &&
    view.reply_at === null &&
    view.state !== "expired" &&
    view.state !== "quarantined" &&
    performance.now() < deadline
  ) {
    await delay(Math.min(500, deadline - performance.now()));
    if (performance.now() >= deadline) break;
    view = await mail.status(view.operation_id);
  }
  return view;
}

function ping(
  config: string,
  options: Record<string, string | undefined>,
  onGeneratedId?: (id: string) => void,
) {
  const target = options["--address"];
  const statusId = options["--status"];
  const requestId = options["--request-id"];
  const wait = options["--wait"] ?? "0";
  const allowed = statusId
    ? ["--status", "--wait"]
    : ["--address", "--request-id", "--wait"];
  if (
    !/^(?:[0-9]|[1-5][0-9]|60)$(?![\s\S])/.test(wait) ||
    Object.keys(options).some((key) => !allowed.includes(key))
  )
    throw new HostAdminError("usage");

  if (target) {
    const mail = new OperatorMail(config, "ping");
    const operationId =
      requestId ??
      makeReplayBoundMessageId(
        new Date().toISOString(),
        randomBytes(16).toString("hex"),
      );
    if (requestId === undefined) onGeneratedId?.(operationId);
    return waitForPing(
      mail,
      mail.submit(operationId, { action: "ping", to: target }),
      Number(wait),
    );
  }
  if (statusId) {
    const mail = new OperatorMail(config, "ping");
    return waitForPing(mail, mail.status(statusId), Number(wait));
  }
  throw new HostAdminError("usage");
}

export function main(
  args = process.argv.slice(2),
  onGeneratedPingId?: (id: string) => void,
) {
  const { config, command, options } = parse(args);
  if (command === "status" && !Object.keys(options).length)
    return hostAdminStatus(config);
  if (
    command === "doctor" &&
    Object.keys(options).every((key) => key === "--address")
  )
    return hostAdminDoctor(config, options["--address"]);
  if (command === "ping") return ping(config, options, onGeneratedPingId);
  if (command === "pending" && !Object.keys(options).length)
    return hostAdminPending(config);
  if (
    command === "approve" &&
    options["--pending"] &&
    options["--address"] &&
    Object.keys(options).every((key) =>
      ["--pending", "--address", "--days"].includes(key),
    ) &&
    (options["--days"] === undefined || /^[0-9]{1,4}$/.test(options["--days"]))
  )
    return hostAdminApprove(config, {
      pending_id: options["--pending"],
      address: options["--address"],
      ...(options["--days"] ? { days: Number(options["--days"]) } : {}),
    });
  if (
    command === "reject" &&
    options["--pending"] &&
    Object.keys(options).length === 1
  )
    return hostAdminReject(config, options["--pending"]);
  if (
    command === "revoke" &&
    options["--connection"] &&
    Object.keys(options).length === 1
  )
    return hostAdminRevoke(config, options["--connection"]);
  if (
    command === "doorbell-add" &&
    Object.keys(options).length === 3 &&
    options["--address"] &&
    options["--url"] &&
    options["--secret-file"]
  )
    return hostAdminDoorbellAdd(config, {
      address: options["--address"],
      url: options["--url"],
      secret_file: options["--secret-file"],
    });
  if (
    command === "doorbell-remove" &&
    Object.keys(options).length === 1 &&
    options["--address"]
  )
    return hostAdminDoorbellRemove(config, options["--address"]);
  if (command === "doorbell-list" && !Object.keys(options).length)
    return hostAdminDoorbellList(config);
  if (command === "recipe" && !Object.keys(options).length)
    return {
      products: listRecipes().map((product) => {
        const recipe = loadRecipe(product);
        return { product, label: recipe.label, receive: recipe.receive.mode };
      }),
    };
  if (
    command === "recipe" &&
    options["--product"] &&
    Object.keys(options).every((key) =>
      ["--product", "--address", "--allowed", "--conversation"].includes(key),
    )
  )
    return fillRecipe(loadRecipe(options["--product"]), {
      address: options["--address"],
      allowed: options["--allowed"],
      conversation: options["--conversation"],
    });
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

export async function runCli() {
  try {
    const result = await main(undefined, (id) =>
      process.stderr.write(`ping_request_id ${id}\n`),
    );
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
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
