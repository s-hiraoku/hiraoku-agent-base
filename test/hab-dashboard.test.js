import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { get } from "node:http";
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
  const launchUrl = launcher.match(/url=(http:\/\/127\.0\.0\.1:\d+\/#[^"]+)"/);
  assert.ok(launchUrl, "launcher has a loopback destination");
  const browserUrl = new URL(launchUrl[1]);
  const bearer = browserUrl.hash.slice(1);
  assert.ok(/^[A-Za-z0-9_-]{43}$/.test(bearer));
  browserUrl.hash = "";

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

  await dashboard.close();
  assert.ok(!existsSync(launchDirectory));
});
