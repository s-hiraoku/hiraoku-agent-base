import { readFileSync } from "node:fs";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { z } from "zod";
import { HostAdminError, hostAdminErrorCode } from "../host/admin.ts";
import { readHostConfig } from "../host/config.ts";
import { OperatorMail } from "../host/operator-mail.ts";
import { replayBoundSentAt } from "../messaging/contract.ts";
import { MessagingError } from "../messaging/delivery-service.ts";
import { isPublicToolError } from "../messaging/tool-errors.ts";
import { dashboardAddresses, dashboardDiagnosis } from "./diagnostics.ts";
import { DashboardSession, sessionPath } from "./session.ts";

const loopback = "127.0.0.1";
const assets = [
  ["/", "index.html", "text/html"],
  ["/app.js", "app.js", "text/javascript"],
  ["/style.css", "style.css", "text/css"],
] as const;

const diagnosticRoutes = new Set(["/api/diagnostics", "/api/diagnosis"]);
const mailRoutes = new Map([
  ["/api/mail", "GET"],
  ["/api/mail/status", "GET"],
  ["/api/mail/retry", "POST"],
  ["/api/mail/send", "POST"],
  ["/api/mail/reply", "POST"],
  ["/api/mail/ping", "POST"],
  ["/api/mail/inbox", "POST"],
]);

const action = z.enum(["send", "reply", "ping"]);
const operationId = z
  .string()
  .refine((id) => replayBoundSentAt(id) !== undefined);
const lookup = z.strictObject({ action, operation_id: operationId });
const postInput = z.discriminatedUnion("route", [
  z.strictObject({
    route: z.literal("/api/mail/send"),
    body: z.strictObject({
      operation_id: operationId,
      to: z.string(),
      text: z.string(),
    }),
  }),
  z.strictObject({
    route: z.literal("/api/mail/reply"),
    body: z.strictObject({
      operation_id: operationId,
      message_id: z.string(),
      text: z.string(),
    }),
  }),
  z.strictObject({
    route: z.literal("/api/mail/ping"),
    body: z.strictObject({ operation_id: operationId, to: z.string() }),
  }),
  z.strictObject({ route: z.literal("/api/mail/retry"), body: lookup }),
  z.strictObject({
    route: z.literal("/api/mail/inbox"),
    body: z.strictObject({
      read_history: z.string().min(1).max(512).optional(),
    }),
  }),
]);

type MailProfiles = { mailbox?: OperatorMail; ping?: OperatorMail };

const errorStatuses = new Map([
  ["invalid_address", 400],
  ["address_not_found", 404],
  ["invalid_request", 400],
  ["operation_not_found", 404],
  ["operation_conflict", 409],
  ["operation_expired", 409],
  ["operator_mail_full", 429],
  ["idempotency_conflict", 409],
  ["operator_mail_not_configured", 409],
  ["forbidden", 403],
  ["not_found", 404],
  ["unknown_address", 404],
  ["reply_target_not_found", 404],
  ["recipient_absent", 409],
  ["recipient_unavailable", 409],
  ["reply_target_expired", 409],
]);

class RequestError extends Error {
  readonly status: number;

  constructor(status: number, code: string) {
    super(code);
    this.status = status;
  }
}

function sendJson(response: ServerResponse, status: number, value: object) {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
  });
  response.end(body);
}

function reject(response: ServerResponse, status: number, error: string) {
  sendJson(response, status, { error });
}

function methodNotAllowed(response: ServerResponse, method: string) {
  response.setHeader("Allow", method);
  reject(response, 405, "method_not_allowed");
}

function sendError(response: ServerResponse, error: unknown, mail: boolean) {
  if (response.destroyed || response.writableEnded) return;
  if (error instanceof RequestError)
    return reject(response, error.status, error.message);
  const code =
    error instanceof MessagingError ? error.code : hostAdminErrorCode(error);
  const status = errorStatuses.get(code);
  if (status !== undefined) return reject(response, status, code);
  if (mail && isPublicToolError(code)) return reject(response, 400, code);
  reject(response, 503, mail ? "mail_unavailable" : "diagnosis_unavailable");
}

function parse<T>(
  schema: z.ZodType<T>,
  value: unknown,
  code = "invalid_request",
) {
  const result = schema.safeParse(value);
  if (!result.success) throw new RequestError(400, code);
  return result.data;
}

async function readBody(
  request: IncomingMessage,
  mediaType: string,
  maxBytes: number,
) {
  if (
    request.headers["content-type"]?.split(";", 1)[0].trim().toLowerCase() !==
    mediaType
  )
    throw new RequestError(415, "unsupported_media_type");
  if (Number(request.headers["content-length"]) > maxBytes)
    throw new RequestError(413, "request_too_large");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    if (!Buffer.isBuffer(chunk)) throw new RequestError(400, "invalid_request");
    size += chunk.length;
    if (size > maxBytes) throw new RequestError(413, "request_too_large");
    chunks.push(chunk);
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(
      Buffer.concat(chunks, size),
    );
  } catch {
    throw new RequestError(400, "invalid_request");
  }
}

function configuredProfiles(configPath: string): MailProfiles {
  const { config } = readHostConfig(configPath);
  const profiles = config.operator_mail;
  if (!profiles?.mailbox && !profiles?.ping)
    throw new HostAdminError("operator_mail_not_configured");
  return {
    ...(profiles.mailbox
      ? { mailbox: new OperatorMail(configPath, "mailbox") }
      : {}),
    ...(profiles.ping ? { ping: new OperatorMail(configPath, "ping") } : {}),
  };
}

function profileFor(profiles: MailProfiles, kind: z.infer<typeof action>) {
  const profile = kind === "ping" ? profiles.ping : profiles.mailbox;
  if (!profile) throw new HostAdminError("operator_mail_not_configured");
  return profile;
}

async function handleMail(
  request: IncomingMessage,
  path: string,
  query: string | undefined,
  profiles: MailProfiles,
  session: DashboardSession,
) {
  if (path === "/api/mail/status") {
    const fields = new URLSearchParams(query);
    if (fields.size !== 2) throw new RequestError(400, "invalid_query");
    const input = parse(
      lookup,
      {
        action: fields.get("action"),
        operation_id: fields.get("operation_id"),
      },
      "invalid_query",
    );
    return profileFor(profiles, input.action).status(input.operation_id);
  }
  if (query !== undefined) throw new RequestError(400, "invalid_query");
  if (path === "/api/mail") {
    const operations = [
      ...(profiles.mailbox?.list() ?? []),
      ...(profiles.ping?.list() ?? []),
    ].sort((first, second) =>
      second.expires_at.localeCompare(first.expires_at),
    );
    return {
      address: profiles.mailbox?.address ?? null,
      ping_enabled: profiles.ping !== undefined,
      ping_address: profiles.ping?.address ?? null,
      operations,
    };
  }

  const body = await readBody(request, "application/json", 64 * 1024);
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    throw new RequestError(400, "invalid_request");
  }
  const input = parse(postInput, { route: path, body: json });
  if (!session.authorized(request.headers.authorization))
    throw new RequestError(401, "unauthorized");
  switch (input.route) {
    case "/api/mail/send": {
      const { operation_id, to, text } = input.body;
      return profileFor(profiles, "send").submit(operation_id, {
        action: "send",
        to,
        text,
      });
    }
    case "/api/mail/reply": {
      const { operation_id, message_id, text } = input.body;
      return profileFor(profiles, "reply").submit(operation_id, {
        action: "reply",
        message_id,
        text,
      });
    }
    case "/api/mail/ping": {
      const { operation_id, to } = input.body;
      return profileFor(profiles, "ping").submit(operation_id, {
        action: "ping",
        to,
      });
    }
    case "/api/mail/retry":
      return profileFor(profiles, input.body.action).retry(
        input.body.operation_id,
      );
    case "/api/mail/inbox":
      return profileFor(profiles, "reply").inbox(input.body.read_history);
  }
}

function diagnose(configPath: string, path: string, query: string | undefined) {
  if (path === "/api/diagnostics") {
    if (query !== undefined) throw new RequestError(400, "invalid_query");
    return dashboardAddresses(configPath);
  }
  const fields = new URLSearchParams(query);
  const address = fields.get("address");
  if (!address || fields.size !== 1)
    throw new RequestError(400, "invalid_query");
  return dashboardDiagnosis(configPath, address);
}

export async function startDashboard(
  configPath: string,
  { operator = false }: { operator?: boolean } = {},
) {
  const staticFiles = new Map<string, { body: string; type: string }>(
    assets.map(([route, filename, type]) => [
      route,
      {
        body: readFileSync(new URL("web/" + filename, import.meta.url), "utf8"),
        type,
      },
    ]),
  );
  const profiles = operator ? configuredProfiles(configPath) : undefined;
  const session = new DashboardSession(operator ? "operator" : "viewer");
  let authority = "";
  const server = createServer(
    {
      maxHeaderSize: 8 * 1024,
      headersTimeout: 5000,
      requestTimeout: 10_000,
      connectionsCheckingInterval: 1000,
    },
    (request, response) => {
      void handle(request, response);
    },
  );
  server.maxConnections = 32;

  async function handle(request: IncomingMessage, response: ServerResponse) {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader(
      "Content-Security-Policy",
      "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
    );

    const method = request.method;
    if (method === "POST") response.setHeader("Connection", "close");
    if (request.headers.host !== authority)
      return reject(response, 403, "forbidden");
    const target = request.url ?? "";
    const queryAt = target.indexOf("?");
    const path = queryAt < 0 ? target : target.slice(0, queryAt);
    const query = queryAt < 0 ? undefined : target.slice(queryAt + 1);
    const origin = request.headers.origin;
    if (path === sessionPath) {
      if (method !== "POST") return methodNotAllowed(response, "POST");
      if (query !== undefined) return reject(response, 400, "invalid_query");
      const fetchMode = request.headers["sec-fetch-mode"];
      if (
        origin !== "null" ||
        (fetchMode !== undefined && fetchMode !== "navigate")
      )
        return reject(response, 403, "forbidden");
      try {
        const fields = new URLSearchParams(
          await readBody(request, "application/x-www-form-urlencoded", 256),
        );
        if (fields.size !== 1) return reject(response, 400, "invalid_request");
        const bearer = session.exchange(fields.get("launch"));
        if (!bearer) return reject(response, 401, "unauthorized");
        const page = staticFiles
          .get("/")!
          .body.replace(
            "<head>",
            `<head>\n    <meta name="hab-session" content="${bearer}">\n    <meta name="hab-role" content="${session.role}">`,
          );
        response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        response.end(page);
      } catch (error) {
        if (error instanceof RequestError)
          return reject(response, error.status, error.message);
        if (!response.destroyed) reject(response, 503, "session_unavailable");
      }
      return;
    }

    const asset = staticFiles.get(path);
    if (asset && query === undefined) {
      if (method !== "GET") return methodNotAllowed(response, "GET");
      response.writeHead(200, {
        "Content-Type": asset.type + "; charset=utf-8",
      });
      response.end(asset.body);
      return;
    }

    const mailMethod = mailRoutes.get(path);
    const allowed =
      mailMethod ?? (diagnosticRoutes.has(path) ? "GET" : undefined);
    if (allowed === undefined) return reject(response, 404, "not_found");
    if (method !== allowed) return methodNotAllowed(response, allowed);
    const expectedOrigin = "http://" + authority;
    const fetchSite = request.headers["sec-fetch-site"];
    if (
      ((method === "POST" || origin !== undefined) &&
        origin !== expectedOrigin) ||
      (fetchSite !== undefined && fetchSite !== "same-origin")
    )
      return reject(response, 403, "forbidden");
    if (!session.authorized(request.headers.authorization))
      return reject(response, 401, "unauthorized");
    if (mailMethod && !profiles) return reject(response, 403, "forbidden");

    try {
      const data =
        profiles && mailMethod
          ? await handleMail(request, path, query, profiles, session)
          : diagnose(configPath, path, query);
      sendJson(response, 200, data);
    } catch (error) {
      sendError(response, error, mailMethod !== undefined);
    }
  }

  let closing: Promise<void> | undefined;
  const close = () =>
    (closing ??= new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    }).finally(() => session.close()));

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
    return {
      launcherPath: session.writeLauncher("http://" + authority),
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}
