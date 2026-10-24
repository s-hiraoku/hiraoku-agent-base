# Explicit local Relay service

The common CLI now composes the [local host](local-relay-host.md) with a private
local bearer verifier and bounded redacted audit. It contains no product-name
branches, model caller, enrollment, credential issuer, refresh, outbound transport,
wake mechanism, Adapter cycle, scheduler, or launchd installer. Missing/invalid
configuration exits with a fixed error; no local secrets/config are discovered.

After explicit approval and operator preparation, run:

```sh
npm ci
npm run relay:local -- --config /ABSOLUTE/PRIVATE/service.local.json
```

The [example](../config/relay-service.example.json) uses dummy paths and supervised
trial capacity numbers, not approved unattended production sizing. Supply all
limits explicitly. The existing canonical state directory must be 0700. Config,
keys and individual mappings must be canonical owner-only 0600 files ending in
`.local.json`, outside Git. Hardlinked config/keys/mappings are rejected. A missing
credential file refuses startup. An explicitly empty credential array starts
**deny-all**, never no-auth. Audit is private, bounded and redacted; it records
category/time/correlation only, never the bearer, principal, arguments or body.

The key file has version 1 and `registry_fingerprint_key` /
`relay_fingerprint_key`, each exactly 64 lowercase hex characters encoding a
separately approved random 32-byte key. This code only reads approved keys; it
never creates, rotates or copies credentials. Existing keys must remain with their
retained database state.

## Individual verifier

The mapping format is `{ "version": 1, "credentials": [] }`. For each separately
approved local individual, add an object with:

- `sha256`: lowercase SHA-256 hex of the exact opaque bearer string. The bearer
  itself must be 64 hex characters, held only by its approved client runtime.
- `principal`: exact `issuer`, `audience`, `subject`, `client_id` and
  `connection_id` attested by the operator's local issuance/binding ceremony.
  Audience must equal this loopback MCP resource URL.
- `issued_at` / `expires_at`: canonical UTC millisecond timestamps; lifetime must
  be positive and at most **15 minutes**. No renewal or time extension is inferred.

No real token is included in this document. Configuration validation rejects
unknown fields, duplicate digests/principals and malformed/excessive lifetimes.
Each HTTP verification reloads the private mapping. Each Registry operation
reloads it again and rechecks the unchanged credential/principal, original expiry
and current clock. Removal, damage, expiry or identity reassignment rejects even
an already verified context. In-process backwards clock movement fails closed;
wall-clock integrity across a process restart remains an operator prerequisite.
The verifier exposes no management authority. Registry enrollment, immutable
address choice, exact individual binding, operation rights and current stop epoch
are separate required operator steps; a valid bearer alone cannot read a mailbox.

To revoke: remove that mapping through an approved private atomic file update,
revoke its Registry binding, stop its finite client, and dispose runtime copies.
Stop the Relay for immediate service-wide shutdown. Do not delete integrity keys
or accepted database state to revoke one client. Mapping snapshots/secret copies
retained by external caller code are outside this component; JavaScript strings
cannot be reliably zeroized.

The CLI emits only `{state:"ready",url}` and `{state:"stopped"}`. SIGTERM/SIGINT
closes the owned listener and databases; reopening the same state retains receipts.
A supervisor must pin an independently tested release and use an explicit private
config path. No existing service, keychain, MCP setting, profile or user job is
modified by the CLI. A future production maintenance schedule is still explicit;
without one, hard record bounds eventually refuse new acceptance.

## Dots and Hermes are separate connection gates

A successful CLI start/401 check is local Relay infrastructure evidence, not an
agent-to-agent roundtrip. The finite mock tests do not call any model. A probe ↔
real Hermes trial requires the separately approved fixed wrapper, fresh independent
Inspector, effective-tools/personal-context isolation and $0 additional-cost
verification. Inventory code that reads files is not a substitute.

For real Dots, first identify its actual MCP execution environment. The currently
observed HAB MVP Requester tools are the older six Task operations, not the five
Relay tools. Do not reuse that connection's credentials for this new purpose.
A local MCP-capable execution environment can potentially reach the Mac loopback
endpoint under its own verified individual. Cloud ChatGPT/Work does not gain
loopback access merely because the Mac is connected; hosted tools need a separately
verified and approved remote route. The official [MCP documentation](https://learn.chatgpt.com/docs/extend/mcp#use-mcp-backed-tools-in-chatgpt-web)
states that hosted chats use installed plugins/remote MCP tools and local transports
may be unavailable in cloud execution.

No tunnel, public bind, OAuth grant, remote plugin registration, reused permanent
credential or new persistent client access is part of this increment. Before any
real Dots test, confirm the selected agent/context, local vs hosted route, exact
individual binding, permitted five operations, finite receive trigger, durable
save-before-ACK owner and reply outbox. A real Dots ↔ HAB ↔ real Hermes result must
be reported separately from a local probe's preparation test. These requirements
use the common connection contract and Adapter boundary, not product-specific
delivery code.
