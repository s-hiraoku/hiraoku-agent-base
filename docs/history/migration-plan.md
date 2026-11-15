# Hosting and MCP Events status

Current live candidate: Mac + SQLite, with existing Tailscale reuse under review. Worker/D1/Sites remain portability work, not the selected pilot deployment. See [HAB ADR](../hab-decisions.md).

## Runtime choice and implemented migration

The Sites portable setup guide specifies Cloudflare Workers-compatible server output and a 128 MB isolate budget. The storage guide requires D1 prepared statements, one statement per prepare, transactional batches, schema in `db/schema.ts` and generated migrations. Local-only work skips Site registration and publishing.

The prior synchronous Node implementation has been replaced by a shared async SQL task service. `SQLiteDriver` and `D1Driver` implement atomic operation batches against one selected database. D1 reads are primary-constrained, claim uses conditional UPDATE, and a unique execution index covers active, quarantined and cancelled unresolved work. Audit/outbox triggers are generated as a schema-only custom migration. Migrations are not created by hosted request handlers.

The production Worker entry point uses the SDK's Web Standard HTTP transport and D1 binding. The Node entry point uses its Node HTTP transport and local SQLite. `npm run build` bundles only Worker runtime code; local journal, SQLite and Node callback egress are not part of that bundle. No `.openai/hosting.json` with a real Site identity exists. Site registration, private authentication boundary mapping, provisioning and upload are pending approval.

Local Miniflare/workerd validation includes the shared operation suite, 12 concurrent D1 claim attempts, atomic rollback, completion/cancel races, stale fences, authenticated fixture MCP/Adapter roundtrip, default 401 on forged identity headers, and persistent D1 reopen. Four independent Node worker threads separately contend for a single SQLite claim. Strict TypeScript checks cover production source/schema. These tests establish local behavior; hosted D1 consistency/auth and actual Sites service interoperability are not yet established.

Generated migrations and matching snapshots/journal are tracked in `drizzle/`. Do not rewrite applied migrations. Existing older prototype data requires reviewed migration; the new SQLite driver fails closed on an untracked legacy schema. No runtime data is part of the public repository.

Sources: [D1 transactional batch API](https://developers.cloudflare.com/d1/worker-api/d1-database/), [official MCP SDK catalog](https://modelcontextprotocol.io/docs/2026-07-28/sdk). Miniflare is pinned to the current registry prerelease used for local tests; its fixture configuration uses the exported v4-options conversion helper and disables telemetry/outbound access.

## Worker recovery implemented and still gated

The adapter now renews leases while waiting for Runs create/get, polls known runs, applies a finite heartbeat deadline, keeps durable receipts on renewal failure or local stop, and refuses unknown-admission replay beyond the verified idempotency horizon. Simulated multiple lease windows, hung/failed renewals, known active run reopen and lost-admission reopen are tested. No remote stop call is inferred from local abort.

The typed standard Runs HTTP client is implemented in `src/hermes-runs.ts` and tested only against mock APIs. Its activation still requires an approved isolated profile and effective tool/memory/durable-idempotency evidence. Standard API requires its own key even on loopback. Desktop UI backend authentication and changing port must not be reused. `toolIsolationVerified`/`durableIdempotency` are injected mock contract flags; they do not constitute a real security attestation. Actual capabilities must rule out memory-only idempotency fallback.

Cancellation keeps the task's execution slot until trusted reconciliation. An internal operator operation now closes the gate only after proving the exact fixed successful result on the original run boundary; general failed/cancelled terminal release remains unimplemented. Do not allow requester arguments or an unverified driver to release it. Actual Stop semantics, endpoint/status normalization and hosted credential revocation remain untested.

## MCP Events preparation implemented

`EventSender` is an offline protocol foundation matching the [official MCP Events guide](https://developers.openai.com/plugins/build/mcp-events): Standard Webhooks signature headers, unique verification challenges, constant-time comparison, bounded verification lifetime, owner/filter/expiry checks, exact event bytes and stable retry IDs, fresh retry timestamps, finite attempts/backoff and stop on 410/413. Payload contains only task ID and terminal state, with no behavioral instruction or task-submission path.

`PinnedCallbackTransport` is a Node-only preparation boundary, tested with injected resolver/connector: only exact approved HTTPS URLs, no URL credentials, fresh DNS/public-IP classification on every attempt, all resolved addresses checked, pinned address plus original TLS hostname, bounded callback response and redirect rejection. Tests perform no real DNS lookup or callback connection. This Node egress implementation is not evidence of equivalent Worker egress; a hosted connection-time address/pinning boundary is still required.

Authenticated server discovery, events/list/subscribe/unsubscribe, durable encrypted subscriptions, fenced delivery, expiry/revocation/refresh checks and finite retries are now implemented and fixture-tested. They are advertised only when an operator injects EventAPI; default entrypoints inject none. Cursor replay is unsupported. See [local integration](local-integration.md) for the authoritative current contract.

Real callback/plugin connection, hosted connection-time egress, receiver crash/ack-loss verification and resident delivery remain gates. No live subscription or callback secret is created by the default application, and tests do not contact real receivers.

## Review corrections and remaining runtime decisions

Lease validity is evaluated inside the updating SQL statement, using SQLite's driver-owned `hub_now()` function or D1's database `unixepoch('subsec')` clock. A timestamp captured before an asynchronous batch cannot authorize a late heartbeat/completion. Tests invalidate leases between operation entry and SQL application on both drivers. SQLite migration existence is rechecked after acquiring the write lock; empty database and pending migration startup are tested with four independent constructors. Local stop during initial/final renewal preserves the receipt and prevents subsequent admission/terminal commit. Permanent callback HTTP status is classified at header receipt, without reading a potentially oversized body.

The current pinned Node HTTPS connector cannot be copied into Workers unchanged. [Workers HTTPS compatibility](https://developers.cloudflare.com/workers/runtime-apis/nodejs/https/) implements HTTPS over fetch and does not provide the same connection/TLS options. [Workers DNS compatibility](https://developers.cloudflare.com/workers/runtime-apis/nodejs/dns/) does not implement `lookup`. Choose an approved fixed Node egress relay, or separately prove a Workers TLS connection implementation that pins a validated address while verifying the original hostname. Neither choice is implemented or authorized here; an ordinary fetch preceded by DNS validation would not establish the required connection-time guarantee.

The server uses official split MCP server and Node HTTP packages; the pinned monolithic SDK client is retained for legacy-client fixture compatibility. Modern discovery and Events routing are tested locally. This does not establish a hosted deployment or real Events receiver interoperability.
