# Explicit local Relay service

The common CLI now composes the [local host](local-relay-host.md) with a private
local bearer verifier and bounded redacted audit. It contains no product-name
branches, model caller, enrollment, credential issuer, refresh, outbound transport,
wake mechanism, Adapter cycle, scheduler, or launchd installer. Missing/invalid
configuration exits with a fixed error; no local secrets/config are discovered.

After explicit approval and operator preparation, run:

```sh
npm ci
npm ci --prefix packages/relay-nats --ignore-scripts
npm run relay:local -- --config /ABSOLUTE/PRIVATE/service.local.json
```

Delivery runs only through NATS JetStream: start a private loopback broker first
([package guide](../packages/relay-nats/README.md)). The config has one `delivery`
section with `broker`, `pump`, `volume` and `queue` parts. The retired SQLite
`store` section, and `delivery.routing`, are refused with `config_invalid` and the
field paths; messages held by the retired SQLite store are not migrated.
The delivery journal is schema 4, which earlier builds refuse, so rolling back to
one means restoring a pre-upgrade backup. Reconcile by original ID the messages this
release accepted and those still incomplete in the backup, including IDs retained only in inbox or execution evidence after journal collection. An `expired` or
`quarantined` row may still have been saved by its recipient, so the recipient's
records decide it. Keep the earlier build stopped until every restored ID has
expired, so the relay delivers nothing executed after the backup again. A body
already saved in a restored inbox is handed out regardless of expiry, so settle
each one against the copied execution records before restarting its recipient. Also reconcile unreleased bodies retained only in the upgraded inbox copy: draining and waiting do not transfer them. Use an application-specific local handoff under the original key only after ruling out prior or uncertain effects; otherwise keep the recipient stopped. Never replay, replace IDs or extend expiry
([procedure](../packages/relay-nats/OPERATIONS.md#roll-back)).

The [example](../config/relay-service.example.json) uses dummy paths and supervised
trial capacity numbers, not approved unattended production sizing. Supply all
limits explicitly. `delivery.queue.agent_capacity` is required: each verified sender gets
its own pending/record budget ([details](relay-agent-capacity.md)), and
`max_records_per_sender` / `max_pending_per_sender` must be smaller than the
queue-wide `max_records` / `max_pending`, so one sender cannot fill the retained
record pool that every other agent relies on. The existing canonical state directory must be 0700. Config,
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
address choice, the connection's group binding, operation rights and current stop epoch
are separate required operator steps; a valid bearer alone cannot read a mailbox.

To revoke: remove that mapping through an approved private atomic file update,
revoke its Registry binding, stop its finite client, and dispose runtime copies.
Stop the Relay for immediate service-wide shutdown. Do not delete integrity keys
or accepted database state to revoke one client. Mapping snapshots/secret copies
retained by external caller code are outside this component; JavaScript strings
cannot be reliably zeroized.

The CLI emits only `{state:"ready",url}` and `{state:"stopped"}`. A refused start
prints one line, `local_relay_start_rejected reason=<code>[ fields=<config paths>]`,
for example `reason=config_invalid fields=delivery.queue.agent_capacity`. The `registry`
section is parsed with the Registry's own options schema, so an out-of-range limit
names its field (`reason=config_invalid fields=registry.busy_timeout_ms` for a value
above 1000). Codes are fixed
(`config_required`, `config_file_rejected`, `config_invalid`, `keys_file_rejected`,
`keys_invalid`, `credentials_invalid`, `oauth_invalid`, `oauth_resource_mismatch`,
`port_in_use`, `state_in_use`, `local_relay_private_path_required`,
`registry_key_mismatch`, `fingerprint_key_mismatch`, `audit_unavailable`, …); the
line never contains values, file paths or secrets. SIGTERM/SIGINT
closes the owned listener and databases; reopening the same state retains receipts.
A supervisor must pin an independently tested release and use an explicit private
config path. The opt-in [user LaunchAgent runbook](local-relay-launchagent.md)
records installation, rejection checks, stop and restart. No existing service, keychain, MCP setting, profile or user job is
modified by the CLI. A future production maintenance schedule is still explicit;
without one, hard record bounds eventually refuse new acceptance.

## Operator management CLI

Registering addresses and binding connections is a separate operator step. The
management CLI uses the same private config and keys, opens only the registry the
Relay already created, and calls the Registry's administrator port. It works while
the Relay is running; it never creates the schema, upgrades v1→v2, issues tokens or
prints a bearer/digest.

```sh
npm run relay:admin -- --config /ABSOLUTE/PRIVATE/service.local.json status
npm run relay:admin -- --config /ABSOLUTE/PRIVATE/service.local.json connect \
  --address hermes@hermes.hab --connection-id <connection_id in the mapping>
npm run relay:admin -- --config /ABSOLUTE/PRIVATE/service.local.json disconnect \
  --address hermes@hermes.hab
```

- `connect` registers the product and address when missing, binds the mapped
  principal (selected by `connection_id`) from the local mapping or enabled OAuth
  ingress connections, and grants `--operations` (default: all
  five). It creates or reuses that connection's authentication group, so
  connecting a second address with the same connection id shares the
  authentication. Every step reads the current epoch and skips work
  already done, so a rerun after a partial failure converges.
  OAuth descriptors come from the operator-approved private ingress config; this
  command does not perform login, consent, token issuance or JWT verification.
  Disabled OAuth connections are unavailable for binding. Conflicting principals
  with the same connection ID across inputs refuse with `credential_ambiguous`.
- `disconnect` revokes every live binding that authenticates the address using the
  current epochs. It does not need the token mapping, so cleanup order does not
  matter, and a rerun reports `already_disconnected`. For a group it revokes the
  group binding, stops every member address and lists them. A later `connect` with a
  new connection id re-grants only the address it names; reconnect each other member
  explicitly. A refused group `connect` (for example `registry_capacity_exceeded`)
  creates no group, so a retry converges. `--operations ""` is refused as
  `invalid_operations`. Until the host has started once on a registry from an
  earlier build, every command refuses with `registry_upgrade_pending`.
- `status` lists addresses, groups and each mapped credential's remaining lifetime,
  audience and binding, plus `problems` such as `credential_expired`,
  `credential_audience_mismatch`, `credential_unbound`, `credential_revoked` and
  `address_unbound`. These explain most 401/`forbidden` results.

A revoked connection descriptor stays reserved permanently. To reconnect after a
trial, issue a new token with a new `connection_id` and run `connect` again
(`credential_revoked_use_new_connection_id` otherwise). Failures print
`relay_admin_rejected <code>` with exit 1 (usage errors exit 2).

Clients must use the exact resource URL `http://127.0.0.1:<port>/mcp`. The Relay
rejects any other `Host` (including `localhost`) with 403, and the bearer's
audience must equal this URL.

## Dots and Hermes are separate connection gates

A successful CLI start/401 check is local Relay infrastructure evidence, not an
agent-to-agent roundtrip. The finite mock tests do not call any model. The primary
connection is each agent's own standard MCP client calling the five Relay tools;
HAB does not require or invoke an external agent execution API. Receive timing and
responses belong to the receiving agent. See the [common MCP connection procedure](common-mcp-connection.md).

The older Runs/inventory execution trial is a separate optional path. Its fixed
wrapper, independent Inspector, effective-tool/personal-context isolation and cost
checks do not become prerequisites for a model-free native MCP transport check.
A transport check still does not prove a model chose tools or that two real agents
exchanged a message. Any model-assisted trial must separately confirm its permitted
tools, personal-context handling and account/cost conditions. Inventory code that
reads files is not a substitute for either connection proof.

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
group binding, permitted five operations, finite receive trigger, durable
save-before-ACK owner and reply outbox. A real Dots ↔ HAB ↔ real Hermes result must
be reported separately from a local probe's preparation test. These requirements
use the common connection contract and Adapter boundary, not product-specific
delivery code.

## Optional OAuth ingress

An explicit `ingress` may add a second IPv4 loopback listener behind approved TLS,
sharing the same Registry, queue and owner. It exposes the same five tools with
OAuth consent metadata. The [OAuth ingress procedure](relay-oauth-ingress.md)
describes pinned public keys, finite individual connections, private configuration,
exact metadata routing and the limited save-before-ACK gate. This code does not
publish a route, register a client, issue a token or start an agent.

## Optional A2A entry

A2A is off by default. Merging the `a2a` section from
[the A2A example](../config/relay-a2a.example.json) into the service config adds a
third `127.0.0.1` listener at `http://127.0.0.1:<a2a.port>/a2a`. At start the host
creates or rebinds its own Registry address (`a2a.identity`) and a private
outbox, inbox and Task store in the state directory. A2A Tasks are sent from that
address to `a2a.recipient`. A2A callers need a credential whose audience is the
A2A endpoint. Bind it to the caller's address with `relay:admin connect` as usual.
The ready line printed by `relay:local` then includes `a2a_url`.
[Host wiring](a2a-relay-preview.md#host-wiring-with-a-host-owned-identity)
describes identity provisioning, authorization, retry, Task states and the startup
refusal reasons.


## 認証グループ

接続の認証はすべて認証グループで行います。hostの起動時にRegistryをv1からv2へ
移行し、以前のbuildが作った1対1 bindingは、そのアドレスだけが所属するグループへ
同じbinding IDのまま移します。既存ID・アドレス・実効権限は維持します。
Registryの`authentication_groups`は旧設定との互換のために受け付けますが、値は使いません。
このreleaseを既存サービスへ適用する前に、停止・backup／復旧手順を確認してください。
v2を旧runtimeで開くためにversionを書き換えることは禁止します。`delivery.queue.agent_capacity`等の現在の必須設定も
releaseと照合し、不足時に制限を省いて起動しません。

新規空DBでも、グループや資格情報は自動登録せず全拒否のままです。
実際の短命tokenの発行・保管と、refresh／継続アクセスの許可は別操作です。
[共通の名義選択と実装範囲](relay-auth-groups.md)を参照してください。
