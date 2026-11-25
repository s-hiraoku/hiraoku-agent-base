/**
 * docs/receiver/session-routing.md: one notifier process for one product. The product file
 * names the doorbell and a directory; each `*.json` there is one session's notify.json, built
 * into one SessionUnit with its own store, screen and HAB client. `--config x run` is the same
 * product with one session.
 */
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";
import process from "node:process";
import { z } from "zod";
import { OAuthTokenFile } from "../../src/agent-notify/oauth-token.ts";
import {
  PROBE_MS,
  SessionTable,
  address,
  parseRing,
  runProduct,
  type ProductRunOptions,
  type SessionUnit,
} from "../../src/agent-notify/product-host.ts";
import {
  PROBE_TIMEOUT_MS,
  sessionProbe,
} from "../../src/agent-notify/session-probe.ts";
import { startWakeListener } from "../../src/agent-notify/wake-listener.ts";
import { MessagingError } from "../../src/messaging/delivery-service.ts";
import {
  boundScreen,
  configSchema,
  createNotifier,
  errorCode,
  expand,
  oauthOptions,
  oauthSource,
  readWakeSecret,
  shellWord,
  tokenSource,
  type NotifyConfig,
  type TokenSource,
} from "./notify-config.ts";
import { createNotifyCheckLog } from "./notify-check-log.ts";

type Wake = NonNullable<NotifyConfig["wake"]>;

const productSchema = z.strictObject({
  wake: configSchema.shape.wake.unwrap(),
  sessions_dir: z.string().min(1),
});

type StandaloneSession = Omit<NotifyConfig, "wake">;
type AddressedSession = StandaloneSession & { as_address: string };

type Product =
  | {
      readonly wake: Wake;
      readonly sessions: readonly AddressedSession[];
      readonly single?: undefined;
    }
  | {
      readonly wake: Wake | undefined;
      readonly sessions: readonly [StandaloneSession];
      readonly single: true;
    };

const refused = (code: string, file: string) =>
  new MessagingError(code, { details: { files: [file] } });

function readJson<T>(path: string, schema: z.ZodType<T>, code: string): T {
  try {
    return schema.parse(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    throw refused(code, basename(path));
  }
}

function sessionConfig(config: NotifyConfig, file: string): AddressedSession {
  const { wake, as_address, ...rest } = config;
  if (wake) throw refused("session_wake_not_allowed", file);
  if (!as_address) throw refused("as_address_required", file);
  try {
    address(as_address);
  } catch {
    throw refused("invalid_as_address", file);
  }
  return { ...rest, as_address };
}

export function readProduct(path: string): Product {
  const product = readJson(
    expand(path),
    productSchema,
    "invalid_product_config",
  );
  const dir = expand(product.sessions_dir);
  let files: string[];
  try {
    files = readdirSync(dir).filter((name) => name.endsWith(".json"));
  } catch {
    throw refused("sessions_dir_unreadable", basename(dir));
  }
  files.sort();
  return {
    wake: product.wake,
    sessions: files.map((name) =>
      sessionConfig(
        readJson(join(dir, name), configSchema, "invalid_session_config"),
        name,
      ),
    ),
  };
}

export function productOfOne(config: NotifyConfig): Product {
  const { wake, ...session } = config;
  return { wake, sessions: [session], single: true };
}

/** The ledger's session name is the product's own conversation ID, never a new field. */
export function sessionLabel(config: StandaloneSession): string {
  const screen = config.screen;
  switch (screen.type) {
    case "hermes-desktop":
    case "claude-code":
      return screen.session_id;
    case "codex":
      return screen.thread_id;
    case "antigravity":
      return screen.conversation_id;
    case "chatgpt-connector":
      return screen.conversation;
    case "jsonl":
      return screen.target;
  }
}

function refreshTokenHash(file: string): string | undefined {
  try {
    const stored = JSON.parse(readFileSync(file, "utf8")) as {
      refresh_token?: unknown;
    };
    return typeof stored.refresh_token === "string"
      ? createHash("sha256").update(stored.refresh_token).digest("hex")
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * TokenPool: one OAuthTokenFile per notifier grant in this process. A rotating refresh token
 * spent twice trips reuse detection and revokes the grant, so any second spender is refused.
 */
export function tokenPool(
  sessions: readonly StandaloneSession[],
): (config: StandaloneSession) => TokenSource {
  const grants = new Map<string, { key: string; token: OAuthTokenFile }>();
  const agentFiles = new Set<string>();
  for (const config of sessions) {
    if ("file" in config.token) agentFiles.add(expand(config.token.file));
    if (!("oauth" in config.token)) continue;
    const options = oauthOptions(config, config.token.oauth);
    const key = JSON.stringify(options);
    const grant = grants.get(options.file);
    if (!grant)
      grants.set(options.file, { key, token: new OAuthTokenFile(options) });
    else if (grant.key !== key) throw new MessagingError("token_file_conflict");
  }
  for (const file of grants.keys())
    if (agentFiles.has(file)) throw new MessagingError("agent_token_file");
  const owners = new Set<string>();
  for (const file of grants.keys()) {
    const hash = refreshTokenHash(file);
    if (hash === undefined) continue;
    if (owners.has(hash)) throw new MessagingError("refresh_token_shared");
    owners.add(hash);
  }
  for (const file of agentFiles) {
    const hash = refreshTokenHash(file);
    if (hash !== undefined && owners.has(hash))
      throw new MessagingError("refresh_token_shared");
  }
  return (config) =>
    "oauth" in config.token
      ? oauthSource(grants.get(expand(config.token.oauth.file))!.token)
      : tokenSource(config);
}

/** HAB waits 10 s for a ring, so the probe gets PROBE_MS and every ask runs it afresh. */
function presenceOf(config: StandaloneSession, single: boolean) {
  const screen = config.screen;
  if (
    (screen.type !== "hermes-desktop" && screen.type !== "antigravity") ||
    !screen.session_probe
  )
    return;
  const spec = screen.session_probe;
  const session =
    screen.type === "antigravity" ? screen.conversation_id : screen.session_id;
  if (single) return sessionProbe(spec, session);
  return sessionProbe(
    { ...spec, timeout_ms: Math.min(spec.timeout_ms ?? PROBE_MS, PROBE_MS) },
    session,
    { reuseMs: 0 },
  );
}

function unitOf(
  config: StandaloneSession,
  token: TokenSource,
  single: boolean,
): SessionUnit {
  const screen = boundScreen(config);
  const { notifier, store } = createNotifier(config, screen, token);
  const presence = presenceOf(config, single);
  return {
    address: single ? undefined : address(config.as_address),
    label: sessionLabel(config),
    exclusive: {
      store: expand(config.store),
      screen: expand(config.screen.path),
      binding: screen.target,
    },
    interval_ms: config.interval_ms,
    check: () => notifier.check(),
    ...(presence ? { presence } : {}),
    close: () => store.close(),
  };
}

export interface OpenProduct {
  readonly wake: Wake | undefined;
  readonly table: SessionTable;
  readonly configs: ReadonlyMap<SessionUnit, StandaloneSession>;
  readonly single: boolean;
}

export function openProduct(product: Product): OpenProduct {
  const token = tokenPool(product.sessions);
  const configs = new Map<SessionUnit, StandaloneSession>();
  const single = product.single === true;
  try {
    for (const config of product.sessions)
      configs.set(unitOf(config, token(config), single), config);
    const members = [...configs.keys()];
    return {
      wake: product.wake,
      table: single
        ? SessionTable.single(members[0]!)
        : SessionTable.of(members),
      configs,
      single,
    };
  } catch (error) {
    for (const unit of configs.keys()) unit.close();
    throw error;
  }
}

/** Same journaled ID for the same address and session, so pasting the line twice is a retry. */
const requestId = (recipient: string, label: string) =>
  "session-" +
  createHash("sha256")
    .update(`${recipient}\0${label}`)
    .digest("hex")
    .slice(0, 16);

async function units(opened: OpenProduct, out: (line: string) => void) {
  const { table, configs } = opened;
  try {
    for (const unit of table.units) {
      const recipient = unit.address ?? address(configs.get(unit)?.as_address);
      const presence =
        (await table.refreshPresence(unit)) ?? "probe_not_configured";
      out(
        JSON.stringify({
          address: recipient,
          session: unit.label,
          presence,
          register: [
            "npm run hab:admin -- --config <host-config> session",
            `--address ${recipient}`,
            `--session ${shellWord(unit.label)}`,
            `--request-id ${requestId(recipient, unit.label)}`,
          ].join(" "),
        }),
      );
    }
    return 0;
  } finally {
    for (const unit of table.units) unit.close();
  }
}

/** Preserve the one-config listener's signed wake behavior and optional address. */
const standaloneAnswer =
  (
    opened: OpenProduct,
    log: ReturnType<typeof createNotifyCheckLog>,
  ): NonNullable<ProductRunOptions["answer"]> =>
  async (body, wake) => {
    const unit = opened.table.units[0]!;
    const presence = await opened.table.refreshPresence(unit, PROBE_TIMEOUT_MS);
    if (presence) log.session(presence);
    if (presence === undefined || presence === "present") wake(unit);
    if (presence === undefined) return "accepted";
    const configAddress = opened.configs.get(unit)?.as_address;
    const ring = parseRing(body);
    if (
      !ring ||
      configAddress === undefined ||
      ring.to !== configAddress ||
      ring.session === ring.to ||
      ring.session !== unit.label ||
      presence === "unknown"
    )
      return "session_unconfirmed";
    return presence === "gone" ? "session_gone" : "accepted";
  };

async function run(opened: OpenProduct, out: (line: string) => void) {
  const { table, configs, wake, single } = opened;
  const stop = new AbortController();
  const abort = () => stop.abort();
  process.once("SIGTERM", abort);
  process.once("SIGINT", abort);
  // A repeating error, such as waiting for the agent to refresh its token, is logged once.
  const logs = new Map(
    table.units.map((unit) => [
      unit,
      createNotifyCheckLog(
        out,
        Date.now,
        unit.address ? { address: unit.address } : {},
      ),
    ]),
  );
  try {
    await runProduct(table, {
      stop: stop.signal,
      ...(single
        ? {
            presenceTimeoutMs: PROBE_TIMEOUT_MS,
            answer: standaloneAnswer(opened, logs.get(table.units[0]!)!),
          }
        : {
            ringLog: ({ reason, ring }) =>
              out(
                JSON.stringify({
                  at: new Date().toISOString(),
                  ring: { reason, ...ring },
                }),
              ),
          }),
      ...(wake
        ? {
            listen: (answer) =>
              startWakeListener({
                port: wake.port,
                secret: readWakeSecret(wake.secret_file),
                onWake: answer,
              }),
          }
        : {}),
      report: (unit, event) => {
        const log = logs.get(unit)!;
        if ("presence" in event) log.session(event.presence);
        else if ("error" in event)
          log.failed(errorCode(event.error, configs.get(unit)));
        else log.succeeded(event.shown, event.duration_ms);
      },
    });
    return 0;
  } catch (error) {
    const busy = (error as NodeJS.ErrnoException).code === "EADDRINUSE";
    out(
      JSON.stringify({ error: busy ? "wake_port_in_use" : errorCode(error) }),
    );
    return 1;
  } finally {
    process.removeListener("SIGTERM", abort);
    process.removeListener("SIGINT", abort);
  }
}

/** `run` and `units` for a product file, or for one `--config` as a product of one. */
export async function productCommand(
  load: () => Product,
  command: "run" | "units",
  out: (line: string) => void,
): Promise<number> {
  let opened: OpenProduct;
  try {
    const product = load();
    if (command === "units" && product.single) {
      sessionConfig(product.sessions[0], "config");
    }
    opened = openProduct(product);
  } catch (error) {
    out(
      JSON.stringify({
        error: errorCode(error),
        ...(error instanceof MessagingError ? error.details : {}),
      }),
    );
    return 1;
  }
  return command === "units" ? units(opened, out) : run(opened, out);
}
