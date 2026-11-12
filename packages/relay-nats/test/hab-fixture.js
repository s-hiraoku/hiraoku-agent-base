import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SQLiteHabRegistry } from "../../../src/hab/sqlite-registry.ts";
import { HabJetStreamService } from "../../../src/host/hab-delivery-service.ts";
import { fixture } from "./fixture.js";
import {
  options as registryOptions,
  principal,
  operations,
} from "../../../test/hab-registry-fixtures.js";

export async function habFixture(t, patch = {}, serverBinary) {
  const f = await fixture(
    t,
    {
      lease_ms: 2000,
      max_pending: 20,
      max_pending_per_recipient: 10,
      prefetch_per_recipient: Math.min(
        patch.max_pending ?? 20,
        patch.max_pending_per_recipient ?? 10,
      ),
      ...patch,
    },
    serverBinary,
  );
  const admin = Symbol("synthetic-registry-admin");
  const contexts = {
    a: Object.freeze({}),
    b: Object.freeze({}),
    c: Object.freeze({}),
  };
  const mutable = {
    unavailable: new Set(),
    expires_at: new Map(),
    storage: true,
  };
  const authority = {
    administrator: (context) =>
      context === admin ? { actor_id: "synthetic-registry-admin" } : undefined,
    individual(context) {
      const name = Object.keys(contexts).find(
        (name) => contexts[name] === context,
      );
      return name && !mutable.unavailable.has(name)
        ? {
            principal: principal(name),
            expires_at:
              mutable.expires_at.get(name) ??
              new Date(Date.now() + 30000).toISOString(),
          }
        : undefined;
    },
  };
  const path = join(f.dir, "registry.sqlite");
  let registry = new SQLiteHabRegistry(path, registryOptions, authority);
  registry.migrate();
  t.after(() => registry.close());
  let count = 0;
  const request = () => "synthetic-management-" + ++count;
  const product = registry.registerProduct(admin, {
    request_id: request(),
    agent_name: "synthetic",
  });
  const agents = {},
    groups = {};
  for (const [groupName, names] of [
    ["a", ["a", "a2"]],
    ["b", ["b"]],
    ["c", ["c"]],
  ]) {
    const group = registry.createGroup(admin, { request_id: request() });
    groups[groupName] = group;
    registry.bindGroup(admin, {
      request_id: request(),
      group_id: group.group_id,
      expected_epoch: group.epoch,
      principal: principal(groupName),
    });
    for (const name of names) {
      const agent = registry.enroll(admin, {
        request_id: request(),
        product_id: product.product_id,
        bot_name: name,
      });
      const current = registry.inspectGroup(admin, group.group_id);
      registry.addGroupMember(admin, {
        request_id: request(),
        group_id: group.group_id,
        expected_group_epoch: current.epoch,
        agent_id: agent.agent_id,
        expected_epoch: agent.epoch,
      });
      agents[name] = registry.setAccess(admin, {
        request_id: request(),
        agent_id: agent.agent_id,
        expected_epoch: registry.inspect(admin, agent.agent_id).epoch,
        state: "active",
        operations,
      });
    }
    registry.setGroupAccess(admin, {
      request_id: request(),
      group_id: group.group_id,
      expected_epoch: registry.inspectGroup(admin, group.group_id).epoch,
      state: "active",
      operations,
    });
  }
  const createService = (backend = f.backend) =>
    new HabJetStreamService(registry, backend, f.options, () => {
      if (!mutable.storage) throw Error("synthetic_volume_missing");
    });
  let service = createService();
  const selected = (name, contextName = name === "a2" ? "a" : name) =>
    service.selectAddress(
      contexts[contextName],
      agents[name].address,
      agents[name].agent_id,
    );
  return {
    ...f,
    admin,
    authority,
    contexts,
    mutable,
    groups,
    agents,
    get backend() {
      return f.backend;
    },
    get manager() {
      return f.manager;
    },
    get registry() {
      return registry;
    },
    registryPath: path,
    request,
    get service() {
      return service;
    },
    createService,
    /** Opens another backend on the same journal with the current `options`. */
    openBackend: () => f.open(),
    selected,
    message(to = "b", patch = {}) {
      return f.message(agents[to].agent_id, patch);
    },
    transport(name, fixed) {
      const current = () => fixed ?? service;
      return {
        submit: (message) =>
          Promise.resolve().then(() =>
            current().submit(selected(name), message),
          ),
        status: (id) =>
          Promise.resolve().then(() => current().status(selected(name), id)),
        poll: async () => {
          await f.backend.pumpOnce();
          return current().poll(selected(name));
        },
        ack: (request) =>
          Promise.resolve().then(() => current().ack(selected(name), request)),
      };
    },
    async restart() {
      await f.restart();
      registry.close();
      registry = new SQLiteHabRegistry(path, registryOptions, authority);
      registry.migrate();
      service = createService();
    },
    disconnect: () => f.stop(),
    async reconnect() {
      await f.close(f.backend);
      await f.start();
      await f.open();
      service = createService();
    },
    access(name, state, rights = []) {
      return registry.setAccess(admin, {
        request_id: request(),
        agent_id: agents[name].agent_id,
        expected_epoch: registry.inspect(admin, agents[name].agent_id).epoch,
        state,
        operations: rights,
      });
    },
    groupAccess(name, state, rights = []) {
      return registry.setGroupAccess(admin, {
        request_id: request(),
        group_id: groups[name].group_id,
        expected_epoch: registry.inspectGroup(admin, groups[name].group_id)
          .epoch,
        state,
        operations: rights,
      });
    },
    journal() {
      return new DatabaseSync(f.options.journal_path);
    },
  };
}
