import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { createServer, request as nodeRequest } from "node:http";
import { promisify } from "node:util";
import process from "node:process";
import { join } from "node:path";
import { URLSearchParams } from "node:url";
import { test } from "node:test";
import { startDashboard } from "../src/admin/server.ts";
import { readDoorbells } from "../src/hab/events.ts";
import { hostAdminDoorbellAdd } from "../src/host/admin-doorbells.ts";
import { operationId, operatorFixture } from "./host-operator-fixtures.js";
import { eventually } from "./delivery-fixture.js";

const run = promisify(execFile);

async function dashboardClient(t, configPath, operator = true) {
  const dashboard = await startDashboard(configPath, { operator });
  t.after(() => dashboard.close());
  const launcher = readFileSync(dashboard.launcherPath, "utf8");
  const target = launcher.match(
    /action="(http:\/\/127\.0\.0\.1:\d+\/session)"/,
  )?.[1];
  const launch = launcher.match(/name="launch" value="([A-Za-z0-9_-]+)"/)?.[1];
  assert.ok(
    target && launch,
    "launcher contains a form without credentials in its URL",
  );
  const origin = new URL(target).origin;
  const { status, body } = await new Promise((resolve, reject) => {
    const request = nodeRequest(
      target,
      {
        method: "POST",
        headers: {
          origin: "null",
          "sec-fetch-mode": "navigate",
          "content-type": "application/x-www-form-urlencoded",
        },
      },
      (response) => {
        response.setEncoding("utf8");
        let body = "";
        response.on("data", (chunk) => {
          body += chunk;
        });
        response.on("end", () =>
          resolve({ status: response.statusCode, body }),
        );
      },
    );
    request.on("error", reject);
    request.end(new URLSearchParams({ launch }).toString());
  });
  assert.equal(status, 200);
  const token = body.match(
    /<meta name="hab-session" content="([A-Za-z0-9_-]+)">/,
  )?.[1];
  assert.ok(token);
  assert.notEqual(token, launch);
  const headers = { authorization: "Bearer " + token, origin };
  async function call(path, payload, overrides = {}) {
    const response = await globalThis.fetch(new URL(path, origin), {
      ...(payload === undefined
        ? {}
        : { method: "POST", body: JSON.stringify(payload) }),
      headers: {
        ...headers,
        ...(payload === undefined
          ? {}
          : { "content-type": "application/json" }),
        ...overrides,
      },
    });
    return { status: response.status, body: await response.json() };
  }
  return { dashboard, call, origin, headers };
}

async function losesFirstSendResponse(t, f) {
  let lost = 0;
  const server = createServer(async (req, res) => {
    try {
      const buffers = [];
      for await (const chunk of req) buffers.push(chunk);
      const body = Buffer.concat(buffers);
      const target = new URL(req.url, f.host.url);
      const headers = new globalThis.Headers();
      for (const [key, value] of Object.entries(req.headers))
        if (
          typeof value === "string" &&
          !["host", "connection", "content-length"].includes(key)
        )
          headers.set(key, value);
      const host = await globalThis.fetch(target, {
        method: req.method,
        headers,
        body,
      });
      const response = Buffer.from(await host.arrayBuffer());
      if (req.headers["mcp-name"] === "hab_send" && !lost && host.ok) {
        lost++;
        res.destroy();
        return;
      }
      res.writeHead(host.status, {
        "content-type": host.headers.get("content-type") ?? "application/json",
      });
      res.end(response);
    } catch {
      res.destroy();
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(
    () =>
      new Promise((resolve) => {
        server.close(resolve);
        server.closeAllConnections();
      }),
  );
  f.config.port = server.address().port;
  f.write("service.local.json", f.config);
  return () => lost;
}

test("CLI ping and the operator dashboard observe the same notice, read and reply", async (t) => {
  const f = await operatorFixture(t, { events: true });
  let rings = 0;
  const callback = createServer((request, response) => {
    request.resume();
    request.once("end", () => {
      if (request.method === "POST" && request.url === "/wake") rings++;
      response.writeHead(204);
      response.end();
    });
  });
  await new Promise((resolve) => callback.listen(0, "127.0.0.1", resolve));
  t.after(
    () =>
      new Promise((resolve) => {
        callback.close(resolve);
        callback.closeAllConnections();
      }),
  );
  const secretFile = join(f.dir, "doorbell-secret");
  writeFileSync(secretFile, f.bearers.recipient, { mode: 0o600 });
  hostAdminDoorbellAdd(f.configPath, {
    address: f.recipient,
    url: "http://127.0.0.1:" + callback.address().port + "/wake",
    secret_file: secretFile,
  });
  assert.ok(
    await eventually(() =>
      [
        ...readDoorbells(join(f.config.directory, "events.sqlite")).values(),
      ].some(({ operator }) => operator === 1),
    ),
    "the host has applied the new doorbell",
  );
  const op = operationId();
  const runPing = (...args) =>
    run(
      process.execPath,
      ["scripts/hab-admin.ts", "--config", f.configPath, "ping", ...args],
      { timeout: 8000 },
    ).then(({ stdout }) => JSON.parse(stdout));

  const sent = await runPing(
    "--address",
    f.recipient,
    "--request-id",
    op,
    "--wait",
    "2",
  );
  assert.equal(sent.operation_id, op);
  assert.notEqual(sent.message_id, op);
  assert.equal(sent.state, "pending");
  assert.ok(sent.accepted_at);
  assert.equal(sent.acked_at, null);
  assert.ok(rings > 0);
  assert.ok(sent.doorbell_at);
  assert.ok(Date.parse(sent.doorbell_at) >= Date.parse(sent.accepted_at));

  const { messages } = await f.call("recipient", "hab_inbox");
  assert.equal(messages.length, 1);
  assert.equal(messages[0].message_id, sent.message_id);
  assert.equal(messages[0].from, f.ping);
  assert.equal(messages[0].kind, "notice");
  assert.match(messages[0].text, /HAB の接続確認/);
  const reply = await f.call("recipient", "hab_reply", {
    message_id: sent.message_id,
    text: "届きました",
  });
  const cli = await runPing("--status", op);
  assert.equal(cli.acked_at, messages[0].read_at);
  assert.equal(cli.read_at, messages[0].read_at);
  assert.equal(cli.reply_at, reply.accepted_at);
  const { call } = await dashboardClient(t, f.configPath);
  const { body } = await call(
    "/api/mail/status?" +
      new URLSearchParams({ action: "ping", operation_id: op }),
  );
  assert.deepEqual(body, cli);
  const peerInbox = await f.call("recipient", "hab_inbox", {
    include_read: true,
  });
  assert.equal(
    peerInbox.messages.filter(
      ({ message_id }) => message_id === sent.message_id,
    ).length,
    1,
  );
  assert.deepEqual((await call("/api/mail/inbox", {})).body, { messages: [] });
});

test("the dashboard recovers a send after response loss and replies as the approved mailbox", async (t) => {
  const f = await operatorFixture(t);
  const op = operationId();
  await f.call("mailbox", "hab_send", {
    to: f.recipient,
    request_id: op,
    text: "既存の別メッセージ",
  });
  const lost = await losesFirstSendResponse(t, f);
  const draft = { operation_id: op, to: f.recipient, text: "接続を確認します" };
  const viewer = await dashboardClient(t, f.configPath, false);
  const page = await dashboardClient(t, f.configPath);
  assert.notEqual((await viewer.call("/api/mail/send", draft)).status, 200);
  assert.equal(
    (
      await page.call("/api/mail/send", draft, {
        origin: "https://different.example",
      })
    ).status,
    403,
  );

  const first = await page.call("/api/mail/send", draft);
  assert.equal(first.body.state, "unknown");
  assert.equal(lost(), 1);
  await page.dashboard.close();

  const reopened = await dashboardClient(t, f.configPath);
  const history = await reopened.call("/api/mail");
  assert.equal(history.body.address, f.mailbox);
  assert.ok(
    history.body.operations.some(
      ({ operation_id, state }) => operation_id === op && state === "unknown",
    ),
  );
  const retry = await reopened.call("/api/mail/retry", {
    operation_id: op,
    action: "send",
  });
  assert.equal(retry.body.state, "pending");
  const deliveryId = retry.body.message_id;
  assert.notEqual(deliveryId, op);
  f.write("mailbox.local.json", {
    version: 1,
    bearer: "expired-fixture-bearer",
  });
  const unavailable = await reopened.call(
    "/api/mail/status?" +
      new URLSearchParams({
        action: "send",
        operation_id: op,
      }),
  );
  assert.equal(unavailable.body.message_id, deliveryId);
  assert.ok(unavailable.body.problem, "connection refusal remains visible");
  f.write("mailbox.local.json", { version: 1, bearer: f.bearers.mailbox });
  const duplicate = await reopened.call("/api/mail/send", draft);
  assert.equal(duplicate.body.message_id, deliveryId);
  assert.equal(duplicate.body.problem, null);
  assert.deepEqual(
    await reopened.call("/api/mail/send", { ...draft, text: "changed" }),
    { status: 409, body: { error: "operation_conflict" } },
  );

  const received = (await f.call("recipient", "hab_inbox")).messages;
  assert.equal(received.length, 2);
  assert.deepEqual(
    received
      .filter(({ message_id }) => message_id === deliveryId)
      .map(({ text }) => text),
    [draft.text],
  );
  const incoming = await f.call("recipient", "hab_reply", {
    message_id: deliveryId,
    text: "受信しました",
  });
  const inbox = (await reopened.call("/api/mail/inbox", {})).body.messages;
  assert.deepEqual(
    inbox.map((message) => [
      message.message_id,
      message.in_reply_to,
      message.text,
    ]),
    [[incoming.message_id, deliveryId, "受信しました"]],
  );
  const answer = await reopened.call("/api/mail/reply", {
    operation_id: operationId(),
    message_id: incoming.message_id,
    text: "確認ありがとうございます",
  });
  assert.equal(answer.status, 200, JSON.stringify(answer.body));
  assert.equal(
    (await f.call("recipient", "hab_inbox")).messages[0].in_reply_to,
    incoming.message_id,
  );
});

test("the dashboard can reply to earlier read messages without reading new mail", async (t) => {
  const f = await operatorFixture(t);
  let firstId;
  for (let index = 0; index < 3; index++) {
    for (let offset = 0; offset < 4; offset++) {
      const outgoing = await f.call("recipient", "hab_send", {
        to: f.mailbox,
        text: "既読ページのメッセージ " + (index * 4 + offset),
      });
      firstId ??= outgoing.message_id;
    }
    await f.call("mailbox", "hab_inbox");
  }
  const unread = await f.call("recipient", "hab_send", {
    to: f.mailbox,
    text: "新しい未読",
  });
  const { call } = await dashboardClient(t, f.configPath);
  const page = await call("/api/mail/inbox", { read_history: "start" });
  assert.equal(page.status, 200, JSON.stringify(page.body));
  assert.equal(page.body.messages.length, 10);
  assert.ok(page.body.next_cursor);
  const earlier = await call("/api/mail/inbox", {
    read_history: page.body.next_cursor,
  });
  assert.equal(earlier.status, 200, JSON.stringify(earlier.body));
  assert.equal(earlier.body.messages.length, 2);
  assert.equal(
    new Set(
      [...page.body.messages, ...earlier.body.messages].map(
        ({ message_id }) => message_id,
      ),
    ).size,
    12,
  );
  assert.ok(
    earlier.body.messages.some(({ message_id }) => message_id === firstId),
  );

  const answer = await call("/api/mail/reply", {
    operation_id: operationId(),
    message_id: firstId,
    text: "前のメッセージを確認しました",
  });
  assert.equal(answer.status, 200, JSON.stringify(answer.body));
  assert.equal(
    (await f.call("recipient", "hab_inbox")).messages[0].in_reply_to,
    firstId,
  );
  assert.deepEqual(
    (await f.call("mailbox", "hab_inbox")).messages.map(
      ({ message_id }) => message_id,
    ),
    [unread.message_id],
  );
});
