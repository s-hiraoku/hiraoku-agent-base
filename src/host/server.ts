/** Explicit local composition. Import performs no IO, authentication or scheduling. */
import {
  HabEvents,
  doorbellSecret,
  operatorCallbackUrl,
} from "../hab/events.ts";
import { readDoorbellSecretFile } from "./doorbell-secret.ts";
import type { HabEventOptions, HabEventSource } from "../hab/events.ts";
import type { Server } from "node:http";
import { createServer } from "node:http";
import { once } from "node:events";
import {
  lstatSync,
  realpathSync,
  openSync,
  closeSync,
  constants,
} from "node:fs";
import { isAbsolute, join } from "node:path";
import { SQLiteHostOwner } from "./sqlite-host-owner.ts";
import { SQLiteHabRegistry } from "../hab/sqlite-registry.ts";
import type { RegistryOptions } from "../hab/sqlite-registry.ts";
import type { RegistryAuthority } from "../hab/registry.ts";
import type { HabMcpService } from "../hab/mcp.ts";
import { HabHttpGateway } from "../hab/http.ts";
import { validateLimits } from "../messaging/contract.ts";
import type { ContractLimits } from "../messaging/contract.ts";
import type { McpHttpPolicy, McpHttpVerifier } from "./mcp/http.ts";
import { routeMcpNodeHandlers } from "./mcp/http-node.ts";
import type { AuditSink } from "../security.ts";

export interface HostServerOptions {
  /** Existing canonical, owner-only directory dedicated to this host. */
  directory: string;
  /** 0 selects an ephemeral loopback port for a supervised test. */
  port: number;
  limits: ContractLimits;
  registry: RegistryOptions;
  http: Omit<
    McpHttpPolicy,
    "resource_url" | "allowed_origins" | "oauth_issuer"
  >;
  /** Separate loopback ingress behind approved TLS; same owner, Registry and queue. */
  ingress?: {
    port: number;
    resource_url: string;
    issuer: string;
    allowed_origins: readonly string[];
    authority: RegistryAuthority;
    verify: McpHttpVerifier;
    /** MCP events for new mail on the agent endpoint (ADR-022). Absent means off. */
    events?: Omit<HabEventOptions, "store"> & {
      /** Operator-registered doorbells with their secrets already read (ADR-029). */
      doorbells?: readonly { address: string; url: string; secret: string }[];
      /** Retired with ADR-031 by ADR-032: still accepted in a config, never used. */
      inbox_check?: {
        interval_ms?: number;
        max_rings?: number;
        addresses?: Readonly<Record<string, number>>;
      };
    };
  };
  /** Independently verified individual mapping; no model-supplied agent name. */
  authority: RegistryAuthority;
  verify: McpHttpVerifier;
  audit: AuditSink;
  /** The delivery backend. The host wires it and never chooses between backends. */
  delivery: DeliveryFactory;
}

export interface DeliveryDependencies {
  registry: SQLiteHabRegistry;
  limits: ContractLimits;
  directory: string;
  assertOwner(): void;
  /** Creates (or checks) an owner-only, non-symlinked file in the host directory and returns its path. */
  privateFile(name: string): string;
}
export type DeliveryFactory = ((
  dependencies: DeliveryDependencies,
) => Promise<{ service: HabMcpService; close(): Promise<void> }>) & {
  preflight?(directory: string): undefined;
};

function privatePath(path: string, directory: boolean) {
  const s = lstatSync(path);
  if (
    (directory ? !s.isDirectory() : !s.isFile()) ||
    s.isSymbolicLink() ||
    s.uid !== process.getuid?.() ||
    (s.mode & 0o077) !== 0 ||
    (!directory && s.nlink !== 1)
  )
    throw Error("host_private_path_required");
}
function prepareFile(path: string) {
  try {
    const fd = openSync(
      path,
      constants.O_CREAT |
        constants.O_EXCL |
        constants.O_RDWR |
        constants.O_NOFOLLOW,
      0o600,
    );
    closeSync(fd);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  privatePath(path, false);
}

/**
 * Owns only dedicated registry/delivery files and the inbound loopback listener.
 * No credentials, enrollment, outbound IO, model, background cycles or launchd.
 * A trusted operator composition must separately supply verified auth and policy.
 */
export async function startHostServer(options: HostServerOptions) {
  if (
    !options ||
    !isAbsolute(options.directory) ||
    realpathSync(options.directory) !== options.directory ||
    !Number.isSafeInteger(options.port) ||
    (options.port !== 0 && (options.port < 1024 || options.port > 65535)) ||
    typeof options.authority?.individual !== "function" ||
    typeof options.verify !== "function" ||
    typeof options.audit?.record !== "function" ||
    typeof options.delivery !== "function" ||
    (options.delivery.preflight !== undefined &&
      typeof options.delivery.preflight !== "function")
  )
    throw Error("invalid_host_options");
  const ingress = options.ingress;
  if (
    ingress &&
    (!Number.isSafeInteger(ingress.port) ||
      (ingress.port !== 0 && (ingress.port < 1024 || ingress.port > 65535)) ||
      (ingress.port !== 0 && ingress.port === options.port) ||
      typeof ingress.authority?.individual !== "function" ||
      typeof ingress.verify !== "function")
  )
    throw Error("invalid_host_ingress");
  privatePath(options.directory, true);
  validateLimits(options.limits);
  const preflight: unknown = options.delivery.preflight?.(options.directory);
  if (preflight !== undefined) {
    if (preflight && typeof preflight === "object" && "then" in preflight)
      void Promise.resolve(preflight).catch(() => {});
    throw Error("invalid_host_options");
  }
  const registryOptions = options.registry;
  let owner: SQLiteHostOwner | undefined,
    registry: SQLiteHabRegistry | undefined,
    handler: ReturnType<typeof routeMcpNodeHandlers> | undefined,
    ingressHandler: ReturnType<typeof routeMcpNodeHandlers> | undefined,
    ingressServer: Server | undefined,
    serviceClose: (() => Promise<void>) | undefined,
    events: HabEvents | undefined,
    // Config doorbell addresses that a registered doorbell replaced at start (plan 3).
    doorbellsReplaced: string[] = [],
    stopping = false;
  const pending = new Set<Promise<void>>();
  const makeServer = (current: () => typeof handler) =>
    createServer(
      {
        maxHeaderSize: 8192,
        requestTimeout: options.http.timeout_ms,
        headersTimeout: options.http.timeout_ms,
      },
      (req, res) => {
        const selected = current();
        if (stopping || !selected) {
          res.writeHead(503, {
            "Cache-Control": "no-store",
            Connection: "close",
          });
          res.end();
          return;
        }
        const work = selected(req, res);
        pending.add(work);
        void work.then(
          () => pending.delete(work),
          () => pending.delete(work),
        );
      },
    );
  const server = makeServer(() => handler);
  server.maxConnections = options.http.max_active_requests;
  let closing: Promise<void> | undefined;
  const close = () => {
    if (closing) return closing;
    stopping = true;
    closing = (async () => {
      try {
        const closing = [server, ingressServer]
          .filter((value): value is Server => !!value)
          .map(async (listener) => {
            if (!listener.listening) return;
            const closed = new Promise<void>((resolve, reject) => {
              listener.close((error) => (error ? reject(error) : resolve()));
            });
            listener.closeAllConnections();
            await closed;
          });
        const results = await Promise.allSettled(closing);
        await Promise.allSettled([...pending]);
        const failure = results.find((result) => result.status === "rejected");
        if (failure?.status === "rejected") throw failure.reason;
      } finally {
        try {
          try {
            await events?.close();
          } catch {
            // Closing delivery and the Registry still runs.
          }
          await serviceClose?.();
        } finally {
          try {
            registry?.close();
          } finally {
            owner?.close();
          }
        }
      }
    })();
    return closing;
  };
  try {
    const ownerPath = join(options.directory, "owner.sqlite");
    // Never open/close an extra fd on this SQLite ownership file.
    try {
      privatePath(ownerPath, false);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    owner = new SQLiteHostOwner(ownerPath, {
      agent_id: "hab-host",
      fingerprint_key: registryOptions.fingerprint_key,
    });
    owner.migrate();
    owner.acquire(() => {});
    const ownership = owner.attach();
    prepareFile(join(options.directory, "registry.sqlite"));
    registry = new SQLiteHabRegistry(
      join(options.directory, "registry.sqlite"),
      registryOptions,
      {
        hostIdentity: (context) => {
          ownership.check();
          if (stopping) return undefined;
          return options.authority.individual!(context)
            ? options.authority.hostIdentity?.(context)
            : ingress?.authority.hostIdentity?.(context);
        },
        individual: (context) => {
          ownership.check();
          if (stopping) return undefined;
          return (
            options.authority.individual!(context) ??
            ingress?.authority.individual?.(context)
          );
        },
      },
    );
    registry.migrate();
    const privateFile = (name: string) => {
      if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(name))
        throw Error("invalid_host_options");
      const path = join(options.directory, name);
      prepareFile(path);
      return path;
    };
    const assertOwner = () => {
      ownership.check();
      if (stopping) throw Error("host_stopping");
    };
    const delivery = await options.delivery({
      registry,
      limits: options.limits,
      directory: options.directory,
      assertOwner,
      privateFile,
    });
    serviceClose = delivery.close.bind(delivery);
    const service = delivery.service;
    // Agents use the agent catalog at /mcp; the SDK and the receive service use the
    // delivery catalog (submit, poll, ACK, resolve) at /mcp/delivery (ADR-020).
    const catalogs = [
      ["", "agent"],
      ["/delivery", "delivery"],
    ] as const;
    // Validate all HTTP limits before opening a socket; a temporary port is only framing.
    const policy = (port: number, suffix: string) => ({
      ...options.http,
      resource_url: `http://127.0.0.1:${port}/mcp${suffix}`,
      allowed_origins: [],
    });
    for (const [suffix, catalog] of catalogs)
      new HabHttpGateway(
        service,
        policy(options.port || 1024, suffix),
        options.audit,
        options.verify,
        undefined,
        catalog,
      );
    // The ingress serves both catalogs too. OAuth discovery metadata describes only the
    // agent endpoint; a token issued for it also opens the delivery endpoint.
    let ingressGateways: HabHttpGateway[] | undefined;
    if (ingress?.events) {
      const source = service as unknown as Partial<HabEventSource>;
      if (
        typeof source.eventRecipient !== "function" ||
        typeof source.arrivals !== "function" ||
        typeof source.addressOf !== "function"
      )
        throw Error("invalid_host_ingress");
      const eventSource = source as HabEventSource;
      // ADR-032 retired the ADR-031 inbox check; an old config's `inbox_check` is ignored.
      const {
        doorbells = [],
        inbox_check: _retired,
        ...eventOptions
      } = ingress.events;
      void _retired;
      const agentIdOf = (service as { agentIdOf?: (a: string) => unknown })
        .agentIdOf;
      const idOf = (address: string) => {
        const agentId =
          typeof agentIdOf === "function"
            ? agentIdOf.call(service, address)
            : undefined;
        return typeof agentId === "string" ? agentId : undefined;
      };
      // Config doorbells must name a live address, or the host does not start (ADR-029).
      const fromConfig = doorbells.map((doorbell) => {
        const agentId = idOf(doorbell.address);
        if (!agentId) throw Error("unknown_doorbell_address");
        return {
          address: doorbell.address,
          agent_id: agentId,
          url: doorbell.url,
          secret: doorbell.secret,
        };
      });
      // Plan 3: doorbells added with `hab:admin doorbell` live in the events store and
      // win over a config doorbell for the same agent. An unavailable secret pauses
      // delivery for that registration, without switching to its configured fallback.
      // Every config doorbell is checked at start, also one a registered doorbell
      // replaces, so a bad config never starts and `doorbell remove` never falls back to it.
      try {
        for (const doorbell of fromConfig) {
          operatorCallbackUrl(doorbell.url);
          doorbellSecret(doorbell.secret);
        }
      } catch {
        throw Error("invalid_doorbell");
      }
      // Resolved afresh every pass: a secret file that was missing for a while is
      // picked up as soon as it is back.
      const current = () => {
        const registered = events!.registeredDoorbells();
        const replaced = new Set(registered.map((row) => row.agent_id));
        return [
          ...fromConfig.filter((d) => !replaced.has(d.agent_id)),
          ...registered.flatMap(
            ({ agent_id, url: rawUrl, secret_file, added_at }) => {
              if (!eventSource.addressOf(agent_id)) return [];
              let url: string;
              try {
                url = operatorCallbackUrl(rawUrl).href;
              } catch {
                return [];
              }
              let secret: string | undefined;
              try {
                secret = doorbellSecret(readDoorbellSecretFile(secret_file));
              } catch {
                // The valid registration remains authoritative while its file is unavailable.
              }
              return [{ agent_id, url, secret, revision: added_at }];
            },
          ),
        ];
      };
      events = new HabEvents(eventSource, {
        ...eventOptions,
        store: privateFile("events.sqlite"),
        doorbells: current,
      });
      const registeredAtStart = new Set(
        events.registeredDoorbells().map((row) => row.agent_id),
      );
      doorbellsReplaced = [
        ...new Set(
          fromConfig
            .filter((d) => registeredAtStart.has(d.agent_id))
            .map((d) => d.address),
        ),
      ];
      try {
        events.configureStatic(current());
      } catch {
        throw Error("invalid_doorbell");
      }
    }
    if (ingress) {
      ingressGateways = catalogs.map(
        ([suffix, catalog]) =>
          new HabHttpGateway(
            service,
            {
              ...options.http,
              resource_url: ingress.resource_url + suffix,
              ...(catalog === "agent" ? { oauth_issuer: ingress.issuer } : {}),
              allowed_origins: ingress.allowed_origins,
            },
            options.audit,
            async (input) => {
              ownership.check();
              const context = await ingress.verify({
                ...input,
                resource: ingress.resource_url,
              });
              ownership.check();
              return stopping ? null : context;
            },
            undefined,
            catalog,
            events,
          ),
      );
    }
    server.listen(options.port, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (
      !address ||
      typeof address === "string" ||
      address.address !== "127.0.0.1"
    )
      throw Error("host_listener_rejected");
    handler = routeMcpNodeHandlers(
      catalogs.map(
        ([suffix, catalog]) =>
          new HabHttpGateway(
            service,
            policy(address.port, suffix),
            options.audit,
            async (input) => {
              ownership.check();
              // Both catalogs are views of one connection: a credential issued for /mcp
              // also opens /mcp/delivery.
              const context = await options.verify({
                ...input,
                resource: policy(address.port, "").resource_url,
              });
              ownership.check();
              return stopping ? null : context;
            },
            undefined,
            catalog,
            // No MCP events on loopback (ADR-022), but the same absence policy (ADR-032).
            undefined,
            events,
          ),
      ),
    );
    let ingressPort: number | undefined;
    if (ingress && ingressGateways) {
      ingressHandler = routeMcpNodeHandlers(ingressGateways);
      ingressServer = makeServer(() => ingressHandler);
      ingressServer.maxConnections = options.http.max_active_requests;
      ingressServer.listen(ingress.port, "127.0.0.1");
      await once(ingressServer, "listening");
      const remoteAddress = ingressServer.address();
      if (
        !remoteAddress ||
        typeof remoteAddress === "string" ||
        remoteAddress.address !== "127.0.0.1"
      )
        throw Error("host_ingress_rejected");
      ingressPort = remoteAddress.port;
    }
    events?.start();
    return Object.freeze({
      url: policy(address.port, "").resource_url,
      delivery_url: policy(address.port, "/delivery").resource_url,
      close,
      ...(doorbellsReplaced.length
        ? { doorbells_replaced: doorbellsReplaced }
        : {}),
      ...(ingressGateways
        ? {
            ingress_url: ingressGateways[0].policy.resource_url,
            ingress_delivery_url: ingressGateways[1].policy.resource_url,
            ingress_port: ingressPort,
          }
        : {}),
    });
  } catch (error) {
    await close();
    throw error;
  }
}
