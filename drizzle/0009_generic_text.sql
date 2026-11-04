CREATE TABLE `__new_tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`owner` text NOT NULL,
	`destination` text NOT NULL,
	`request_key` text NOT NULL,
	`task_type` text DEFAULT 'connectivity_check' NOT NULL,
	`state` text NOT NULL,
	`execution_open` integer DEFAULT 0 NOT NULL,
	`fence` integer DEFAULT 0 NOT NULL,
	`lease` integer,
	`run_id` text,
	`runner_scope` text,
	`runner_subject` text,
	`result` text,
	`actor` text NOT NULL,
	`at` integer NOT NULL,
	`mutation` text NOT NULL,
	CONSTRAINT "valid_state" CHECK("__new_tasks"."state" IN ('queued','running','waiting_approval','succeeded','failed','cancelled')),
	CONSTRAINT "fixed_task_type" CHECK("__new_tasks"."task_type" IN ('connectivity_check','shift_log_inventory','generic_text')),
	CONSTRAINT "valid_gate" CHECK("__new_tasks"."execution_open" IN (0,1))
);
--> statement-breakpoint
INSERT INTO `__new_tasks`("id", "owner", "destination", "request_key", "task_type", "state", "execution_open", "fence", "lease", "run_id", "runner_scope", "runner_subject", "result", "actor", "at", "mutation") SELECT "id", "owner", "destination", "request_key", "task_type", "state", "execution_open", "fence", "lease", "run_id", "runner_scope", "runner_subject", "result", "actor", "at", "mutation" FROM `tasks`;--> statement-breakpoint
DROP TABLE `tasks`;--> statement-breakpoint
ALTER TABLE `__new_tasks` RENAME TO `tasks`;--> statement-breakpoint
CREATE UNIQUE INDEX `request_idempotency` ON `tasks` (`owner`,`request_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `single_execution` ON `tasks` (`destination`) WHERE "tasks"."execution_open"=1;--> statement-breakpoint
CREATE INDEX `queue_order` ON `tasks` (`destination`,`state`,`at`);
--> statement-breakpoint
CREATE TRIGGER tasks_insert_audit AFTER INSERT ON tasks BEGIN
 INSERT INTO audit(task,actor,state,fence,at) VALUES(NEW.id,NEW.actor,NEW.state,NEW.fence,NEW.at);
END;
--> statement-breakpoint
CREATE TRIGGER tasks_update_audit AFTER UPDATE ON tasks
WHEN OLD.mutation<>NEW.mutation BEGIN
 INSERT INTO audit(task,actor,state,fence,at) VALUES(NEW.id,NEW.actor,NEW.state,NEW.fence,NEW.at);
END;
--> statement-breakpoint
CREATE TRIGGER tasks_terminal_outbox AFTER UPDATE ON tasks
WHEN OLD.state<>NEW.state AND NEW.state IN ('succeeded','failed','cancelled') BEGIN
 INSERT OR IGNORE INTO outbox(id,task,owner,event,at) VALUES(NEW.id || ':' || NEW.state,NEW.id,NEW.owner,NEW.state,NEW.at);
END;

--> statement-breakpoint
CREATE TABLE task_text_requests (
 task_id TEXT PRIMARY KEY NOT NULL REFERENCES tasks(id),
 owner_client TEXT NOT NULL,
 worker_client TEXT,
 owner_scope TEXT NOT NULL,
 sender_agent TEXT NOT NULL,
 recipient_agent TEXT NOT NULL,
 recipient_owner TEXT NOT NULL,
 conversation_binding TEXT NOT NULL,
 accepted_at INTEGER NOT NULL,
 work_deadline INTEGER NOT NULL,
 fingerprint TEXT NOT NULL,
 payload TEXT NOT NULL,
 CHECK(length(CAST(payload AS BLOB)) <= 262144),
 CHECK(work_deadline >= 0)
);
--> statement-breakpoint
CREATE TRIGGER immutable_text_request BEFORE UPDATE ON task_text_requests
WHEN OLD.worker_client IS NOT NULL OR NEW.worker_client IS NULL OR OLD.task_id<>NEW.task_id OR OLD.owner_client<>NEW.owner_client OR OLD.owner_scope<>NEW.owner_scope OR OLD.sender_agent<>NEW.sender_agent OR OLD.recipient_agent<>NEW.recipient_agent OR OLD.recipient_owner<>NEW.recipient_owner OR OLD.conversation_binding<>NEW.conversation_binding OR OLD.accepted_at<>NEW.accepted_at OR OLD.work_deadline<>NEW.work_deadline OR OLD.fingerprint<>NEW.fingerprint OR OLD.payload<>NEW.payload BEGIN
 SELECT RAISE(ABORT,'immutable_text_request');
END;
