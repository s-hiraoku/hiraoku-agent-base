# A2A SDK preview

This is the P1 SDK foundation for the [replacement plan](hab-product-spec.md). It is disabled by default. Importing these modules starts no listener and changes no Relay, Registry, MCP catalog, account, or production configuration.

Run the proof with Node 24 and `npm ci`, then `npm run test:a2a`. The tests own temporary private databases, loopback ports, synthetic bearer tokens, and cleanup. They use the official A2A client and a real SQLite TaskService. The fixed worker result is a connectivity fixture, not evidence of a production agent completing work.

## Supported contract

The preview accepts A2A 1.0 JSON-RPC. The endpoint is explicitly limited to `http://127.0.0.1:<port>/a2a`. The authenticated AgentCard is at `/.well-known/agent-card.json`. Every RPC requires `A2A-Version: 1.0` and `Content-Type: application/json`.

Supported methods are `SendMessage`, `GetTask`, and `ListTasks`. `CancelTask` returns the SDK's task-not-cancelable error and never reports that execution stopped. Streaming, push notifications, caller-defined tenants, task continuations, attachments, arbitrary prompts, and execution deadlines are unsupported. Unknown fields fail before TaskService submission.

The only input is a new user message containing the text `connectivity_check`. With `configuration.returnImmediately=true`, the client receives a Task and polls `GetTask`. The default blocking request waits for confirmed terminal or interrupted state. A five-second transport wait limit returns an error while preserving the same queryable Task. It neither expires nor fails the execution. The Node callback has a separate ten-second connection limit.

Use the SDK's codecs when building client requests. For example, `SendMessageRequest.fromJSON` and `ListTasksRequest.fromJSON` populate required protobuf defaults.

## Composition boundary

`openA2aTaskStore(path)` returns an official `DatabaseTaskStore` and an async `close` function. Use a dedicated private database in a directory owned by the host. The function refuses a non-private file and an unrelated database. The table is `hab_a2a_tasks`, so it cannot collide with TaskService's `tasks`. The checked-in schema comes from the pinned SDK's command below.

```sh
node node_modules/@a2a-js/sdk/dist/cli/a2a_db.js upgrade \
  --sql --dialect sqlite --store tasks --tasks-table-name hab_a2a_tasks
```

`createA2aGateway({endpoint,card,store,authorize})` returns a Fetch handler. The host's `authorize(request)` must verify authentication and execution policy, then return `{subject,tasks}`. `subject` is a stable authenticated caller ID. `tasks` implements the existing `BridgeTasks` contract. The fixture composes the existing `ConnectivityTaskPort`, which verifies a separate Task principal. A message body never grants Task permissions. `createA2aNodeHandler(endpoint,gateway)` adapts the Fetch handler to an explicitly created Node HTTP server.

The gateway scopes SDK storage by authenticated owner. TaskStore itself also supports tenant isolation, which the store tests check independently. The preview does not accept an untrusted tenant field or derive an execution principal from a Relay name. A production HAB integration must resolve immutable IDs and current group policy before returning an authorization.

## Identity, recovery, and execution state

One caller and `messageId` map deterministically to one A2A Task ID and one engine request key. The context ID is derived separately. The SDK Task metadata persists the engine binding, request key, and confirmed engine Task ID. There is no additional Task store or third execution engine.

Before submission, the SDK saves an intent containing the binding and request key. A lost engine response leaves submission uncertain. A repeated send or `GetTask` can resume that recorded intent with the same key. TaskService's existing idempotency constraint prevents duplicate work. Changing the engine binding fails rather than silently submitting to another engine.

A queued engine Task maps to A2A `SUBMITTED`. Running maps to `WORKING`. Confirmed success with `execution_open=0` and the validated fixed result maps to `COMPLETED` with one result Artifact. A failure produces no success Artifact. Engine cancellation with execution still open maps to `INPUT_REQUIRED`, because it does not prove the worker stopped. Neither Relay acceptance nor recipient storage ACK participates in this preview or counts as execution completion.

`GetTask` and `ListTasks` recheck the TaskPort before returning execution evidence. The proof checks owner isolation, rejected credentials, and revoked execution access. The SDK store tests also read the same Task and Artifact from a separate Node process after closing the original store.

## Remaining integration work

This preview supports one adapter instance per database. It has no multi-host writer coordination, storage retention job, or production capacity policy. List pages use the SDK's current persisted ordering; updates observed during pagination can change that ordering.

P2 must connect the HAB Registry and group policy, preserve Message-to-Relay rm1 correlation and original expiry, and reject a conflicting replay. P3 must prove the route through Relay, durable inbox storage ACK, explicit TaskBridge acceptance, and the result path. Those are separate gates. This preview's direct TaskPort proof does not complete either gate, the JetStream migration, or the product GUI.

## Fixed dependencies

| Package                 | Version  | Purpose                                                                    |
| ----------------------- | -------- | -------------------------------------------------------------------------- |
| `@a2a-js/sdk`           | `1.3.0`  | Official A2A 1.0 wire protocol, client, handler, and persistent Task store |
| `kysely`                | `0.29.7` | SDK database connection                                                    |
| `better-sqlite3`        | `13.0.3` | SDK-supported SQLite driver                                                |
| `@types/better-sqlite3` | `9.6.0`  | Driver TypeScript declarations                                             |

The existing Task engine continues to use `node:sqlite`. The SDK driver is isolated to the new database. Its native addon must be installed for the Node major version used to run the preview.

The SDK's [official repository](https://github.com/a2aproject/a2a-js) documents A2A 1.0, the JSON-RPC transport, and its persistent stores. The pinned package types and CLI output are the implementation references for this preview.
