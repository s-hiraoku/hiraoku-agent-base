import { fixture, operations, principal } from "./hab-registry-fixtures.js";

export function groupFixture(t, patch = {}) {
  const f = fixture(t, { authentication_groups: true, ...patch });
  let sequence = 0;
  const request = () => `group-request-${++sequence}`;
  const group = f.registry.createGroup(f.admin, { request_id: request() });
  f.registry.bindGroup(f.admin, {
    request_id: request(),
    group_id: group.group_id,
    expected_epoch: group.epoch,
    principal: principal("a"),
  });
  const enroll = (name) => {
    const agent = f.enroll(name, false);
    const current = f.registry.inspectGroup(f.admin, group.group_id);
    f.registry.addGroupMember(f.admin, {
      request_id: request(),
      group_id: group.group_id,
      expected_group_epoch: current.epoch,
      agent_id: agent.agent_id,
      expected_epoch: agent.epoch,
    });
    const member = f.registry.inspect(f.admin, agent.agent_id);
    return f.registry.setAccess(f.admin, {
      request_id: request(),
      agent_id: agent.agent_id,
      expected_epoch: member.epoch,
      state: "active",
      operations,
    });
  };
  const first = enroll("research"),
    second = enroll("calendar"),
    external = f.enroll("b");
  const access = (state, rights = []) => {
    const current = f.registry.inspectGroup(f.admin, group.group_id);
    return f.registry.setGroupAccess(f.admin, {
      request_id: request(),
      group_id: group.group_id,
      expected_epoch: current.epoch,
      state,
      operations: rights,
    });
  };
  access("active", operations);
  const select = (agent) =>
    f.registry.selectAddress(f.contexts.a, agent.address);
  return {
    ...f,
    group,
    first,
    second,
    external,
    enrollMember: enroll,
    access,
    select,
    request,
  };
}
