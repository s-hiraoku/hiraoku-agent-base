/** Explicit local composition. Import performs no IO, authentication or scheduling. */
import type { Server } from "node:http";
import { createServer } from "node:http";
import { once } from "node:events";
import { createHmac } from "node:crypto";
import {
  lstatSync,
  realpathSync,
  openSync,
  closeSync,
  constants,
} from "node:fs";
import { isAbsolute, join } from "node:path";
import { SQLiteHostOwner } from "../agent-sdk/sqlite-host-owner.ts";
import { SQLiteHabRegistry } from "../hab/sqlite-registry.ts";
import type { RegistryOptions } from "../hab/sqlite-registry.ts";
import type {
  AgentRecord,
  RegistryAuthority,
  VerifiedIndividual,
} from "../hab/registry.ts";
import type { HabMcpService } from "../hab/mcp.ts";
import { HabHttpGateway } from "../hab/http.ts";
import { validateLimits } from "../messaging/contract.ts";
import type { ContractLimits } from "../messaging/contract.ts";
import type { RelayHttpPolicy, RelayHttpVerifier } from "./mcp/http.ts";
import { createRelayNodeHandler } from "./mcp/http-node.ts";
import type { AuditSink } from "../security.ts";
import {
  HOST_A2A_ISSUER,
  hostA2aIndividual,
  provisionHostA2aIdentity,
  provisioningOperations,
  startHostA2a,
} from "./a2a.ts";
import type { HostA2aConfig } from "./config.ts";

export interface HostServerOptions {
  /** Existing canonical, owner-only directory dedicated to this host. */
  directory: string;
  /** 0 selects an ephemeral loopback port for a supervised test. */
  port: number;
  limits: ContractLimits;
  registry: RegistryOptions;
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
  /** The delivery backend. The host wires it and never chooses between backends. */
  delivery: DeliveryFactory;
  /** Optional A2A entry with its own host-owned identity and loopback listener. */
  a2a?: HostA2aConfig;
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
  const a2aConfig = options.a2a;
  if (
    a2aConfig &&
    a2aConfig.port !== 0 &&
    (a2aConfig.port < 1024 ||
      a2aConfig.port === options.port ||
      a2aConfig.port === ingress?.port)
  )
    throw Error("invalid_local_relay_a2a");
  privatePath(options.directory, true);
  validateLimits(options.limits);
  const preflight: unknown = options.delivery.preflight?.(options.directory);
  if (preflight !== undefined) {
    if (preflight && typeof preflight === "object" && "then" in preflight)
      void Promise.resolve(preflight).catch(() => {});
    throw Error("invalid_local_relay_options");
  }
  const registryOptions = options.registry;
  let owner: SQLiteHostOwner | undefined,
    registry: SQLiteHabRegistry | undefined,
    handler: ReturnType<typeof createRelayNodeHandler> | undefined,
    ingressHandler: ReturnType<typeof createRelayNodeHandler> | undefined,
    ingressServer: Server | undefined,
    serviceClose: (() => Promise<void>) | undefined,
    a2a: Awaited<ReturnType<typeof startHostA2a>> | undefined,
    stopping = false;
  // Only host code holds these. The first is the host A2A identity's verified context;
  // the second answers as administrator only while startup provisions that identity.
  const hostContext = Object.freeze({});
  const provisioner = Object.freeze({});
  let provisioning = false;
  const a2aKey = createHmac("sha256", options.registry.fingerprint_key)
    .update("hab-host-a2a-v1")
    .digest();
  // The reserved host issuer can never come from operator credentials or OAuth.
  const operatorIndividual = (value: VerifiedIndividual | undefined) =>
    value?.principal.issuer === HOST_A2A_ISSUER ? undefined : value;
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
            await a2a?.close();
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
      agent_id: "local-relay-host",
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
        administrator: (context, operation) =>
          provisioning &&
          context === provisioner &&
          provisioningOperations.has(operation)
            ? { actor_id: "local-relay-host" }
            : undefined,
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
          if (a2aConfig && context === hostContext)
            return hostA2aIndividual(registryOptions.max_context_ms);
          return operatorIndividual(
            options.authority.individual!(context) ??
              ingress?.authority.individual?.(context),
          );
        },
      },
    );
    registry.migrate();
    let identity: AgentRecord | undefined;
    if (a2aConfig) {
      provisioning = true;
      try {
        identity = provisionHostA2aIdentity(
          registry,
          provisioner,
          a2aConfig.identity,
        );
      } finally {
        provisioning = false;
      }
    }
    const privateFile = (name: string) => {
      if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(name))
        throw Error("invalid_local_relay_options");
      const path = join(options.directory, name);
      prepareFile(path);
      return path;
    };
    const assertOwner = () => {
      ownership.check();
      if (stopping) throw Error("local_relay_stopping");
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
    // Validate all HTTP limits before opening a socket; a temporary port is only framing.
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
    if (a2aConfig && identity)
      a2a = await startHostA2a({
        config: a2aConfig,
        registry,
        service,
        identity,
        hostContext,
        limits: options.limits,
        fingerprintKey: a2aKey,
        timeoutMs: options.http.timeout_ms,
        privateFile,
        verify: options.verify,
        assertOwner,
        stopping: () => stopping,
      });
    return Object.freeze({
      url: gateway.policy.resource_url,
      close,
      ...(a2a ? { a2a_url: a2a.url } : {}),
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
