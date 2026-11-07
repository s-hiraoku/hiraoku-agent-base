# HAB asynchronous text profile v1

This opt-in profile connects A2A and MCP clients to the same authorized generic text jobs. Ordinary agent messaging uses [common Relay MCP](../common-mcp-connection.md) and the [receive-only supervisor](../receive-supervisor.md) without this profile, a Task, or a Hermes-specific runner. Receiving agents retain content decisions, execution, and their existing approval policy. The existing fixed-task endpoints retain their contracts. The factories do not start a listener, a worker, or a production authentication policy.

The required A2A extension URI is `https://github.com/s-hiraoku/hiraoku-agent-base/blob/main/docs/profiles/async-text-v1.md`. The profile uses [A2A 1.0](https://a2a-protocol.org/v1.0.0/specification/) JSON-RPC with `A2A-Version: 1.0` and `A2A-Extensions` equal to that URI. The authenticated Agent Card advertises the extension as required. Streaming, subscriptions, push notifications, task continuation and extended cards are unsupported.

## Submit and correlate

`SendMessage` accepts exactly one user text part and an explicit nonblocking configuration. The JSON-RPC envelope has `jsonrpc`, `id`, `method` and `params`. Its `params` shape is below. Replace the URI placeholder with the full extension URI above.

```json
{
  "message": {
    "messageId": "sender-stable-message-id",
    "contextId": "sender-context-id",
    "role": "ROLE_USER",
    "parts": [
      { "text": "Please summarize this text", "mediaType": "text/plain" }
    ]
  },
  "configuration": { "returnImmediately": true },
  "metadata": {
    "<extension URI>": { "version": 1, "workDeadline": 1800000000000 }
  }
}
```

`workDeadline` is an integer Unix timestamp in milliseconds and must satisfy the Task service's acceptance limits. Identifiers contain 1–200 characters. Text and confirmed result text are nonempty valid Unicode, exclude NUL and isolated surrogates, and contain at most 32,768 UTF-8 bytes. Inputs are never silently normalized, replaced or truncated. Requests are bounded to 256 KiB and responses to 512 KiB. Body reads have a ten-second deadline.

`configuration.acceptedOutputModes` may be `["text/plain"]` and `historyLength` may be zero. Other configuration, metadata, part types, authority fields, tenant fields and continuation fields are rejected before persistence. Omitting `returnImmediately` or setting it to false is rejected. Acceptance returns a Task without a result, even when an idempotent replay names an already completed job. Use `GetTask` to read its confirmed artifact.

The host resolves the verified subject, client and complete conversation binding on every operation. They are not accepted from the message. The same verified caller and binding can use the same Task ID across both protocols. Different client registrations are distinct even if they belong to the same human. Stable message IDs deduplicate within the accepted scope. Changed body, context, recipient, binding or deadline conflicts with the earlier request.

## Read, list and cancel

`GetTask` accepts `{ "id": "<Task UUID>" }`, optionally with `historyLength: 0`. Confirmed completion returns one text artifact with stable ID `<Task UUID>:result:1`. No input history, runtime ID, runner authority, journal, database error or private binding is returned.

`ListTasks` accepts optional `contextId`, `pageSize` from 1 to 20, and an opaque `pageToken`. `includeArtifacts` may only be false; true returns an unsupported-operation error. Summaries omit results. Results are ordered by status timestamp and ID descending. `totalSize` is the exact count within the current authorized scope and filter. A cursor is bound to that scope, filter and page size. Authorization is checked again on every page. This is live pagination without a snapshot guarantee, so updates between pages can move jobs.

`CancelTask` accepts `{ "id": "<Task UUID>" }`. A queued job can become canceled immediately. Working means the Task coordinator has claimed the job. It can precede external runtime admission and does not prove a model is running. An active cancellation remains working with unknown outcome until trusted runtime evidence confirms termination. Lease loss also remains working with execution reconciliation pending. Neither state represents owner approval, and neither grants permission to execute or retry.

Task metadata under the extension URI includes `sourceMessageId`, `acceptedAt`, `workDeadline`, `outcome`, `cancellationRequested`, `cancellationConfirmed`, and an optional `waitReason`. These are a projection of the existing Task service. There is no separate SDK Task store or ID mapping.

## MCP and host composition

The opt-in MCP factory exposes `text_submit`, `text_get`, `text_list` and `text_cancel`. Submit arguments are `{ messageId, contextId, text, workDeadline }`; get and cancel accept `{ id }`; list accepts the same paging and context fields as the shared application API. The tools return sanitized JSON text. The catalog reflects the current caller's permitted operations. A submit-only caller can initialize and submit, but receives no result on replay. There are no worker, approval, reconciliation or new OAuth-scope tools.

`createGenericTextHost` in `src/generic-host.ts` composes both factories on an explicit `http://127.0.0.1:<port>` origin. It serves `/a2a`, `/mcp`, and `/.well-known/agent-card.json`, and rejects browser Origin headers and unexpected Host headers. The caller supplies one `GenericTextJobs<Request>` backed by its Task service and verified resolver. The host does not own or close the injected Task service. `close()` rejects new requests and drains MCP exchanges. A Node exchange has a twelve-second connection deadline.

The former opt-in generic NATS dispatch port was deleted; its [historical record](../implementation/generic-nats-dispatch.md) describes the removed code. This profile supplies no production Auth0 resolver, invitation policy, protected-tool approval, real Hermes model execution or automatic reply delivery. Those require their own integration and acceptance evidence. HTTP SDK and SQLite tests here use synthetic verified principals and a synthetic runtime without LLM or external tools.

## Reproduce

Use the repository's pinned Node/npm versions and lockfile.

```sh
npm ci
npm run typecheck
NODE_NO_WARNINGS=1 node --test test/generic-a2a.test.js test/generic-mcp.test.js test/generic-entrances.test.js
NODE_NO_WARNINGS=1 npm run proof:generic-entrances
```

The finite proof starts a loopback listener, submits through both official SDKs, executes two synthetic jobs, reopens the host and SQLite, then reads results through the opposite protocol. It removes its temporary database and closes its clients and listener. It does not use a real agent, credential or production endpoint.
