-- @a2a-js/sdk schema for sqlite: base -> latest.
-- Rendered offline: nothing read the database, so this assumes it is at "base".
-- Each store's ledger is kept in step, so `a2a-db status` keeps matching the schema.
-- Not wrapped in a transaction. Check the ledger if it stops partway.

-- store: tasks

create table if not exists "a2a_hab_a2a_tasks_migrations" ("name" varchar(255) not null primary key, "timestamp" varchar(255) not null);

create table "hab_a2a_tasks" ("tenant" varchar(255) collate binary not null, "owner" varchar(255) collate binary not null, "id" varchar(36) collate binary not null, "context_id" varchar(36) collate binary not null, "status_last_updated" bigint not null, "status_state" varchar(255) collate binary, "status" text, "artifacts" text, "history" text, "metadata" text, "protocol_version" varchar(255), constraint "hab_a2a_tasks_pkey" primary key ("tenant", "owner", "id"));

create index "hab_a2a_tasks_scope_updated_idx" on "hab_a2a_tasks" ("tenant", "owner", "status_last_updated", "id");

create index "hab_a2a_tasks_scope_context_updated_idx" on "hab_a2a_tasks" ("tenant", "owner", "context_id", "status_last_updated", "id");

insert into "a2a_hab_a2a_tasks_migrations" ("name", "timestamp") values ('0001_create_tasks', '2026-11-01T00:14:25.553Z');
