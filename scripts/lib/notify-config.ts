/**
 * Shared notifier configuration, token, screen and notifier construction. Both the
 * `hab-notify` CLI and the product runner (scripts/lib/notify-product.ts) build on it, so
 * neither imports the other: the CLI entry awaits `main()` at the top level, and a cycle
 * through it would never settle (exit 13).
 */
import { lstatSync, readFileSync, renameSync } from "node:fs";
import { sessionProbe } from "../../src/agent-notify/session-probe.ts";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import { z } from "zod";
import {
  HabNotifierClient,
  HermesDesktopScreen,
  JsonlScreen,
  ProductScreen,
  AutoAcceptPolicy,
  AutoAudit,
  ReceiptNotifier,
  SQLiteNotices,
  autoAcceptConfigSchema,
  chatgptConnectorHandoff,
  chatgptConnectorTarget,
  claudeCodeHandoff,
  claudeCodeTarget,
  codexHandoff,
  codexQueueHandoff,
  antigravityHandoff,
  antigravityTarget,
  codexTarget,
} from "../../src/agent-notify/index.ts";
import { hermesDesktopAgentBinding } from "../../src/agent-notify/hermes-desktop.ts";
import { bindingIdentity } from "../../src/agent-notify/binding.ts";
import type { AgentScreen } from "../../src/agent-notify/index.ts";
import { MessagingError } from "../../src/messaging/delivery-service.ts";
import {
  OAuthTokenFile,
  jwtExpiry,
  validRedirectUri,
  validTokenUrl,
} from "../../src/agent-notify/oauth-token.ts";

/** A trusted command from this config: absolute argv[0] and cwd. */
const commandSchema = z.strictObject({
  command: z
    .array(z.string().min(1).max(4096))
    .min(1)
    .max(32)
    .refine((argv) => isAbsolute(argv[0]!), "absolute command"),
  cwd: z.string().refine((path) => isAbsolute(path), "absolute cwd"),
  env: z.record(z.string(), z.string()).optional(),
  timeout_ms: z.number().int().min(1000).max(300_000).optional(),
});
const label = z.string().min(1).max(2048);

export const configSchema = z.strictObject({
  /** The agent endpoint, such as https://host/hab/mcp; the delivery endpoint is <hab_url>/delivery. */
  hab_url: z.url(),
  agent_id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/),
  as_address: z.string().optional(),
  /** Where the recipient's bearer token is read before every call. */
  token: z.union([
    z.strictObject({
      file: z.string().min(1),
      field: z.string().min(1).default("access_token"),
      /**
       * Optional: the field holding the token's absolute expiry in epoch seconds (Hermes writes
       * `expires_at`). Past it, a call is not made and the notifier reports token_expired.
       */
      expires_at_field: z.string().min(1).optional(),
    }),
    z.strictObject({ env: z.string().min(1) }),
    /**
     * The notifier's own OAuth grant, which it refreshes itself (`login` once, then
     * automatic). Never the agent's own token file: both would spend one rotating refresh
     * token, and reuse detection would revoke the agent's grant too.
     */
    z.strictObject({
      oauth: z.strictObject({
        file: z.string().min(1),
        token_endpoint: z
          .string()
          .refine(validTokenUrl, "https token endpoint"),
        client_id: z.string().min(1).max(512),
        /** Defaults to hab_url. */
        resource: z.url().optional(),
        audience: z.string().min(1).max(2048).optional(),
        /** Needed only by `login`. */
        authorization_endpoint: z
          .string()
          .refine(validTokenUrl, "https authorization endpoint")
          .optional(),
        redirect_uri: z
          .string()
          .refine(validRedirectUri, "loopback redirect uri")
          .optional(),
        scope: z.string().min(1).max(4096).optional(),
        refresh_before_s: z.number().int().min(0).max(3600).default(60),
      }),
    }),
  ]),
  store: z.string().min(1),
  screen: z.discriminatedUnion("type", [
    z.strictObject({
      type: z.literal("jsonl"),
      path: z.string().min(1),
      /** The one session this notifier serves, such as hermes-desktop:<session id>. */
      target: z.string().min(1),
    }),
    z.strictObject({
      type: z.literal("hermes-desktop"),
      path: z.string().min(1),
      /** The saved Hermes conversation that shows the notices. */
      session_id: z.string().min(1).max(2048),
      profile: z.string().min(1).max(2048),
      /** Both must equal the reader's values in the Hermes profile config. */
      backend_namespace: z.string().min(1).max(2048),
      profile_scope: z.string().min(1).max(2048),
      /** Optional: hands the request to the conversation after 対応する (hermes_bridge.desktop_handoff). */
      handoff: commandSchema.optional(),
      /**
       * Optional, ADR-032: tells whether the conversation still exists
       * (hermes_bridge.desktop_session). Checking mail requires a present session.
       * A gone session only yields 410 for a signed ring for this address and session.
       */
      session_probe: commandSchema.optional(),
    }),
    z
      .strictObject({
        type: z.literal("codex"),
        path: z.string().min(1),
        /** The Codex thread the user works in. */
        thread_id: label,
        /** Optional: the running app-server that serves the thread; without it, unsupported. */
        app_server: z
          .strictObject({
            url: z.string().regex(/^wss?:\/\/[^\s]+$/),
            token_file: z.string().min(1).optional(),
            timeout_ms: z.number().int().min(1000).max(300_000).optional(),
          })
          .optional(),
        /** Optional: a Codex app conversation, reached by `codex queue` through the daemon. */
        queue: z
          .strictObject({
            codex_bin: z.string().refine(isAbsolute, "absolute codex_bin"),
            daemon_socket: z
              .string()
              .refine(isAbsolute, "absolute daemon_socket"),
          })
          .optional(),
        display_command: commandSchema.optional(),
      })
      .refine(
        (codex) => !(codex.app_server && codex.queue),
        "set app_server or queue, not both",
      ),
    z.strictObject({
      type: z.literal("antigravity"),
      path: z.string().min(1),
      /** The Antigravity CLI conversation the user works in (conversation_id). */
      conversation_id: label,
      /** Optional: hands the approved request to the conversation with `agy -p --conversation`. */
      cli: z
        .strictObject({
          agy_bin: z.string().refine(isAbsolute, "absolute agy_bin"),
          cwd: z.string().refine(isAbsolute, "absolute cwd"),
          log_file: z.string().min(1).optional(),
          timeout_ms: z.number().int().min(1000).max(120_000).optional(),
        })
        .optional(),
      /** Optional, ADR-032: tells whether the conversation still exists. */
      session_probe: commandSchema.optional(),
      display_command: commandSchema.optional(),
    }),
    z.strictObject({
      type: z.literal("claude-code"),
      path: z.string().min(1),
      /** The Claude Code session (the status line's session_id). */
      session_id: label,
      /** Optional: the hab-claude-channel socket; without it, unsupported. */
      channel_socket: z.string().min(1).optional(),
      display_command: commandSchema.optional(),
    }),
    z.strictObject({
      type: z.literal("chatgpt-connector"),
      path: z.string().min(1),
      /** A label for the ChatGPT conversation or project, such as dots. */
      conversation: label,
      display_command: commandSchema.optional(),
    }),
  ]),
  interval_ms: z.number().int().min(1000).max(3_600_000).default(15_000),
  /**
   * ADR-032: listen on 127.0.0.1:`port` for HAB's doorbell (an operator-registered
   * loopback doorbell) and check at once. `interval_ms` stays as the backup. The
   * `whsec_` key is read from an owner-only file, never written in this config.
   */
  wake: z
    .strictObject({
      port: z.number().int().min(1024).max(65_535),
      secret_file: z.string().min(1),
    })
    .optional(),
  /**
   * ADR-023: chooses 対応する without a click for the senders and kinds listed here. Absent
   * (the default): every message waits for the user.
   */
  auto_accept: autoAcceptConfigSchema.optional(),
});
export type NotifyConfig = z.infer<typeof configSchema>;

export const expand = (path: string) =>
  resolve(path.startsWith("~/") ? homedir() + path.slice(1) : path);

/** The doorbell key from an owner-only regular file (ADR-032). */
export function readWakeSecret(path: string): string {
  const file = expand(path);
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.mode & 0o077)
    throw new MessagingError("wake_secret_unsafe");
  const secret = readFileSync(file, "utf8").trim();
  if (!/^whsec_[A-Za-z0-9+/]+={0,2}$/.test(secret))
    throw new MessagingError("wake_secret_invalid");
  return secret;
}

export function readToken(config: Pick<NotifyConfig, "token">): string {
  let token: unknown;
  // The OAuth source is async (it may refresh); see tokenSource.
  if ("oauth" in config.token) throw new MessagingError("token_unavailable");
  if ("env" in config.token) token = process.env[config.token.env];
  else {
    const file = JSON.parse(
      readFileSync(expand(config.token.file), "utf8"),
    ) as Record<string, unknown>;
    token = file[config.token.field];
    const expiresAt = config.token.expires_at_field
      ? file[config.token.expires_at_field]
      : undefined;
    // The agent refreshes its own token; until it does, sending the old one is only refused.
    if (
      typeof expiresAt === "number" &&
      Number.isFinite(expiresAt) &&
      expiresAt * 1000 <= Date.now()
    )
      throw new MessagingError("token_expired");
  }
  if (typeof token !== "string" || token.length === 0)
    throw new MessagingError("token_unavailable");
  return token.startsWith("Bearer ") ? token : `Bearer ${token}`;
}

/** A token that expires within this many ms is treated as already expired. */
const TOKEN_SKEW_MS = 5_000;

/**
 * Checked before each call to HAB, so a call HAB would refuse is never sent. The agent
 * refreshes its own token; a missing or expired one is a wait, named as such, and the next
 * check tries again. Expiry comes from `expires_at_field` when configured, else from a JWT's
 * own `exp`; an opaque token without either is left to HAB.
 */
export function tokenProblem(
  config: Pick<NotifyConfig, "token">,
  now = Date.now(),
): string | undefined {
  let token: string;
  try {
    token = readToken(config);
  } catch (error) {
    return error instanceof MessagingError ? error.code : "token_unavailable";
  }
  const expiry = jwtExpiry(token.slice("Bearer ".length));
  return expiry !== undefined && expiry <= now + TOKEN_SKEW_MS
    ? "token_expired"
    : undefined;
}

type OAuthConfig = Extract<NotifyConfig["token"], { oauth: unknown }>["oauth"];

/** Everything that decides how the notifier's own grant is refreshed. */
export const oauthOptions = (config: NotifyConfig, oauth: OAuthConfig) => ({
  file: expand(oauth.file),
  token_endpoint: oauth.token_endpoint,
  client_id: oauth.client_id,
  resource: oauth.resource ?? config.hab_url,
  ...(oauth.audience ? { audience: oauth.audience } : {}),
  refresh_before_ms: oauth.refresh_before_s * 1000,
});

export const oauthToken = (config: NotifyConfig, oauth: OAuthConfig) =>
  new OAuthTokenFile(oauthOptions(config, oauth));

export interface TokenSource {
  authorization(): string | Promise<string>;
  ready(): string | undefined | Promise<string | undefined>;
}

export const oauthSource = (token: OAuthTokenFile): TokenSource => ({
  authorization: () => token.authorization(),
  ready: () => token.problem(),
});

/** The credential and the pre-call check for the configured token source. */
export function tokenSource(config: NotifyConfig): TokenSource {
  if ("oauth" in config.token)
    return oauthSource(oauthToken(config, config.token.oauth));
  return {
    authorization: () => readToken(config),
    ready: () => tokenProblem(config),
  };
}

export const hermesBinding = (
  config: NotifyConfig,
  screen: Extract<NotifyConfig["screen"], { type: "hermes-desktop" }>,
) => ({
  session_id: screen.session_id,
  profile: screen.profile,
  backend_namespace: screen.backend_namespace,
  profile_scope: screen.profile_scope,
  receiver_id: config.agent_id,
  connection_id: config.hab_url.replace(/\/+$/, ""),
});

type ScreenConfig = NotifyConfig["screen"];
export const claudeBinding = (
  screen: Extract<ScreenConfig, { type: "claude-code" }>,
) => ({
  session_id: screen.session_id,
  ...(screen.channel_socket
    ? { channel_socket: expand(screen.channel_socket) }
    : {}),
});

function configuredScreen(config: NotifyConfig): AgentScreen {
  const screen = config.screen;
  const path = expand(screen.path);
  const display =
    "display_command" in screen && screen.display_command
      ? { display_command: screen.display_command }
      : {};
  switch (screen.type) {
    case "jsonl":
      return new JsonlScreen(path, screen.target);
    case "hermes-desktop":
      return new HermesDesktopScreen(
        path,
        hermesBinding(config, screen),
        screen.handoff ? { handoff: screen.handoff } : {},
      );
    case "codex": {
      const binding = {
        thread_id: screen.thread_id,
        ...(screen.app_server
          ? {
              app_server: {
                ...screen.app_server,
                ...(screen.app_server.token_file
                  ? { token_file: expand(screen.app_server.token_file) }
                  : {}),
              },
            }
          : {}),
      };
      const queue = screen.queue && {
        codex_bin: resolve(screen.queue.codex_bin),
        daemon_socket: resolve(screen.queue.daemon_socket),
      };
      return new ProductScreen({
        path,
        target: codexTarget(binding),
        handoff_capability:
          screen.app_server || queue ? "bound-session" : "unsupported",
        ...display,
        handoff: (message) =>
          queue
            ? codexQueueHandoff({ ...binding, queue }, message)
            : codexHandoff(binding, message),
      });
    }
    case "antigravity": {
      const binding = {
        conversation_id: screen.conversation_id,
        ...(screen.cli
          ? {
              cli: {
                ...screen.cli,
                agy_bin: resolve(screen.cli.agy_bin),
                cwd: resolve(screen.cli.cwd),
                ...(screen.cli.log_file
                  ? { log_file: expand(screen.cli.log_file) }
                  : {}),
              },
            }
          : {}),
      };
      return new ProductScreen({
        path,
        target: antigravityTarget(binding),
        handoff_capability: screen.cli ? "bound-session" : "unsupported",
        ...display,
        handoff: (message) => antigravityHandoff(binding, message),
      });
    }
    case "claude-code": {
      const binding = claudeBinding(screen);
      return new ProductScreen({
        path,
        target: claudeCodeTarget(binding),
        ...display,
        handoff: (message) => claudeCodeHandoff(binding, message),
      });
    }
    case "chatgpt-connector":
      return new ProductScreen({
        path,
        target: chatgptConnectorTarget(screen),
        ...display,
        handoff: chatgptConnectorHandoff,
      });
  }
}

/** ADR-032: whether the bound conversation still exists, when the config can ask. */
export const configuredProbe = (config: NotifyConfig) => {
  const screen = config.screen;
  if (screen.type === "hermes-desktop" && screen.session_probe)
    return sessionProbe(screen.session_probe, screen.session_id);
  if (screen.type === "antigravity" && screen.session_probe)
    return sessionProbe(screen.session_probe, screen.conversation_id);
  return undefined;
};

/** Connection + recipient + product session fence for every configured adapter. */
export function boundScreen(config: NotifyConfig): AgentScreen {
  const screen = configuredScreen(config);
  const product = config.screen;
  // The tuple keeps its three entries for the older products: their stores were recorded
  // under this encoding. Only Antigravity adds a fourth, the agy it hands requests to.
  const connection = JSON.stringify([
    config.hab_url.replace(/\/+$/, ""),
    product.type === "codex"
      ? product.queue
        ? `unix://${resolve(product.queue.daemon_socket)}`
        : (product.app_server?.url ?? null)
      : null,
    product.type === "claude-code" ? (product.channel_socket ?? null) : null,
    ...(product.type === "antigravity"
      ? [product.cli ? resolve(product.cli.agy_bin) : null]
      : []),
  ]);
  const binding =
    product.type === "hermes-desktop"
      ? hermesDesktopAgentBinding(hermesBinding(config, product))
      : {
          product: product.type,
          connection_id: connection,
          recipient_id: config.agent_id,
          session_id: screen.target,
        };
  return {
    ...(screen.capabilities ? { capabilities: screen.capabilities } : {}),
    binding,
    target: bindingIdentity(binding),
    show: (message) => screen.show(message),
    handoff: (message) => screen.handoff(message),
    report: (message, state) =>
      screen.report?.(message, state) ?? Promise.resolve(),
  };
}

/** `statusline`: the Claude Code status line for the bound session; never calls HAB. */
/** Quotes one shell word unless it is plainly safe. */
export const shellWord = (word: string) =>
  /^[A-Za-z0-9_./:=@+-]+$/.test(word)
    ? word
    : `'${word.replaceAll("'", "'\\''")}'`;

export function createNotifier(
  config: NotifyConfig,
  screen?: AgentScreen,
  token = tokenSource(config),
) {
  const base = {
    agent_id: config.agent_id,
    max_request_bytes: 65536,
    max_response_bytes: 4 * 1024 * 1024,
    timeout_ms: 30_000,
    max_active_requests: 4,
    max_sse_events: 16,
    max_sse_lines: 4096,
    max_json_depth: 32,
    max_json_nodes: 100_000,
  };
  const limits = {
    envelope_bytes: 1024 * 1024,
    text_bytes: 512 * 1024,
    data_bytes: 512 * 1024,
    parts: 32,
    json_depth: 32,
    json_nodes: 100_000,
  };
  const common = {
    limits,
    authorization: token.authorization,
    ...(config.as_address ? { as_address: config.as_address } : {}),
  };
  const url = config.hab_url.replace(/\/+$/, "");
  const hab = new HabNotifierClient(
    { ...common, policy: { ...base, resource_url: `${url}/delivery` } },
    token.ready,
  );
  const target = screen ?? boundScreen(config);
  const store = new SQLiteNotices(expand(config.store), target.target);
  const auto = config.auto_accept;
  return {
    notifier: new ReceiptNotifier({
      hab,
      screen: target,
      store,
      ...(auto
        ? {
            autoAccept: {
              policy: new AutoAcceptPolicy(auto),
              audit: new AutoAudit(expand(auto.audit), {
                rename: renameSync,
                size: (path) => {
                  try {
                    return lstatSync(path).size;
                  } catch {
                    return undefined;
                  }
                },
              }),
            },
          }
        : {}),
    }),
    store,
  };
}

/**
 * The MCP transport reports a credential that could not be read as transport_failed. When
 * the token itself is the cause (expired or missing), that is named instead.
 */
export function errorCode(error: unknown, config?: NotifyConfig): string {
  const code = error instanceof MessagingError ? error.code : "failed";
  if (code !== "transport_failed" || !config || "oauth" in config.token)
    return code;
  try {
    readToken(config);
  } catch (tokenError) {
    if (tokenError instanceof MessagingError) return tokenError.code;
  }
  return code;
}
