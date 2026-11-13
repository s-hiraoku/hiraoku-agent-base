/** Version 2 adds previous-name use counts for the rename grace period. */
export const NAME_SCHEMA_VERSION = 2;
/** Days a previous name keeps resolving to the same ID when the option is omitted. */
export const DEFAULT_RENAME_GRACE_DAYS = 30;
/**
 * Who still uses a previous name, as IDs and counts only. One row per (name, caller);
 * the caller is the resolving sender or, for its own frozen name, the agent itself.
 */
export const PREVIOUS_NAME_USE_SCHEMA = `
CREATE TABLE hab_previous_name_uses(address TEXT NOT NULL,agent_id TEXT NOT NULL,caller_id TEXT NOT NULL REFERENCES hab_agents(agent_id),uses INTEGER NOT NULL CHECK(uses>0),first_at TEXT NOT NULL,last_at TEXT NOT NULL,PRIMARY KEY(address,caller_id),FOREIGN KEY(address,agent_id) REFERENCES hab_address_reservations(address,agent_id));
`;
/** A renamed agent's earlier name. `resolves` is false once the grace period ended. */
export interface PreviousName {
  address: string;
  agent_id: string;
  current_address: string;
  renamed_at: string;
  grace_until: string;
  resolves: boolean;
}
/** Additive schema: birth identities stay immutable; names are permanent ID-owned reservations. */
export const AGENT_NAME_SCHEMA = `
CREATE TABLE hab_agent_name_meta(id INTEGER PRIMARY KEY CHECK(id=1),version INTEGER NOT NULL);
INSERT INTO hab_agent_name_meta VALUES(1,${NAME_SCHEMA_VERSION});
CREATE TABLE hab_address_reservations(address TEXT PRIMARY KEY,agent_id TEXT NOT NULL REFERENCES hab_agents(agent_id),bot_name TEXT NOT NULL,created_at TEXT NOT NULL,UNIQUE(address,agent_id));
INSERT INTO hab_address_reservations SELECT address,agent_id,bot_name,created_at FROM hab_agents;
CREATE TABLE hab_agent_name_events(sequence INTEGER PRIMARY KEY,agent_id TEXT NOT NULL REFERENCES hab_agents(agent_id),address TEXT NOT NULL,previous_address TEXT NOT NULL,at TEXT NOT NULL,FOREIGN KEY(address,agent_id) REFERENCES hab_address_reservations(address,agent_id));
CREATE INDEX hab_agent_names_latest ON hab_agent_name_events(agent_id,sequence DESC);
CREATE VIEW hab_agents_current AS SELECT a.agent_id,a.product_id,a.agent_name,COALESCE(n.bot_name,a.bot_name) AS bot_name,COALESCE(n.address,a.address) AS address,a.normalization_version,a.state,a.epoch,a.operations,a.created_at FROM hab_agents a LEFT JOIN hab_agent_name_events e ON e.sequence=(SELECT MAX(sequence) FROM hab_agent_name_events WHERE agent_id=a.agent_id) LEFT JOIN hab_address_reservations n ON n.address=e.address AND n.agent_id=a.agent_id;
CREATE TRIGGER hab_names_immutable BEFORE UPDATE ON hab_address_reservations BEGIN SELECT RAISE(ABORT,'immutable'); END;
CREATE TRIGGER hab_names_reserved BEFORE DELETE ON hab_address_reservations BEGIN SELECT RAISE(ABORT,'reserved'); END;
CREATE TRIGGER hab_names_canonical BEFORE INSERT ON hab_address_reservations WHEN NEW.address != NEW.bot_name || '@' || (SELECT agent_name FROM hab_agents WHERE agent_id=NEW.agent_id) || '.hab' BEGIN SELECT RAISE(ABORT,'invalid_name'); END;
CREATE TRIGGER hab_agents_name_reserved BEFORE INSERT ON hab_agents WHEN EXISTS(SELECT 1 FROM hab_address_reservations WHERE address=NEW.address) BEGIN SELECT RAISE(ABORT,'reserved'); END;
CREATE TRIGGER hab_name_event_immutable BEFORE UPDATE ON hab_agent_name_events BEGIN SELECT RAISE(ABORT,'immutable'); END;
CREATE TRIGGER hab_name_event_reserved BEFORE DELETE ON hab_agent_name_events BEGIN SELECT RAISE(ABORT,'reserved'); END;
CREATE TRIGGER hab_name_event_chain BEFORE INSERT ON hab_agent_name_events WHEN NEW.previous_address != (SELECT address FROM hab_agents_current WHERE agent_id=NEW.agent_id) OR NEW.address=NEW.previous_address OR (SELECT state FROM hab_agents WHERE agent_id=NEW.agent_id)='retired' BEGIN SELECT RAISE(ABORT,'invalid_rename'); END;
${PREVIOUS_NAME_USE_SCHEMA}`;
