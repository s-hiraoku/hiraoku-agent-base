# Recipient-host MCP preparation (proposal, not enabled)

This change prepares an opt-in recipient-side MCP tool surface over the existing
`AdapterHostCycle`. It is not installed into the Relay, an agent profile or a
runtime. No network listener, credentials, model, approval UI, scheduler, native
session binding or persistent access is created.

## Why this route

`common-mcp-connection.md` explicitly chooses agents calling their existing MCP
clients, rather than HAB calling product execution APIs. `adapter-host.md` already
assigns receive/save/ACK, source-specific inbox reads and durable answers to the
recipient host. This wrapper uses those existing operations and their existing
commit guards. It does not duplicate storage, retry, policy or message schemas.

The normal Relay catalog remains five tools. The separate server is only useful
when an operator explicitly composes it inside an authenticated recipient host.
The caller selects the exposed operations, binds one verified recipient context
per server, and provides its existing transport/authentication. HostAuthorization
must continue checking current native policy, actor and source on every operation
and commit. Tool arguments cannot select that context, policy, identity, URL or
credentials. A shared multi-user server must not bind everybody to one context.

## Proposed remote contract

The existing MCP tools/list and tools/call protocol carries these opt-in tools:

- recipient_receive: one existing receive/save/ACK cycle, no model dispatch.
- recipient_inbox and recipient_inbox_read: metadata and source-specific body.
- recipient_answer_prepare: save the recipient-chosen body under the original source.
- recipient_answer_inspect and recipient_answer_pending: existing intent reconciliation.
- recipient_answer_enqueue: put the same persisted envelope in the existing outbox.
- recipient_send: one existing submission/status reconciliation step.

Each tool reuses the hostCommand argument schema with its operation fixed by the
server. A tool result contains the unchanged HostStepResult. inbox_read additionally
labels origin=external_agent. That label is provenance, not a permission mechanism.
The recipient product must treat tool-returned message contents as untrusted data
and apply its existing policy/approval to decisions and future tool calls.

No task, arbitrary message enqueue, raw-envelope answer, control, resume, owner
release, GC or registration tool is exposed. Exposing a tool is not authorization.
There is no timeout retry layer: uncertain operations retain the host's existing
state and must reconcile the same source/intent. The wrapper sanitizes thrown
exceptions and preserves incomplete results rather than claiming success.

## Explicit owner composition

The integration owner supplies the existing host, a verified recipient context
and an already authenticated transport. For example, from repository code:

```ts
import { createRecipientHostMcpServer } from "./src/adapter-host/mcp.ts";

const server = createRecipientHostMcpServer({
  host,
  context: verifiedRecipientContext,
  allowedOperations: [
    "receive", "inbox", "inbox_read", "answer_prepare",
    "answer_inspect", "answer_pending", "answer_enqueue", "send",
  ],
});
await server.connect(existingAuthenticatedTransport);
```

These variables are prerequisites, not configuration or native binding created by
this wrapper. The host must already own its private stores and enforce current
recipient policy. For stdio, the owner launches and controls the process and
binds its recipient session; this does not create a public HTTP listener. There
is no honest production launch command until the real binding, current policy,
store configuration and transport are verified. The test-only fixture below
must not be installed as a production entry point.

## Read response size and transport composition

`maxInboxReadResultBytes` is an owner-selected budget for the serialized MCP
CallToolResult of `inbox_read`, including UTF-8 encoding and the JSON escaping of
the nested message. The default is 1 MiB; the minimum is 1 KiB so the bounded
error fits. This is not a Relay message-size policy, an authentication setting,
or a tool argument. The existing host/store ContractLimits remain authoritative.

An oversized read returns `recipient_inbox_read_too_large` and
`required_result_bytes`, with no message body or partial success. The source is
not changed or consumed. Successful reads still return the complete unchanged
HostStepResult with the external-agent provenance label. Mutating operations are
not subject to this guard: a committed write's result is never replaced with a
read-size error, and the wrapper never retries a write.

The composition owner must align the read budget, permitted stored message sizes,
and the actual client transport limit before enabling this surface. The budget
excludes JSON-RPC framing, request IDs and any additional transport envelope.
In particular, arbitrary string request IDs require their own bounded framing
policy; this factory does not claim an absolute cap on all wire bytes. The
TypeScript SDK 1.32.0 stdio client defaults to a 10 MiB read buffer and exposes
`maxBufferSize`. Other clients may have different limits. Discovery results and
other operation results also require transport sizing; this guard is specific
to source-message reads, not a universal output-size limit.

If a read is refused, an authorized owner can recompose the server with a larger
read budget and configure a compatible client buffer, then read the same source
again under current recipient authorization. Neither the server nor external
message content can authorize that change. The original body is returned in full
when the resulting serialized response fits. If the intended product cannot
support the required buffer, leave that integration blocked: this change does
not introduce paging, silently truncate content, or claim that every client can
read every permitted message. A common paged host contract would need a separate
design decision rather than an MCP-only message schema.

`test/recipient-host-mcp-size.test.js` verifies exact byte-boundary behavior with
Unicode/escaping, rejection of tool-controlled budgets, renewed authorization,
unchanged mutating results, and an actual isolated stdio client. A refused large
read leaves the connection usable; a newly owner-configured client/server pair
retrieves the complete same source. This uses synthetic content and no product
configuration, authority expansion, broker or live agent.

## Relationship to RecipientMessagePort

This is a pull route and does not implement or replace RecipientMessagePort.
Its synchronous native commit checks cannot be serialized as an RPC callback.
A push route would require an explicit product-side durable external-input API,
read-only exact-key inspection, current native policy enforcement at admission,
and durable exact-envelope reply authorization at outbox commit. Adding a new
remote authority protocol or replacing these checks with pre-flight checks is
outside this change and needs design review. No such API is assumed to exist.

## Product evidence and remaining gates

Hermes source inspected at 6705c8c634d83a2f2918aa5ec45e7f8f20c20dc7:

- The [MCP configuration keys](https://github.com/NousResearch/hermes-agent/blob/6705c8c634d83a2f2918aa5ec45e7f8f20c20dc7/website/docs/user-guide/features/mcp.md#L490-L503)
  document stdio command, args, env, cwd and process recycling. The
  [transport implementation](https://github.com/NousResearch/hermes-agent/blob/6705c8c634d83a2f2918aa5ec45e7f8f20c20dc7/tools/mcp_tool_transport.py#L373-L414)
  builds StdioServerParameters and calls the SDK stdio_client. These source
  excerpts establish a supported transport candidate, not a live connection or
  verified native policy/session binding. No client or profile was launched.
- tui_gateway/methods_prompt.py rejects client-supplied _turn_author dictionaries.
  prompt.submit is a user-turn API, not a safe external-message substitute.
- gateway/session_bot.py bot_relay.deliver has durable identity checks, but may
  retry an existing admission. It is not read-only inspect.
- bot_relay.settle writes a terminal refusal when no receipt exists. It is also
  not read-only inspect and must not be used as one.

The standard MCP client is the integration candidate, not a claim of a completed
Hermes or Dots connection. Before enabling: verify the exact product release and
native MCP transport; choose the recipient/session and its current authority;
configure private stores and owner exclusivity; verify required native approval
and revocation behavior; obtain any necessary setup/credential/data-sharing
approval; then run a bounded authorized real-product acceptance test.

Pull cannot wake an idle/closed agent or guarantee residency. No auto-reply,
background polling, model use, live agent communication or real approval UI was
performed for this preparation. ACK remains storage receipt, not execution.

## Evidence

`test/recipient-host-mcp.test.js` and `test/recipient-host-mcp-size.test.js` use the
official MCP SDK client/server over in-memory transport and owned separate stdio
processes. The real-host cases use
existing SQLite inbox/outbox/answer journals and private NATS brokers. They cover
receive/ACK, saved source reads, revocation, fixed reply enqueue and separate
send. The real-host stdio test parent owns its broker and temporary directory;
the fixture child only borrows a private synthetic broker descriptor. Closing
the client waits for child stderr to finish before checking the child-store
cleanup marker `RECIPIENT_STDIO_CLEANUP_OK`. The parent then independently stops
its broker and removes its directory. A fault-injection case blocks child cleanup
and verifies that the parent still reclaims its directory and closes the owned
broker endpoint; it does not label the missing child marker as clean child
shutdown. These are cleanup tests, not crash-durability evidence.
Recipient identity, decisions and
operator resume are synthetic. The Relay-side fixture uses an in-process gateway;
this is not an HTTP deployment or real product test. Native wake, human approval,
session binding, full restoration and production access control remain unverified.

The [design verification bundle](../../verification/design/README.md) classifies
this document as proposal context and maps the focused tests to existing adopted
host, authority and answer-intent requirements. Source review and a clean audit do
not adopt this surface or satisfy the native-product manual gates. Current source
hashes and fresh check results are required; an older green run is not evidence
for the changed surface.

## Dedicated owner-side stdio wiring

[Recipient stdio composition](recipient-stdio.md) connects the existing
single-source host and acquired owner to stdio with an initially denied, paused
policy, explicit local management and bounded shutdown. It requires trusted
launch/session binding and applicable native approval; it does not install an
agent profile or turn these synthetic tests into real-product acceptance.
