import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  realpathSync,
  chmodSync,
  rmSync,
  writeFileSync,
  readFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer, request } from "node:http";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { startLocalRelay } from "../src/relay-host/local.ts";
import { SQLiteHabRegistry } from "../src/hab/sqlite-registry.ts";
import { HabMcpClient } from "../src/hab/mcp-client.ts";
import { RELAY_OAUTH_SCOPES } from "../src/relay/oauth-resource.ts";
import {
  options as registryOptions,
  operations,
  principal,
} from "./hab-registry-fixtures.js";
import { limits, policy, envelope, message } from "./relay-http-fixtures.js";
import { oauthFixture, issuer, resource } from "./relay-oauth-fixtures.js";

async function fixture(t) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "relay-oauth-")));
  chmodSync(dir, 0o700);
  const oauth = await oauthFixture(true),
    jwt = await oauth.token(),
    admin = Symbol("admin"),
    local = Symbol("local");
  const individual = (ctx) =>
    ctx === local
      ? {
          principal: principal("local"),
          expires_at: new Date(Date.now() + 30000).toISOString(),
        }
      : oauth.auth.authority.individual(ctx);
  const reg = new SQLiteHabRegistry(
    join(dir, "registry.sqlite"),
    registryOptions,
    {
      administrator: (c) =>
        c === admin ? { actor_id: "synthetic-admin" } : undefined,
      individual,
    },
  );
  reg.migrate();
  const product = reg.registerProduct(admin, {
    request_id: "product",
    agent_name: "synthetic",
  });
  function enroll(name, ctx) {
    const a = reg.enroll(admin, {
      request_id: "enroll-" + name,
      product_id: product.product_id,
      bot_name: name,
    });
    const fp = reg.inspectConnection(admin, ctx).connection_fingerprint;
    const b = reg.bindVerified(
      admin,
      {
        request_id: "bind-" + name,
        agent_id: a.agent_id,
        expected_epoch: a.epoch,
        connection_fingerprint: fp,
      },
      ctx,
    );
    return reg.setAccess(admin, {
      request_id: "access-" + name,
      agent_id: a.agent_id,
      expected_epoch: b.agent_epoch,
      state: "active",
      operations,
    });
  }
  const localAgent = enroll("local", local),
    remoteAgent = enroll("remote", await oauth.verify(jwt));
  reg.close();
  const http = { ...policy };
  delete http.resource_url;
  delete http.allowed_origins;
  const options = {
    directory: dir,
    port: 0,
    limits,
    registry: registryOptions,
    store: {
      fingerprint_key: new Uint8Array(32).fill(89),
      max_pending: 20,
      max_records: 100,
      max_pending_per_recipient: 10,
      max_body_bytes: 100000,
      max_clock_skew_ms: 1000,
      lease_ms: 30000,
      max_attempts: 3,
      retry_base_ms: 10,
      retry_cap_ms: 100,
      poll_scan_limit: 20,
    },
    http,
    authority: {
      individual: (ctx) => (ctx === local ? individual(ctx) : undefined),
    },
    verify: ({ authorization }) =>
      authorization === "Bearer synthetic-local" ? local : null,
    audit: { record() {} },
    ingress: {
      port: 0,
      resource_url: resource,
      issuer,
      allowed_origins: [new URL(resource).origin],
      authority: oauth.auth.authority,
      verify: oauth.auth.verify,
    },
  };
  const hosts = [];
  const start = async (patch) => {
    const h = await startLocalRelay({ ...options, ...patch });
    hosts.push(h);
    return h;
  };
  t.after(async () => {
    for (const h of hosts) await h.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const client = (h) =>
    new HabMcpClient({
      policy: {
        resource_url: h.url,
        agent_id: localAgent.agent_id,
        max_request_bytes: 65536,
        max_response_bytes: 131072,
        timeout_ms: 2500,
        max_active_requests: 1,
        max_sse_events: 16,
        max_sse_lines: 128,
        max_json_depth: 64,
        max_json_nodes: 10000,
      },
      limits,
      authorization: () => "Bearer synthetic-local",
    });
  return { dir, oauth, jwt, start, options, localAgent, remoteAgent, client };
}
function wire(
  h,
  {
    method = "POST",
    path = "/hab/mcp",
    host = "relay.example",
    token,
    origin,
    tool,
    args = {},
    body,
  } = {},
) {
  return new Promise((resolve, reject) => {
    const payload =
      body ??
      JSON.stringify(
        envelope(
          tool ? "tools/call" : "tools/list",
          tool ? { name: tool, arguments: args } : {},
        ),
      );
    const q = request(
      {
        hostname: "127.0.0.1",
        port: h.ingress_port,
        path,
        method,
        headers: {
          Host: host,
          Accept: "application/json, text/event-stream",
          ...(method === "POST"
            ? {
                "Content-Type": "application/json",
                "MCP-Protocol-Version": "2026-07-28",
                "Mcp-Method": tool ? "tools/call" : "tools/list",
                ...(tool ? { "Mcp-Name": tool } : {}),
              }
            : {}),
          ...(token ? { Authorization: "Bearer " + token } : {}),
          ...(origin ? { Origin: origin } : {}),
        },
      },
      (r) => {
        const chunks = [];
        r.on("data", (c) => chunks.push(c));
        r.on("end", () => {
          const text = Buffer.concat(chunks).toString();
          let value;
          if (text) {
            if (r.headers["content-type"]?.startsWith("text/event-stream")) {
              value = JSON.parse(
                text
                  .split(/\r?\n/)
                  .find((s) => s.startsWith("data: "))
                  .slice(6),
              );
            } else {
              try {
                value = JSON.parse(text);
              } catch {
                value = null;
              }
            }
          }
          resolve({ status: r.statusCode, headers: r.headers, body: value });
        });
      },
    );
    q.on("error", reject);
    q.setTimeout(3000, () => q.destroy(Error("synthetic_wire_timeout")));
    q.end(method === "POST" ? payload : undefined);
  });
}
function value(r) {
  assert.equal(r.status, 200);
  assert.equal(r.body.result.isError, undefined);
  return r.body.result.structuredContent;
}

test("second loopback ingress exposes only its fixed metadata and five OAuth tools; keeps local auth distinct", async (t) => {
  const f = await fixture(t),
    h = await f.start();
  const meta = await wire(h, {
    method: "GET",
    path: "/.well-known/oauth-protected-resource/hab/mcp",
  });
  assert.equal(meta.status, 200);
  assert.equal(meta.body.resource, resource);
  assert.deepEqual(meta.body.scopes_supported, RELAY_OAUTH_SCOPES);
  const denied = await wire(h);
  assert.equal(denied.status, 401);
  assert.match(
    denied.headers["www-authenticate"],
    /resource_metadata="https:\/\/relay.example\/.well-known\/oauth-protected-resource\/hab\/mcp"/,
  );
  for (const path of [
    "/mcp",
    "/shiftlog/mcp",
    "/.well-known/oauth-protected-resource",
    "/hab/mcp?x=1",
    "/hab/%6dcp",
    "/.well-known/oauth-protected-resource/hab/mcp?x=1",
  ])
    assert.equal((await wire(h, { path })).status, 405);
  assert.equal((await wire(h, { host: "evil.example" })).status, 403);
  assert.equal((await wire(h, { origin: "https://evil.example" })).status, 403);
  assert.equal((await wire(h, { token: "synthetic-local" })).status, 401);
  const listed = await wire(h, { token: f.jwt });
  assert.equal(listed.status, 200);
  assert.deepEqual(listed.body.result.tools.map((x) => x.name).sort(), [
    "relay_ack",
    "relay_poll",
    "relay_resolve",
    "relay_status",
    "relay_submit",
  ]);
  for (const tool of listed.body.result.tools)
    assert.deepEqual(tool._meta.securitySchemes, [
      { type: "oauth2", scopes: RELAY_OAUTH_SCOPES },
    ]);
  const localReject = await globalThis.fetch(h.url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer " + f.jwt,
    },
    body: JSON.stringify(envelope()),
  });
  assert.equal(localReject.status, 401);
  assert.equal(
    (await wire(h, { token: await f.oauth.token({ scope: "hub:get" }) }))
      .status,
    401,
  );
});
test("same queue delivers across local and OAuth ingress, preserves IDs on restart and stops both listeners", async (t) => {
  const f = await fixture(t);
  let h = await f.start();
  let local = f.client(h);
  const a = await wire(h, {
    token: f.jwt,
    tool: "relay_resolve",
    args: { address: f.localAgent.address },
  });
  assert.equal(value(a).recipient_id, f.localAgent.agent_id);
  const m = { ...message(), recipient_id: f.localAgent.agent_id };
  const accepted = value(
    await wire(h, { token: f.jwt, tool: "relay_submit", args: m }),
  );
  assert.equal(accepted.sender_id, f.remoteAgent.agent_id);
  const delivery = await local.poll();
  assert.equal(delivery.message.message_id, m.message_id);
  const ack = {
    sender_id: f.remoteAgent.agent_id,
    message_id: m.message_id,
    generation: delivery.generation,
    lease_token: delivery.lease_token,
    request_id: randomUUID(),
  };
  const journal = join(f.dir, "synthetic-inbox.json");
  writeFileSync(journal, JSON.stringify({ message: delivery.message, ack }), {
    mode: 0o600,
  });
  assert.deepEqual(JSON.parse(readFileSync(journal, "utf8")).ack, ack);
  await local.ack(ack);
  assert.equal(
    value(
      await wire(h, {
        token: f.jwt,
        tool: "relay_status",
        args: { message_id: m.message_id },
      }),
    ).state,
    "acked",
  );
  const reply = {
    ...message("2".repeat(32)),
    recipient_id: f.remoteAgent.agent_id,
    kind: "answer",
    thread_id: m.thread_id,
    in_reply_to: {
      sender_id: f.remoteAgent.agent_id,
      message_id: m.message_id,
    },
  };
  await local.submit(reply);
  const returned = value(
    await wire(h, { token: f.jwt, tool: "relay_poll" }),
  ).delivery;
  assert.equal(returned.message.in_reply_to.message_id, m.message_id);
  assert.equal(returned.message.sender_id, f.localAgent.agent_id);
  const replyAck = {
    sender_id: f.localAgent.agent_id,
    message_id: reply.message_id,
    generation: returned.generation,
    lease_token: returned.lease_token,
    request_id: randomUUID(),
  };
  writeFileSync(
    journal,
    JSON.stringify({ message: returned.message, ack: replyAck }),
    { mode: 0o600 },
  );
  assert.deepEqual(JSON.parse(readFileSync(journal, "utf8")).ack, replyAck);
  const r = value(
    await wire(h, { token: f.jwt, tool: "relay_ack", args: replyAck }),
  );
  assert.equal(r.state, "acked");
  const old = h;
  await h.close();
  await assert.rejects(wire(old, { token: f.jwt }));
  await assert.rejects(globalThis.fetch(old.url));
  h = await f.start();
  local = f.client(h);
  assert.equal((await local.status(reply.message_id)).state, "acked");
  assert.equal(
    value(await wire(h, { token: f.jwt, tool: "relay_ack", args: replyAck }))
      .receipt_id,
    r.receipt_id,
  );
  f.oauth.setConfig({ ...f.oauth.getConfig(), enabled: false });
  assert.equal((await wire(h, { token: f.jwt })).status, 401);
  assert.equal(
    (await local.resolve(f.remoteAgent.address)).recipient_id,
    f.remoteAgent.agent_id,
  );
});
test("ingress startup collision closes the local listener and releases the single store owner", async (t) => {
  const f = await fixture(t),
    occupied = createServer();
  occupied.listen(0, "127.0.0.1");
  await once(occupied, "listening");
  t.after(() => new Promise((resolve) => occupied.close(resolve)));
  await assert.rejects(
    f.start({
      ingress: { ...f.options.ingress, port: occupied.address().port },
    }),
    { code: "EADDRINUSE" },
  );
  const h = await f.start();
  assert.equal((await wire(h)).status, 401);
});
