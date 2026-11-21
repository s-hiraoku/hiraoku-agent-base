import { randomBytes, timingSafeEqual } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hostAdminErrorCode } from "../host/admin.ts";
import { dashboardAddresses, dashboardDiagnosis } from "./diagnostics.ts";

const loopback = "127.0.0.1";
const assets = [
  ["/", "index.html", "text/html"],
  ["/app.js", "app.js", "text/javascript"],
  ["/style.css", "style.css", "text/css"],
] as const;

function sendJson(response: ServerResponse, status: number, value: object) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
  });
  response.end(JSON.stringify(value));
}

function matchesAuthorization(expected: Buffer, value: string | undefined) {
  if (!value) return false;
  const received = Buffer.from(value);
  return (
    received.length === expected.length && timingSafeEqual(received, expected)
  );
}

export async function startDashboard(configPath: string) {
  const staticFiles = new Map<string, { body: Buffer; type: string }>(
    assets.map(([route, filename, type]) => [
      route,
      { body: readFileSync(new URL("web/" + filename, import.meta.url)), type },
    ]),
  );
  const token = randomBytes(32).toString("base64url");
  const expected = Buffer.from("Bearer " + token);
  let authority = "";
  const server = createServer((request, response) => {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader(
      "Content-Security-Policy",
      "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
    );

    if (request.headers.host !== authority)
      return sendJson(response, 403, { error: "forbidden" });
    if (request.method !== "GET") {
      response.setHeader("Allow", "GET");
      return sendJson(response, 405, { error: "method_not_allowed" });
    }

    const target = request.url ?? "";
    const queryAt = target.indexOf("?");
    const path = queryAt < 0 ? target : target.slice(0, queryAt);
    const asset = staticFiles.get(path);
    if (asset && queryAt < 0) {
      response.writeHead(200, {
        "Content-Type": asset.type + "; charset=utf-8",
      });
      response.end(asset.body);
      return;
    }
    if (path !== "/api/diagnostics" && path !== "/api/diagnosis")
      return sendJson(response, 404, { error: "not_found" });

    const origin = request.headers.origin;
    const fetchSite = request.headers["sec-fetch-site"];
    if (
      (origin !== undefined && origin !== "http://" + authority) ||
      (fetchSite !== undefined && fetchSite !== "same-origin")
    )
      return sendJson(response, 403, { error: "forbidden" });
    if (!matchesAuthorization(expected, request.headers.authorization))
      return sendJson(response, 401, { error: "unauthorized" });

    try {
      if (path === "/api/diagnostics") {
        if (queryAt >= 0)
          return sendJson(response, 400, { error: "invalid_query" });
        return sendJson(response, 200, dashboardAddresses(configPath));
      }

      const query = new URLSearchParams(
        queryAt < 0 ? "" : target.slice(queryAt + 1),
      );
      const address = query.get("address");
      if (!address || query.size !== 1)
        return sendJson(response, 400, { error: "invalid_query" });
      return sendJson(response, 200, dashboardDiagnosis(configPath, address));
    } catch (error) {
      const code = hostAdminErrorCode(error);
      if (code === "invalid_address")
        return sendJson(response, 400, { error: code });
      if (code === "address_not_found")
        return sendJson(response, 404, { error: code });
      return sendJson(response, 503, { error: "diagnosis_unavailable" });
    }
  });

  let launcherDirectory: string | undefined;
  let closing: Promise<void> | undefined;
  const close = () =>
    (closing ??= new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    }).finally(() => {
      if (launcherDirectory)
        rmSync(launcherDirectory, { recursive: true, force: true });
    }));

  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, loopback, () => {
        server.removeListener("error", reject);
        resolve();
      });
    });
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("dashboard_listener_unavailable");
    authority = loopback + ":" + address.port;
    launcherDirectory = mkdtempSync(join(tmpdir(), "hab-dashboard-"));
    const launcherPath = join(launcherDirectory, "open-dashboard.html");
    writeFileSync(
      launcherPath,
      '<!doctype html><html lang="ja"><head><meta charset="utf-8">' +
        '<meta name="referrer" content="no-referrer">' +
        '<meta http-equiv="refresh" content="0; url=http://' +
        authority +
        "/#" +
        token +
        '"><title>HAB を開く</title></head><body></body></html>',
      { flag: "wx", mode: 0o600 },
    );
    return { launcherPath, close };
  } catch (error) {
    await close();
    throw error;
  }
}
