import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, request } from "node:http";
import {
  mkdtempSync,
  realpathSync,
  rmSync,
  chmodSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hub } from "../src/sqlite.ts";
import { createRuntime } from "../src/runtime.ts";
import { RESPONSE } from "../src/types.ts";
import {
  prepareReadbackFixture,
  READBACK_FIXTURE_ID,
  READBACK_FIXTURE_ACTOR,
} from "../src/readback-fixture.ts";
const config = () => ({
  version: 1,
  mode: "auth0",
  enabled: true,
  oauth: {
    issuer: "https://fixture.us.auth0.com/",
    resource: "https://hub.example/hab/mcp",
    scopes: ["hub:get"],
  },
  subjects: [
    {
      subject: "fixture-approved-reader",
      clientId: "fixture-reader-client",
      kind: "user",
      operations: ["get"],
    },
  ],
});
const directory = () =>
  realpathSync(mkdtempSync(join(tmpdir(), "hub-positive-readback-")));
const counts = (hub) =>
  Object.fromEntries(
    ["tasks", "outbox", "subscriptions", "diagnostic_outbox", "audit"].map(
      (t) => [
        t,
        hub.sqlite.db.prepare("SELECT COUNT(*) AS n FROM " + t).get().n,
      ],
    ),
  );
test("exclusive synthetic fixture has fixed result, explicit provenance and no execution/outbox", () => {
  const root = directory();
  let hub;
  try {
    const prepared = prepareReadbackFixture(root, config());
    assert.equal(prepared.synthetic, true);
    assert.equal(prepared.result, RESPONSE);
    hub = new Hub(prepared.database);
    const task = hub.sqlite.db
      .prepare("SELECT * FROM tasks WHERE id=?")
      .get(READBACK_FIXTURE_ID);
    assert.equal(task.actor, READBACK_FIXTURE_ACTOR);
    assert.equal(task.state, "succeeded");
    assert.equal(task.execution_open, 0);
    assert.equal(task.run_id, null);
    assert.deepEqual(counts(hub), {
      tasks: 1,
      outbox: 0,
      subscriptions: 0,
      diagnostic_outbox: 0,
      audit: 1,
    });
    assert.throws(
      () => prepareReadbackFixture(root, config()),
      /existing_artifact/,
    );
    assert.deepEqual(counts(hub), {
      tasks: 1,
      outbox: 0,
      subscriptions: 0,
      diagnostic_outbox: 0,
      audit: 1,
    });
  } finally {
    hub?.close();
    rmSync(root, { recursive: true, force: true });
  }
});
test("fixture refuses broader authority, unsafe directory and existing sidecars", () => {
  for (const mutate of [
    (c) => {
      c.enabled = false;
    },
    (c) => {
      c.subjects[0].operations.push("submit");
    },
    (c) => {
      c.oauth.scopes.push("hub:submit");
    },
    (c) => {
      c.subjects.push({ ...c.subjects[0], subject: "other" });
    },
    (c) => {
      c.subjects[0].worker = "hermes";
    },
  ]) {
    const root = directory();
    try {
      const c = config();
      mutate(c);
      assert.throws(() => prepareReadbackFixture(root, c));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
  const root = directory();
  try {
    chmodSync(root, 0o755);
    assert.throws(
      () => prepareReadbackFixture(root, config()),
      /private_directory/,
    );
    chmodSync(root, 0o700);
    writeFileSync(join(root, "readback-hub.sqlite-wal"), "fixture", {
      mode: 0o600,
    });
    assert.throws(
      () => prepareReadbackFixture(root, config()),
      /existing_artifact/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("actual HTTP positive get validates JWT/client/subject/scope and denies every mutation", async () => {
  const root = directory();
  let hub, server;
  try {
    const c = config();
    const prepared = prepareReadbackFixture(root, c);
    hub = new Hub(prepared.database);
    const keys = await crypto.subtle.generateKey(
      {
        name: "RSASSA-PKCS1-v1_5",
        modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: "SHA-256",
      },
      true,
      ["sign", "verify"],
    );
    const jwk = {
      ...(await crypto.subtle.exportKey("jwk", keys.publicKey)),
      kid: "fixture",
      alg: "RS256",
      use: "sig",
    };
    let jwksCalls = 0;
    const runtime = createRuntime(hub, c, {
      fetch: async (url, init) => {
        assert.equal(url, "https://fixture.us.auth0.com/.well-known/jwks.json");
        assert.equal(init.redirect, "error");
        jwksCalls++;
        return Response.json({ keys: [jwk] });
      },
    });
    const enc = (value) =>
      Buffer.from(JSON.stringify(value)).toString("base64url");
    const sign = async (overrides = {}) => {
      const text = `${enc({ alg: "RS256", kid: "fixture", typ: "JWT" })}.${enc({ iss: c.oauth.issuer, aud: c.oauth.resource, sub: c.subjects[0].subject, azp: c.subjects[0].clientId, exp: Math.floor(Date.now() / 1000) + 300, scope: "hub:get", ...overrides })}`;
      return `Bearer ${text}.${Buffer.from(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", keys.privateKey, new TextEncoder().encode(text))).toString("base64url")}`;
    };
    server = createServer((req, res) => void runtime.handle(req, res));
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const send = (token, name, args) =>
      new Promise((resolve, reject) => {
        const body = JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: {
            name,
            arguments: args,
            _meta: {
              "io.modelcontextprotocol/protocolVersion": "2026-07-28",
              "io.modelcontextprotocol/clientCapabilities": {},
            },
          },
        });
        const req = request(
          {
            host: "127.0.0.1",
            port: server.address().port,
            path: "/hab/mcp",
            method: "POST",
            headers: {
              Host: "hub.example",
              ...(token ? { Authorization: token } : {}),
              "Content-Type": "application/json",
              Accept: "application/json",
              "MCP-Protocol-Version": "2026-07-28",
              "Mcp-Method": "tools/call",
              "Mcp-Name": name,
            },
          },
          (res) => {
            let data = "";
            res.on("data", (part) => {
              data += part;
            });
            res.once("end", () =>
              resolve({
                status: res.statusCode,
                body: data ? JSON.parse(data) : null,
              }),
            );
          },
        );
        req.once("error", reject);
        req.end(body);
      });
    const token = await sign();
    const positive = await send(token, "get", { id: READBACK_FIXTURE_ID });
    assert.equal(positive.status, 200);
    assert.equal(positive.body.result.isError, undefined);
    const returned = JSON.parse(positive.body.result.content[0].text);
    assert.equal(returned.id, READBACK_FIXTURE_ID);
    assert.equal(returned.result, RESPONSE);
    assert.equal(returned.actor, READBACK_FIXTURE_ACTOR);
    for (const overrides of [
      { sub: "unenrolled" },
      { azp: "other-client" },
      { aud: "https://wrong.example/mcp" },
      { iss: "https://wrong.us.auth0.com/" },
      { exp: 1 },
      { scope: "hub:submit" },
    ])
      assert.equal(
        (await send(await sign(overrides), "get", { id: READBACK_FIXTURE_ID }))
          .status,
        401,
      );
    assert.equal(
      (await send(undefined, "get", { id: READBACK_FIXTURE_ID })).status,
      401,
    );
    const missing = await send(token, "get", {
      id: "00000000-0000-0000-0000-000000000000",
    });
    assert.equal(missing.status, 200);
    assert.equal(missing.body.result.isError, true);
    assert.equal(missing.body.result.content[0].text, "Operation rejected");
    for (const [name, args] of [
      ["submit", { task_type: "connectivity_check", request_key: "forbidden" }],
      ["claim", {}],
      ["cancel", { id: READBACK_FIXTURE_ID }],
      ["heartbeat", { id: READBACK_FIXTURE_ID, fence: 1 }],
      [
        "complete",
        {
          id: READBACK_FIXTURE_ID,
          fence: 1,
          state: "succeeded",
          result: RESPONSE,
        },
      ],
    ]) {
      const reply = await send(
        await sign({
          scope:
            "hub:get hub:submit hub:claim hub:cancel hub:heartbeat hub:complete",
        }),
        name,
        args,
      );
      assert.equal(reply.status, 200);
      assert.equal(reply.body.result.isError, true);
    }
    assert.ok(jwksCalls > 0);
    assert.deepEqual(counts(hub), {
      tasks: 1,
      outbox: 0,
      subscriptions: 0,
      diagnostic_outbox: 0,
      audit: 1,
    });
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    hub?.close();
    rmSync(root, { recursive: true, force: true });
  }
});
