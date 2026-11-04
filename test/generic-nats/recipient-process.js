import process from "node:process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { JetStreamRelay } from "../../packages/relay-nats/src/backend.ts";
import { jetStreamTextPort } from "../../packages/relay-nats/src/text-port.ts";
import { NatsTextRecipient } from "../../src/generic-nats/recipient.ts";
import { EffectRuntime } from "./effect-runtime.js";
import { inboxAt, journalAt } from "./fixture.js";

const config = JSON.parse(readFileSync(process.argv[2], "utf8"));
const { route, root } = config;
const backend = await JetStreamRelay.open({
  ...config.backendOptions,
  fingerprint_key: Uint8Array.from(
    Object.values(config.backendOptions.fingerprint_key),
  ),
  authorization: {
    authorize(context, operation) {
      if (!["a", "b", "c"].includes(context) || operation === "maintenance")
        return undefined;
      return { agent_id: context };
    },
  },
});
const inbox = inboxAt(join(root, `${route.id}-inbox.sqlite`), route.recipient),
  journal = journalAt(join(root, `${route.id}-journal.sqlite`), route.scope);
let counter = 0;
const witnesses = new Map();
const gate = {
  inspect(_route, key) {
    const id = ++counter;
    return new Promise((resolve, reject) => {
      witnesses.set(id, { resolve, reject });
      process.send({ type: "gate", id, key });
    });
  },
};
const runtime = new EffectRuntime(root, route.id, {
  ...config.runtime,
  async afterEffect(key) {
    if (config.crashAfterEffect) {
      process.send({ type: "effect", key });
      await new Promise(() => {});
    }
  },
});
const recipient = new NatsTextRecipient({
  route,
  transport: jetStreamTextPort(backend, route.recipient, route.recipient),
  inbox,
  journal,
  gate,
  runtime,
  now: () => config.now,
  runtimeTimeoutMs: 30000,
});
process.on("message", async (message) => {
  if (message.type === "witness") {
    const wait = witnesses.get(message.id);
    witnesses.delete(message.id);
    if (message.error) wait?.reject(Error(message.error));
    else wait?.resolve(message.value);
  } else if (message.type === "command") {
    try {
      if (!["receiveOnce", "executeOnce", "sendOnce"].includes(message.method))
        throw Error("invalid_child_command");
      process.send({
        type: "response",
        id: message.id,
        value: await recipient[message.method](),
      });
    } catch (error) {
      process.send({ type: "response", id: message.id, error: error.message });
    }
  }
});
process.on("SIGTERM", async () => {
  await recipient.close();
  inbox.close();
  journal.close();
  runtime.close();
  await backend.close();
  process.exit(0);
});
process.send({ type: "ready" });
