import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { once } from "node:events";
import { ClientFactory, DefaultAgentCardResolver } from "@a2a-js/sdk/client";
import { ServerCallContext } from "@a2a-js/sdk/server";
import { SendMessageRequest } from "@a2a-js/sdk";
import { openA2aTaskStore } from "../src/a2a/store.ts";
import { connectivityAgentCard } from "../src/a2a/adapter.ts";
import { createA2aGateway } from "../src/a2a/http.ts";
import { createA2aNodeHandler } from "../src/a2a/http-node.ts";
import { ConnectivityTaskPort } from "../src/task-bridge/task-port.ts";
import { Hub, owner, worker, RESPONSE } from "./fixtures.js";
export { worker, RESPONSE };
export const request = (messageId = "check_1") =>
  SendMessageRequest.fromJSON({
    message: {
      messageId,
      role: "ROLE_USER",
      parts: [{ text: "connectivity_check" }],
    },
    configuration: { returnImmediately: true },
  });
export async function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "hab-a2a-"));
  const hub = new Hub(join(dir, "engine.sqlite"));
  const state = { failAfterSubmit: false, forbidden: false };
  const binding = {
    engine_id: "synthetic-engine",
    owner_subject: owner.subject,
    client_id: null,
  };
  const port = new ConnectivityTaskPort(
    {
      async submit(...args) {
        const result = await hub.submit(...args);
        if (state.failAfterSubmit) {
          state.failAfterSubmit = false;
          throw Error("lost response");
        }
        return result;
      },
      get: (...args) => state.observed ?? hub.get(...args),
    },
    binding,
    () => (state.forbidden ? undefined : owner),
  );
  const otherOwner = { ...owner, subject: "other-owner" };
  const otherPort = new ConnectivityTaskPort(
    hub,
    { ...binding, owner_subject: otherOwner.subject },
    () => otherOwner,
  );
  let stores;
  let nodeHandler;
  const server = createServer((req, res) => nodeHandler(req, res));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${server.address().port}`;
  const endpoint = `${base}/a2a`;
  const card = connectivityAgentCard(endpoint);
  const open = () => {
    stores = openA2aTaskStore(join(dir, "a2a.sqlite"));
    const gateway = createA2aGateway({
      endpoint,
      card,
      store: stores.store,
      authorize: (req) => {
        const token = req.headers.get("authorization");
        if (token === "Bearer synthetic-owner")
          return { subject: "caller-a", tasks: port };
        if (token === "Bearer synthetic-other")
          return { subject: "caller-b", tasks: otherPort };
      },
    });
    nodeHandler = createA2aNodeHandler(endpoint, gateway);
  };
  open();
  const makeClient = () =>
    new ClientFactory({
      ...new ClientFactory().options,
      cardResolver: new DefaultAgentCardResolver({
        fetchImpl: (url, init) =>
          globalThis.fetch(url, {
            ...init,
            headers: {
              ...init?.headers,
              Authorization: "Bearer synthetic-owner",
            },
          }),
      }),
    }).createFromUrl(base);
  const client = await makeClient();
  const options = {
    serviceParameters: { Authorization: "Bearer synthetic-owner" },
  };
  const raw = (method, params, patch = {}) =>
    globalThis.fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: "Bearer synthetic-owner",
        "Content-Type": "application/json",
        "A2A-Version": "1.0",
        ...patch,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: "test", method, params }),
    });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await stores.close();
    hub.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return {
    hub,
    state,
    port,
    client,
    options,
    raw,
    base,
    card,
    async restart() {
      await stores.close();
      open();
    },
    async legacyRecord(id) {
      const context = new ServerCallContext({
        requestedVersion: "1.0",
        user: { isAuthenticated: true, userName: "caller-a" },
      });
      const task = await stores.store.load(id, context);
      delete task.metadata.hab.evidence;
      await stores.store.save(task, context);
    },
    count: () => hub.sqlite.db.prepare("SELECT count(*) n FROM tasks").get().n,
  };
}
