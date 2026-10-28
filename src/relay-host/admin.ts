/**
 * Operator management for the configured local Relay. It reuses the service config
 * and keys, opens only the existing registry, and never issues or prints credentials.
 * Every mutation goes through the Registry's own administrator port.
 */
import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { readLocalRelayConfig, LocalRelayStartError } from "./configured.ts";
import { localCredentialsSchema } from "./local-auth.ts";
import {
  parseRelayOAuthConfig,
  relayOAuthConnectionWindow,
} from "./oauth-auth.ts";
import { SQLiteHabRegistry } from "../hab/sqlite-registry.ts";
import type { RegistryOverview } from "../hab/sqlite-registry.ts";
import {
  RegistryError,
  parseHabAddress,
  relayOperations,
} from "../hab/registry.ts";
import type { AgentOperation, IndividualPrincipal } from "../hab/registry.ts";

export class RelayAdminError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.name = "RelayAdminError";
    this.code = code;
  }
}
export interface ConnectInput {
  address: string;
  connection_id: string;
  operations?: readonly string[];
}
type Agent = RegistryOverview["agents"][number];
type ManagedCredential = {
  principal: IndividualPrincipal;
  issued_at: string;
  expires_at: string;
  participation?: {
    state: "active" | "revoked";
    max_access_token_lifetime_seconds: number;
  };
};

const operator = Object.freeze({});
const request = () => `relay-admin-${randomUUID()}`;
const same = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && [...a].sort().join() === [...b].sort().join();

function open(configPath: string) {
  let loaded;
  try {
    loaded = readLocalRelayConfig(configPath);
  } catch (error) {
    throw new RelayAdminError(
      error instanceof LocalRelayStartError ? error.reason : "config_invalid",
    );
  }
  const { config } = loaded;
  const path = join(config.directory, "registry.sqlite");
  // Schema creation and the v1→v2 group upgrade belong to the Relay start, never here.
  if (!existsSync(path)) throw new RelayAdminError("relay_not_initialized");
  let version: unknown;
  try {
    const raw = new DatabaseSync(path, { readOnly: true });
    try {
      version = raw
        .prepare("SELECT version FROM hab_registry_meta WHERE id=1")
        .get()?.version;
    } finally {
      raw.close();
    }
  } catch {
    throw new RelayAdminError("relay_not_initialized");
  }
  if (version === 1 && config.registry.authentication_groups === true)
    throw new RelayAdminError("registry_upgrade_pending");
  const registry = new SQLiteHabRegistry(
    path,
    { ...config.registry, fingerprint_key: loaded.registry_fingerprint_key },
    {
      administrator: (context) =>
        context === operator ? { actor_id: "local-operator" } : undefined,
    },
  );
  try {
    registry.migrate();
  } catch (error) {
    registry.close();
    throw error;
  }
  const resources = [
    ...(config.port ? [`http://127.0.0.1:${config.port}/mcp`] : []),
    ...(config.ingress ? [config.ingress.resource_url] : []),
  ];
  const credentials = () => {
    let parsed;
    try {
      parsed = localCredentialsSchema.safeParse(loaded.readCredentials());
    } catch {
      throw new RelayAdminError("credentials_file_rejected");
    }
    if (!parsed.success) throw new RelayAdminError("credentials_invalid");
    const records: ManagedCredential[] = [...parsed.data.credentials];
    if (config.ingress) {
      let remote;
      try {
        remote = parseRelayOAuthConfig(loaded.readOAuth());
      } catch {
        throw new RelayAdminError("oauth_invalid");
      }
      if (remote.resource !== config.ingress.resource_url)
        throw new RelayAdminError("oauth_resource_mismatch");
      if (remote.enabled) {
        for (const connection of remote.connections) {
          const window = relayOAuthConnectionWindow(connection);
          records.push({
            principal: {
              issuer: remote.issuer,
              audience: remote.resource,
              subject: connection.subject,
              client_id: connection.client_id,
              connection_id: connection.connection_id,
            },
            issued_at: window.starts_at,
            expires_at: window.ends_at,
            ...(remote.version === 2
              ? {
                  participation: {
                    state: window.state,
                    max_access_token_lifetime_seconds:
                      remote.max_access_token_lifetime_seconds,
                  },
                }
              : {}),
          });
        }
      }
    }
    return records;
  };
  return { registry, resources, credentials, groups: version === 2 };
}

function withRegistry<T>(
  configPath: string,
  action: (opened: ReturnType<typeof open>) => T,
): T {
  const opened = open(configPath);
  try {
    return action(opened);
  } finally {
    opened.registry.close();
  }
}

function summary(agent: Agent) {
  return {
    address: agent.address,
    agent_id: agent.agent_id,
    state: agent.state,
    operations: agent.operations,
    active_bindings: agent.active_binding_ids.length,
    group_id: agent.group_id,
  };
}

/** Read-only view plus the checks that most often explain a 401/forbidden. */
export function relayAdminStatus(configPath: string, now = Date.now()) {
  return withRegistry(configPath, ({ registry, resources, credentials }) => {
    const view = registry.overview(operator);
    const byId = new Map(view.agents.map((agent) => [agent.agent_id, agent]));
    const problems: { code: string; subject: string }[] = [];
    const mapped = credentials().map((record) => {
      const reservation = registry.findPrincipal(operator, record.principal);
      const addresses =
        reservation?.kind === "agent"
          ? [byId.get(reservation.owner_id)?.address ?? ""]
          : reservation?.kind === "group"
            ? view.agents
                .filter((agent) => agent.group_id === reservation.owner_id)
                .map((agent) => agent.address)
            : [];
      const expiresIn = Math.floor(
        (Date.parse(record.expires_at) - now) / 1000,
      );
      const subject = record.principal.connection_id;
      if (expiresIn <= 0)
        problems.push({
          code: record.participation
            ? "participation_expired"
            : "credential_expired",
          subject,
        });
      if (record.participation) {
        if (record.participation.state === "revoked")
          problems.push({ code: "participation_revoked", subject });
        if (Date.parse(record.issued_at) > now)
          problems.push({ code: "participation_not_yet_active", subject });
      }
      if (resources.length && !resources.includes(record.principal.audience))
        problems.push({ code: "credential_audience_mismatch", subject });
      if (!reservation) problems.push({ code: "credential_unbound", subject });
      else if (reservation.state !== "active")
        problems.push({ code: "credential_revoked", subject });
      return {
        connection_id: subject,
        ...(record.participation
          ? {
              participation: {
                state: record.participation.state,
                approved_at: record.issued_at,
                approved_until: record.expires_at,
                expires_in_seconds: expiresIn,
              },
              max_access_token_lifetime_seconds:
                record.participation.max_access_token_lifetime_seconds,
            }
          : { expires_in_seconds: expiresIn }),
        audience: record.principal.audience,
        binding: reservation
          ? { kind: reservation.kind, state: reservation.state }
          : null,
        addresses,
      };
    });
    for (const agent of view.agents) {
      const group = view.groups.find((g) => g.group_id === agent.group_id);
      if (agent.state !== "active")
        problems.push({
          code: `address_${agent.state}`,
          subject: agent.address,
        });
      else if (
        !agent.active_binding_ids.length &&
        !group?.active_binding_ids.length
      )
        problems.push({ code: "address_unbound", subject: agent.address });
      else if (group && group.state !== "active")
        problems.push({ code: `group_${group.state}`, subject: agent.address });
    }
    if (view.stopped)
      problems.push({ code: "emergency_stopped", subject: "*" });
    return {
      resource_urls: resources,
      authentication_groups: view.authentication_groups,
      addresses: view.agents.map(summary),
      groups: view.groups.map((group) => ({
        group_id: group.group_id,
        state: group.state,
        operations: group.operations,
        active_bindings: group.active_binding_ids.length,
        members: group.member_ids.map((id) => byId.get(id)?.address ?? id),
      })),
      credentials: mapped,
      problems,
    };
  });
}

function principalFor(
  records: ManagedCredential[],
  connectionId: string,
  resources: string[],
): IndividualPrincipal {
  const matches = new Map(
    records
      .filter((record) => record.principal.connection_id === connectionId)
      .map((record) => [JSON.stringify(record.principal), record.principal]),
  );
  if (matches.size === 0) throw new RelayAdminError("credential_not_found");
  if (matches.size > 1) throw new RelayAdminError("credential_ambiguous");
  const [principal] = matches.values();
  // Only the v2 participation policy changes enrollment behavior; v1 stays compatible.
  const now = Date.now();
  for (const record of records.filter(
    (r) => r.principal.connection_id === connectionId && r.participation,
  )) {
    if (record.participation!.state !== "active")
      throw new RelayAdminError("participation_revoked");
    if (Date.parse(record.issued_at) > now)
      throw new RelayAdminError("participation_not_yet_active");
    if (Date.parse(record.expires_at) <= now)
      throw new RelayAdminError("participation_expired");
  }
  if (resources.length && !resources.includes(principal.audience))
    throw new RelayAdminError("credential_audience_mismatch");
  return principal;
}

/**
 * Registers (if needed) the product and address, binds the mapped connection and
 * grants operations. Each step reads the current epoch first and skips work that is
 * already in place, so rerunning after a partial failure converges.
 */
export function relayAdminConnect(configPath: string, input: ConnectInput) {
  const address = parseHabAddress(input.address);
  const operations = [
    ...new Set(input.operations ?? relayOperations),
  ] as AgentOperation[];
  if (
    !operations.length ||
    operations.some(
      (op) => !(relayOperations as readonly string[]).includes(op),
    )
  )
    throw new RelayAdminError("invalid_operations");
  return withRegistry(
    configPath,
    ({ registry, resources, credentials, groups }) => {
      const principal = principalFor(
        credentials(),
        input.connection_id,
        resources,
      );
      const steps: string[] = [];
      const find = () =>
        registry
          .overview(operator)
          .agents.find((agent) => agent.address === address.address);
      let view = registry.overview(operator);
      let product = view.products.find(
        (p) => p.agent_name === address.agent_name,
      );
      if (!product) {
        product = registry.registerProduct(operator, {
          request_id: request(),
          agent_name: address.agent_name,
        });
        steps.push("product_registered");
      }
      if (!find()) {
        registry.enroll(operator, {
          request_id: request(),
          product_id: product.product_id,
          bot_name: address.bot_name,
        });
        steps.push("address_enrolled");
      }
      let agent = find()!;
      if (agent.state === "retired")
        throw new RelayAdminError("address_retired");
      const reservation = registry.findPrincipal(operator, principal);
      if (reservation && reservation.state !== "active")
        // Revoked connection descriptors stay reserved forever by design.
        throw new RelayAdminError("credential_revoked_use_new_connection_id");
      const legacy =
        !groups ||
        agent.active_binding_ids.length > 0 ||
        reservation?.kind === "agent";
      if (legacy) {
        if (reservation && reservation.owner_id !== agent.agent_id)
          throw new RelayAdminError("credential_bound_elsewhere");
        if (agent.group_id) throw new RelayAdminError("address_in_group");
        if (!reservation) {
          registry.bind(operator, {
            request_id: request(),
            agent_id: agent.agent_id,
            expected_epoch: registry.inspect(operator, agent.agent_id).epoch,
            principal,
          });
          steps.push("connection_bound");
        }
      } else {
        let groupId = reservation?.owner_id ?? agent.group_id;
        if (agent.group_id && groupId !== agent.group_id)
          throw new RelayAdminError("address_in_other_group");
        if (!groupId) {
          groupId = registry.createGroup(operator, {
            request_id: request(),
          }).group_id;
          steps.push("group_created");
        }
        if (!reservation) {
          registry.bindGroup(operator, {
            request_id: request(),
            group_id: groupId,
            expected_epoch: registry.inspectGroup(operator, groupId).epoch,
            principal,
          });
          steps.push("connection_bound");
        }
        if (!agent.group_id) {
          registry.addGroupMember(operator, {
            request_id: request(),
            group_id: groupId,
            expected_group_epoch: registry.inspectGroup(operator, groupId)
              .epoch,
            agent_id: agent.agent_id,
            expected_epoch: registry.inspect(operator, agent.agent_id).epoch,
          });
          steps.push("group_member_added");
        }
        const group = registry.inspectGroup(operator, groupId);
        if (
          group.state !== "active" ||
          operations.some((op) => !group.operations.includes(op))
        ) {
          // Group grants intersect with address grants; keep the union of both.
          const granted = [
            ...new Set([
              ...(group.state === "active" ? group.operations : []),
              ...operations,
            ]),
          ];
          registry.setGroupAccess(operator, {
            request_id: request(),
            group_id: groupId,
            expected_epoch: group.epoch,
            state: "active",
            operations: granted,
          });
          steps.push("group_access_granted");
        }
      }
      const current = registry.inspect(operator, agent.agent_id);
      if (current.state !== "active" || !same(current.operations, operations)) {
        registry.setAccess(operator, {
          request_id: request(),
          agent_id: agent.agent_id,
          expected_epoch: current.epoch,
          state: "active",
          operations,
        });
        steps.push("address_access_granted");
      }
      agent = find()!;
      view = registry.overview(operator);
      return {
        steps,
        address: summary(agent),
        ...(agent.group_id
          ? {
              group_members: view.agents
                .filter((a) => a.group_id === agent.group_id)
                .map((a) => a.address),
            }
          : {}),
      };
    },
  );
}

/**
 * Revokes every live binding that authenticates this address, using current epochs.
 * Safe to rerun and independent of whether the token mapping was already deleted.
 * For a shared group this disconnects every member address, which is reported.
 */
export function relayAdminDisconnect(configPath: string, addressInput: string) {
  const address = parseHabAddress(addressInput).address;
  return withRegistry(configPath, ({ registry }) => {
    const agent = registry
      .overview(operator)
      .agents.find((value) => value.address === address);
    if (!agent) throw new RelayAdminError("address_not_found");
    let revoked = 0;
    for (const bindingId of agent.active_binding_ids) {
      registry.revoke(operator, {
        request_id: request(),
        binding_id: bindingId,
        expected_epoch: registry.inspect(operator, agent.agent_id).epoch,
      });
      revoked++;
    }
    let affected = [address];
    if (agent.group_id) {
      const view = registry.overview(operator);
      const group = view.groups.find((g) => g.group_id === agent.group_id)!;
      for (const bindingId of group.active_binding_ids) {
        registry.revokeGroupBinding(operator, {
          request_id: request(),
          binding_id: bindingId,
          expected_epoch: registry.inspectGroup(operator, group.group_id).epoch,
        });
        revoked++;
      }
      affected = view.agents
        .filter((a) => a.group_id === agent.group_id)
        .map((a) => a.address);
    }
    const after = registry
      .overview(operator)
      .agents.find((value) => value.address === address)!;
    return {
      revoked_bindings: revoked,
      already_disconnected: revoked === 0,
      affected_addresses: affected,
      address: summary(after),
    };
  });
}

export function relayAdminErrorCode(error: unknown): string {
  if (error instanceof RelayAdminError || error instanceof RegistryError)
    return error.code;
  return "relay_admin_failed";
}
