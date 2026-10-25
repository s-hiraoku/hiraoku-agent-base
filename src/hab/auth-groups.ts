/** Optional HAB registry extension. No credentials, product dispatch or automatic migration. */
import type { AgentOperation, AgentState } from "./registry.ts";
export interface AuthenticationGroup {
  group_id: string;
  state: AgentState;
  epoch: number;
  operations: AgentOperation[];
  created_at: string;
}
export interface GroupBinding {
  binding_id: string;
  group_id: string;
  state: "active" | "revoked";
  created_at: string;
  revoked_at: string | null;
  group_epoch: number;
}
export const AUTH_GROUP_SCHEMA = `
CREATE TABLE hab_auth_group_meta(id INTEGER PRIMARY KEY CHECK(id=1),version INTEGER NOT NULL);
INSERT INTO hab_auth_group_meta VALUES(1,1);
CREATE TABLE hab_auth_groups(group_id TEXT PRIMARY KEY,state TEXT NOT NULL CHECK(state IN ('waiting_connection','active','stopped','retired')),epoch INTEGER NOT NULL CHECK(epoch>0),operations TEXT NOT NULL CHECK(json_valid(operations)),created_at TEXT NOT NULL);
CREATE TABLE hab_auth_group_bindings(binding_id TEXT PRIMARY KEY,group_id TEXT NOT NULL REFERENCES hab_auth_groups(group_id),fingerprint TEXT NOT NULL UNIQUE,state TEXT NOT NULL CHECK(state IN ('active','revoked')),created_at TEXT NOT NULL,revoked_at TEXT);
CREATE INDEX hab_auth_group_binding_group ON hab_auth_group_bindings(group_id,state);
CREATE TABLE hab_auth_group_members(agent_id TEXT PRIMARY KEY REFERENCES hab_agents(agent_id),group_id TEXT NOT NULL REFERENCES hab_auth_groups(group_id),created_at TEXT NOT NULL);
CREATE INDEX hab_auth_group_member_group ON hab_auth_group_members(group_id,agent_id);
CREATE TABLE hab_auth_group_authorizations(id INTEGER PRIMARY KEY,at TEXT NOT NULL,group_id TEXT NOT NULL REFERENCES hab_auth_groups(group_id),agent_id TEXT NOT NULL REFERENCES hab_agents(agent_id),operation TEXT NOT NULL);
CREATE TRIGGER hab_auth_group_identity BEFORE UPDATE OF group_id,created_at ON hab_auth_groups BEGIN SELECT RAISE(ABORT,'immutable'); END;
CREATE TRIGGER hab_auth_group_retired BEFORE UPDATE ON hab_auth_groups WHEN OLD.state='retired' BEGIN SELECT RAISE(ABORT,'retired'); END;
CREATE TRIGGER hab_auth_group_reserved BEFORE DELETE ON hab_auth_groups BEGIN SELECT RAISE(ABORT,'reserved'); END;
CREATE TRIGGER hab_auth_group_binding_identity BEFORE UPDATE OF binding_id,group_id,fingerprint,created_at ON hab_auth_group_bindings BEGIN SELECT RAISE(ABORT,'immutable'); END;
CREATE TRIGGER hab_auth_group_binding_revoked BEFORE UPDATE ON hab_auth_group_bindings WHEN OLD.state='revoked' BEGIN SELECT RAISE(ABORT,'revoked'); END;
CREATE TRIGGER hab_auth_group_binding_reserved BEFORE DELETE ON hab_auth_group_bindings BEGIN SELECT RAISE(ABORT,'reserved'); END;
CREATE TRIGGER hab_auth_group_member_identity BEFORE UPDATE ON hab_auth_group_members BEGIN SELECT RAISE(ABORT,'immutable'); END;
CREATE TRIGGER hab_auth_group_member_reserved BEFORE DELETE ON hab_auth_group_members BEGIN SELECT RAISE(ABORT,'reserved'); END;
`;
