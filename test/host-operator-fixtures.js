import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { hostAdminConnect } from "../src/host/admin.ts";
import { startHost } from "../src/host/start.ts";
import { makeReplayBoundMessageId } from "../src/messaging/contract.ts";
import { decode, request } from "./mcp-http-fixtures.js";
import { fixture } from "./host-service-fixtures.js";

export function operationId() {
  return makeReplayBoundMessageId(
    new Date().toISOString(),
    randomBytes(16).toString("hex"),
  );
}

export async function operatorFixture(t, { events = false } = {}) {
  const f = await fixture(t);
  if (events) {
    const { oauthFixture, resource } = await import("./oauth-fixtures.js");
    const oauth = await oauthFixture(true);
    f.config.ingress = {
      port: 0,
      resource_url: resource,
      oauth_file: f.write("oauth.local.json", oauth.getConfig()),
      allowed_origins: [],
      events: { poll_ms: 500 },
    };
    f.write("service.local.json", f.config);
  }
  const host = await startHost(f.configPath);
  t.after(() => host.close());
  f.config.port = Number(new URL(host.url).port);
  f.write("service.local.json", f.config);

  const mailbox = "operator@demo.hab";
  const ping = "ping@hab.hab";
  const recipient = "recipient@demo.hab";
  const actors = { mailbox, ping, recipient };
  const now = Date.now();
  const bearers = Object.fromEntries(
    Object.keys(actors).map((role) => [role, randomBytes(32).toString("hex")]),
  );
  f.write("credentials.local.json", {
    version: 1,
    credentials: Object.entries(bearers).map(([role, bearer]) => ({
      sha256: createHash("sha256").update(bearer).digest("hex"),
      principal: {
        issuer: "urn:synthetic:local",
        audience: host.url,
        subject: "operator-fixture-" + role,
        client_id: "operator-fixture-client",
        connection_id: "operator-fixture-" + role,
      },
      issued_at: new Date(now - 1000).toISOString(),
      expires_at: new Date(now + 600_000).toISOString(),
    })),
  });
  const configured = (role) => {
    const bound = hostAdminConnect(f.configPath, {
      address: actors[role],
      connection_id: "operator-fixture-" + role,
    });
    return {
      address: actors[role],
      agent_id: bound.address.agent_id,
      bearer_file: f.write(role + ".local.json", {
        version: 1,
        bearer: bearers[role],
      }),
    };
  };
  f.config.operator_mail = {
    mailbox: configured("mailbox"),
    ping: configured("ping"),
  };
  configured("recipient");
  f.write("service.local.json", f.config);

  async function call(role, name, args = {}) {
    const response = await globalThis.fetch(
      request(
        "tools/call",
        { name, arguments: args },
        {
          url: host.url,
          headers: { Authorization: "Bearer " + bearers[role] },
        },
      ),
    );
    assert.equal(response.status, 200);
    const { result, error } = await decode(response);
    assert.equal(error, undefined);
    assert.notEqual(
      result.isError,
      true,
      JSON.stringify(result.structuredContent),
    );
    return result.structuredContent;
  }
  return { ...f, host, mailbox, ping, recipient, call, bearers };
}
