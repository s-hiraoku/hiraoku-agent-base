import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClientFactory, DefaultAgentCardResolver } from "@a2a-js/sdk/client";
import { SendMessageRequest } from "@a2a-js/sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Hub } from "../src/sqlite.ts";
import { Adapter } from "../src/adapter.ts";
import { Journal } from "../src/journal.ts";
import { GenericTextJobs, GENERIC_TEXT_PROFILE } from "../src/generic-jobs.ts";
import { createGenericTextHost } from "../src/generic-host.ts";
import { identities, SyntheticTextRuns } from "./generic-async/fixtures.js";

export const a2aRequest = (input) =>
  SendMessageRequest.fromJSON({
    message: {
      messageId: input.messageId,
      contextId: input.contextId,
      role: "ROLE_USER",
      parts: [{ text: input.text, mediaType: "text/plain" }],
    },
    configuration: { returnImmediately: true },
    metadata: {
      [GENERIC_TEXT_PROFILE]: { version: 1, workDeadline: input.workDeadline },
    },
  });
export const unpack = (reply) => JSON.parse(reply.content[0].text);

export async function openGenericEntranceFixture(options = {}) {
  const parent = options.parent ?? tmpdir();
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const root = mkdtempSync(join(parent, "generic-protocol-"));
  const state = { now: Date.now(), failAfterSubmit: false, revoked: false };
  const paper = identities("paper"),
    mirror = identities("mirror");
  mirror.sender.textBinding.conversationBinding = "trusted-conversation-2";
  mirror.worker.textBinding.conversationBinding = "trusted-conversation-2";
  const policies = new Map([
    ["paper", paper.sender],
    ["mirror", mirror.sender],
    [
      "other-client",
      { ...paper.sender, clientId: "different-synthetic-client" },
    ],
    ["other-owner", { ...paper.sender, subject: "different-synthetic-owner" }],
  ]);
  let hub, host;
  const clients = [];
  const server = createServer((request, response) =>
    host.handler(request, response),
  );
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${server.address().port}`;
  const open = () => {
    hub = new Hub(join(root, "tasks.sqlite"), () => state.now);
    const submit = hub.submitText.bind(hub);
    hub.submitText = async (...args) => {
      const result = await submit(...args);
      if (state.failAfterSubmit) {
        state.failAfterSubmit = false;
        throw Error("synthetic-private-error-marker");
      }
      return result;
    };
    const jobs = new GenericTextJobs(hub, (request) => {
      if (state.revoked) return null;
      const token = request.headers
        .get("authorization")
        ?.replace(/^Bearer synthetic-/, "");
      return policies.get(token) ?? null;
    });
    host = createGenericTextHost({ baseUrl: base, jobs });
  };
  open();
  return {
    root,
    base,
    state,
    policies,
    paper,
    mirror,
    get hub() {
      return hub;
    },
    input(messageId, text = "hello") {
      return {
        messageId,
        contextId: `context-${messageId}`,
        text,
        workDeadline: state.now + 3600000,
      };
    },
    async a2a(token = "paper") {
      const authorization = `Bearer synthetic-${token}`;
      const client = await new ClientFactory({
        ...new ClientFactory().options,
        cardResolver: new DefaultAgentCardResolver({
          fetchImpl: (url, init) =>
            globalThis.fetch(url, {
              ...init,
              headers: { ...init?.headers, Authorization: authorization },
            }),
        }),
      }).createFromUrl(base);
      return {
        client,
        options: {
          serviceParameters: {
            Authorization: authorization,
            "A2A-Extensions": GENERIC_TEXT_PROFILE,
          },
        },
      };
    },
    async mcp(token = "paper") {
      const client = new Client({
        name: "synthetic-cross-protocol",
        version: "1.0.0",
      });
      clients.push(client);
      await client.connect(
        new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
          requestInit: {
            headers: { authorization: `Bearer synthetic-${token}` },
          },
        }),
      );
      return client;
    },
    async execute(product = "paper", mode = "complete") {
      const journal = new Journal(join(root, `${product}-journal.sqlite`));
      const runs = new SyntheticTextRuns(
        join(root, `${product}-runs.sqlite`),
        product,
        mode,
      );
      try {
        const id = await new Adapter(
          hub,
          product === "paper" ? paper.worker : mirror.worker,
          runs,
          journal,
          { now: () => state.now },
        ).once();
        return { id, admissions: runs.count(), receipt: journal.load() };
      } finally {
        runs.close();
        journal.close();
      }
    },
    async confirmCancellation(id, product = "paper") {
      const identity = product === "paper" ? paper : mirror;
      const runs = new SyntheticTextRuns(
        join(root, `${product}-runs.sqlite`),
        product,
      );
      try {
        runs.finish();
        const task = await hub.get(identity.sender, { id });
        await hub.reconcile(identity.worker, { id, fence: task.fence }, runs);
      } finally {
        runs.close();
      }
    },
    async restart() {
      await host.close();
      hub.close();
      open();
    },
    async close() {
      await Promise.allSettled(clients.map((client) => client.close()));
      await host.close();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      hub.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}
