import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { get, request as nodeRequest } from "node:http";
import { dirname } from "node:path";
import test from "node:test";
import { URLSearchParams } from "node:url";
import { main as runHabAdmin } from "../scripts/hab-admin.ts";
import { startDashboard } from "../src/admin/server.ts";
import {
  hostAdminConnect,
  hostAdminReceive,
  hostAdminSession,
} from "../src/host/admin.ts";
import { startHost } from "../src/host/start.ts";
import { fixture } from "./host-service-fixtures.js";

test("dashboard reads live diagnostics through its loopback viewer", async (t) => {
  const f = await fixture(t);
  const host = await startHost(f.configPath);
  t.after(() => host.close());
  f.config.port = Number(new URL(host.url).port);
  f.write("service.local.json", f.config);

  const dashboard = await startDashboard(f.configPath);
  t.after(() => dashboard.close());
  const launchDirectory = dirname(dashboard.launcherPath);
  assert.equal(statSync(launchDirectory).mode & 0o777, 0o700);
  assert.equal(statSync(dashboard.launcherPath).mode & 0o777, 0o600);
  const launcher = readFileSync(dashboard.launcherPath, "utf8");
  const launchUrl = launcher.match(
    /action="(http:\/\/127\.0\.0\.1:\d+\/session)"/,
  );
  const launchProof = launcher.match(
    /name="launch" value="([A-Za-z0-9_-]{43})"/,
  );
  assert.ok(launchUrl, "launcher has a loopback form action");
  assert.ok(launchProof, "launcher has a separate proof");
  const browserUrl = new URL(launchUrl[1]);
  assert.equal(browserUrl.search + browserUrl.hash, "");
  const exchange = (proof, origin = "null") =>
    new Promise((resolve, reject) => {
      const launch = nodeRequest(
        browserUrl,
        {
          method: "POST",
          headers: {
            origin,
            "content-type": "application/x-www-form-urlencoded",
            "sec-fetch-mode": "navigate",
          },
        },
        (response) => {
          response.setEncoding("utf8");
          let body = "";
          response.on("data", (chunk) => (body += chunk));
          response.on("end", () =>
            resolve({
              body,
              headers: response.headers,
              status: response.statusCode,
            }),
          );
        },
      );
      launch.on("error", reject);
      launch.end(new URLSearchParams({ launch: proof }).toString());
    });
  assert.equal(
    (await exchange(launchProof[1], "http://127.0.0.1:1")).status,
    403,
  );
  const opened = await exchange(launchProof[1]);
  assert.equal(opened.status, 200);
  assert.equal(opened.headers["cache-control"], "no-store");
  assert.equal(opened.headers["set-cookie"], undefined);
  assert.match(opened.body, /name="hab-role" content="viewer"/);
  assert.ok(!opened.body.includes(launchProof[1]));
  const sessionCredential = opened.body.match(
    /name="hab-session" content="([A-Za-z0-9_-]{43})"/,
  );
  assert.ok(sessionCredential);
  const bearer = sessionCredential[1];
  assert.equal((await exchange(launchProof[1])).status, 401);

  const request = (path, options) =>
    globalThis.fetch(new URL(path, browserUrl), options);
  const headers = {
    authorization: "Bearer " + bearer,
    origin: browserUrl.origin,
    "sec-fetch-site": "same-origin",
  };
  const main = await request("/");
  assert.equal(main.status, 200);
  assert.equal(main.headers.get("cache-control"), "no-store");
  assert.match(
    main.headers.get("content-security-policy"),
    /frame-ancestors 'none'/,
  );
  const html = await main.text();
  assert.match(html, /エージェントをつなぐ/);
  assert.ok(!html.includes(bearer));
  for (const path of ["/app.js", "/style.css"]) {
    const asset = await request(path);
    assert.equal(asset.status, 200);
    assert.ok(!(await asset.text()).includes(bearer));
  }

  const anonymous = await request("/api/diagnostics");
  assert.equal(anonymous.status, 401);
  assert.deepEqual(await anonymous.json(), { error: "unauthorized" });
  const differentOrigin = await request("/api/diagnostics", {
    headers: { ...headers, origin: "http://127.0.0.1:1" },
  });
  assert.equal(differentOrigin.status, 403);
  const crossSite = await request("/api/diagnostics", {
    headers: { ...headers, "sec-fetch-site": "same-site" },
  });
  assert.equal(crossSite.status, 403);
  assert.equal(crossSite.headers.get("access-control-allow-origin"), null);
  const wrongHost = await new Promise((resolve, reject) => {
    get(
      new URL("/api/diagnostics", browserUrl),
      { headers: { ...headers, host: "example.invalid" } },
      (response) => {
        response.resume();
        resolve(response.statusCode);
      },
    ).on("error", reject);
  });
  assert.equal(wrongHost, 403);

  const mutation = await request("/api/diagnostics", {
    method: "POST",
    headers,
  });
  assert.equal(mutation.status, 405);
  assert.equal(mutation.headers.get("allow"), "GET");
  assert.equal((await request("/api/mail", { headers })).status, 403);
  const viewerWrite = await request("/api/mail/inbox", {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: "{}",
  });
  assert.equal(viewerWrite.status, 403);
  assert.equal(
    (await request("/api/diagnostics?all=true", { headers })).status,
    400,
  );
  assert.equal(
    (await request("/api/diagnosis?address=a&address=b", { headers })).status,
    400,
  );
  assert.equal(
    (await request("/api/diagnosis?address=bad%20address", { headers })).status,
    400,
  );
  assert.equal(
    (await request("/api/diagnosis?address=unknown%40demo.hab", { headers }))
      .status,
    404,
  );

  const empty = await request("/api/diagnostics", { headers });
  assert.deepEqual(await empty.json(), { addresses: [] });

  const now = Date.now();
  const secret = "synthetic-local-credential".repeat(3);
  const connectionId = "dashboard-test-connection-id";
  const session = "private-dashboard-session";
  const address = "reader@demo.hab";
  f.write("credentials.local.json", {
    version: 1,
    credentials: [
      {
        sha256: createHash("sha256").update(secret).digest("hex"),
        principal: {
          issuer: "urn:synthetic:local",
          audience: host.url,
          subject: "synthetic-operator-subject",
          client_id: "synthetic-dashboard-client",
          connection_id: connectionId,
        },
        issued_at: new Date(now - 1000).toISOString(),
        expires_at: new Date(now + 600000).toISOString(),
      },
    ],
  });
  hostAdminConnect(f.configPath, { address, connection_id: connectionId });
  hostAdminReceive(f.configPath, {
    agent_name: "demo",
    mode: "on_request",
    request_id: "dashboard-receive",
  });
  hostAdminSession(f.configPath, {
    address,
    session,
    request_id: "dashboard-session",
  });

  const list = await request("/api/diagnostics", { headers });
  assert.equal(list.status, 200);
  const { addresses } = await list.json();
  const cliList = runHabAdmin(["--config", f.configPath, "doctor"]);
  assert.deepEqual(
    addresses,
    cliList.addresses.map((entry) => ({
      ...entry,
      registry_state: "active",
    })),
  );

  const detail = await request(
    "/api/diagnosis?" + new URLSearchParams({ address }),
    { headers },
  );
  assert.equal(detail.status, 200);
  const json = await detail.text();
  for (const privateValue of [bearer, secret, session, connectionId, host.url])
    assert.ok(!json.includes(privateValue), "detail omits private values");
  const diagnosis = JSON.parse(json);
  const cli = runHabAdmin([
    "--config",
    f.configPath,
    "doctor",
    "--address",
    address,
  ]);
  assert.equal(diagnosis.address, cli.address);
  for (const [key, { evidence, ...check }] of Object.entries(
    diagnosis.checks,
  )) {
    const cliCheck = cli.checks[key];
    assert.deepEqual(check, {
      state: cliCheck.state,
      reason: cliCheck.reason,
      next_action: cliCheck.next_action,
    });
    for (const [field, value] of Object.entries(evidence))
      assert.equal(value, cliCheck.evidence[field]);
  }
  assert.deepEqual(diagnosis.checks.receive.evidence, { mode: "on_request" });
  assert.deepEqual(diagnosis.checks.session.evidence, {});
  assert.equal(cli.checks.session.evidence.session, session);

  const renewedProof = readFileSync(dashboard.launcherPath, "utf8").match(
    /name="launch" value="([A-Za-z0-9_-]{43})"/,
  );
  assert.ok(renewedProof);
  assert.notEqual(renewedProof[1], launchProof[1]);
  const renewed = await exchange(renewedProof[1]);
  assert.equal(renewed.status, 200);
  assert.equal((await request("/api/diagnostics", { headers })).status, 401);
  const renewedSession = renewed.body.match(
    /name="hab-session" content="([A-Za-z0-9_-]{43})"/,
  );
  assert.ok(renewedSession);
  const current = {
    headers: { ...headers, authorization: "Bearer " + renewedSession[1] },
  };
  assert.equal((await request("/api/diagnostics", current)).status, 200);
  const expired = globalThis.performance.now() + 16 * 60_000;
  const clock = t.mock.method(globalThis.performance, "now", () => expired);
  assert.equal((await request("/api/diagnostics", current)).status, 401);
  clock.mock.restore();

  await dashboard.close();
  assert.ok(!existsSync(launchDirectory));
});
