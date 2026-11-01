/** Additive schema: birth identities stay immutable; names are permanent ID-owned reservations. */
export const AGENT_NAME_SCHEMA = `
CREATE TABLE hab_agent_name_meta(id INTEGER PRIMARY KEY CHECK(id=1),version INTEGER NOT NULL);
INSERT INTO hab_agent_name_meta VALUES(1,1);
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
`;
