/** Explicit local composition. Import performs no IO, authentication or scheduling. */
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
import { SQLiteHostOwner } from "../adapter-host/sqlite-owner.ts";
import { SQLiteHabRegistry } from "../hab/sqlite-registry.ts";
import type { RegistryOptions } from "../hab/sqlite-registry.ts";
import type { RegistryAuthority } from "../hab/registry.ts";
import { HabRelayService } from "../hab/relay.ts";
import { HabHttpGateway } from "../hab/http.ts";
import { SQLiteRelayStore } from "../relay/sqlite-store.ts";
import type { StoreOptions } from "../relay/sqlite-store.ts";
import { validateLimits } from "../relay/contract.ts";
import type { ContractLimits } from "../relay/contract.ts";
import type { RelayHttpPolicy, RelayHttpVerifier } from "../relay/http.ts";
import { createRelayNodeHandler } from "../relay/http-node.ts";
import type { AuditSink } from "../security.ts";

export interface LocalRelayOptions {
  /** Existing canonical, owner-only directory dedicated to this host. */
  directory: string;
  /** 0 selects an ephemeral loopback port for a supervised test. */
  port: number;
  limits: ContractLimits;
  registry: RegistryOptions;
  store: StoreOptions;
  http: Omit<
    RelayHttpPolicy,
    "resource_url" | "allowed_origins" | "oauth_issuer"
  >;
  /** Separate loopback ingress behind approved TLS; same owner, Registry and queue. */
  ingress?: {
    port: number;
    resource_url: string;
    issuer: string;
    allowed_origins: readonly string[];
    authority: RegistryAuthority;
    verify: RelayHttpVerifier;
  };
  /** Independently verified individual mapping; no model-supplied agent name. */
  authority: RegistryAuthority;
  verify: RelayHttpVerifier;
  audit: AuditSink;
}

function privatePath(path: string, directory: boolean) {
  const s = lstatSync(path);
  if (
    (directory ? !s.isDirectory() : !s.isFile()) ||
    s.isSymbolicLink() ||
    s.uid !== process.getuid?.() ||
    (s.mode & 0o077) !== 0 ||
    (!directory && s.nlink !== 1)
  )
    throw Error("local_relay_private_path_required");
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
 * Owns only dedicated registry/Relay files and the inbound loopback listener.
 * No credentials, enrollment, outbound IO, model, background cycles or launchd.
 * A trusted operator composition must separately supply verified auth and policy.
 */
export async function startLocalRelay(options: LocalRelayOptions) {
  if (
    !options ||
    !isAbsolute(options.directory) ||
    realpathSync(options.directory) !== options.directory ||
    !Number.isSafeInteger(options.port) ||
    (options.port !== 0 && (options.port < 1024 || options.port > 65535)) ||
    typeof options.authority?.individual !== "function" ||
    typeof options.verify !== "function" ||
    typeof options.audit?.record !== "function"
  )
    throw Error("invalid_local_relay_options");
  const ingress = options.ingress;
  if (
    ingress &&
    (!Number.isSafeInteger(ingress.port) ||
      (ingress.port !== 0 && (ingress.port < 1024 || ingress.port > 65535)) ||
      (ingress.port !== 0 && ingress.port === options.port) ||
      typeof ingress.authority?.individual !== "function" ||
      typeof ingress.verify !== "function")
  )
    throw Error("invalid_local_relay_ingress");
  privatePath(options.directory, true);
  validateLimits(options.limits);
  const registryOptions = options.registry,
    storeOptions = options.store;
  let owner: SQLiteHostOwner | undefined,
    registry: SQLiteHabRegistry | undefined,
    store: SQLiteRelayStore | undefined,
    handler: ReturnType<typeof createRelayNodeHandler> | undefined,
    ingressHandler: ReturnType<typeof createRelayNodeHandler> | undefined,
    ingressServer: Server | undefined,
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
          store?.close();
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
      agent_id: "local-relay-host",
      fingerprint_key: registryOptions.fingerprint_key,
    });
    owner.migrate();
    owner.acquire(() => {});
    const ownership = owner.attach();
    for (const file of ["registry.sqlite", "relay.sqlite"])
      prepareFile(join(options.directory, file));
    registry = new SQLiteHabRegistry(
      join(options.directory, "registry.sqlite"),
      registryOptions,
      {
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
    store = new SQLiteRelayStore(
      join(options.directory, "relay.sqlite"),
      storeOptions,
    );
    store.migrate();
    // Validate all HTTP limits before opening a socket; a temporary port is only framing.
    const service = new HabRelayService(registry, store, options.limits);
    const policy = (port: number) => ({
      ...options.http,
      resource_url: `http://127.0.0.1:${port}/mcp`,
      allowed_origins: [],
    });
    new HabHttpGateway(
      service,
      policy(options.port || 1024),
      options.audit,
      options.verify,
    );
    let ingressGateway: HabHttpGateway | undefined;
    if (ingress) {
      ingressGateway = new HabHttpGateway(
        service,
        {
          ...options.http,
          resource_url: ingress.resource_url,
          oauth_issuer: ingress.issuer,
          allowed_origins: ingress.allowed_origins,
        },
        options.audit,
        async (input) => {
          ownership.check();
          const context = await ingress.verify(input);
          ownership.check();
          return stopping ? null : context;
        },
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
      throw Error("local_relay_listener_rejected");
    const gateway = new HabHttpGateway(
      service,
      policy(address.port),
      options.audit,
      async (input) => {
        ownership.check();
        const context = await options.verify(input);
        ownership.check();
        return stopping ? null : context;
      },
    );
    handler = createRelayNodeHandler(gateway);
    let ingressPort: number | undefined;
    if (ingress && ingressGateway) {
      ingressHandler = createRelayNodeHandler(ingressGateway);
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
        throw Error("local_relay_ingress_rejected");
      ingressPort = remoteAddress.port;
    }
    return Object.freeze({
      url: gateway.policy.resource_url,
      close,
      ...(ingressGateway
        ? {
            ingress_url: ingressGateway.policy.resource_url,
            ingress_port: ingressPort,
          }
        : {}),
    });
  } catch (error) {
    await close();
    throw error;
  }
}
