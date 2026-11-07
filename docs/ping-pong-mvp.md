# Fixed bidirectional ping/pong pilot

This local-only diagnostic is separate from Hermes tasks. It is not a production connection. `PingService` is opt-in; the existing Worker does not instantiate it or enable authentication. Missing authentication or peer configuration fails closed.

## Contract and authority

The four MCP operations are `ping_submit`, `ping_get`, `ping_reply`, and `ping_pending`. Each pilot client requires those four dedicated scopes; legacy task execution scopes are unnecessary. Two operator-configured subject/client pairs identify Dots and Grok. Clients must differ; subjects may match. The authorization registry selects the exact verified subject/client pair within a pinned issuer; it rejects duplicate pairs and ambiguous bound/unbound legacy entries. Claims must come from verified authentication, not tool arguments. Connections shared by an account do not establish exclusive bot identity.

Only literal `ping` and `pong` are accepted. The server chooses the opposite peer. There is no shell, arbitrary message, destination URL, or personal-data field. Requests have server-generated IDs/correlation IDs, a 1–300 second TTL, and a sender-scoped request key. At most ten active requests per sender/client are allowed. This is an active-request limit, not historical retention or a complete rate limiter.

Replies require the original request ID as `in_reply_to`, the correlation ID, and the authenticated recipient. An atomic database update enforces expiry, current authorization epoch, both peers' stop gates, and reply idempotency. Stop/restore invalidates earlier diagnostic requests. All authorization edits conservatively invalidate pending diagnostics. State transitions have transactional audit and outbox records. Reply events never create new requests.

Dots-origin requests can be handed once to an injected, trusted Grok wake transport. No real transport is installed. HTTP 200 records acceptance, not completion: only authenticated correlated `pong` makes the request `replied`. An attempt marker is committed before sending. Failures, unknown acknowledgements, crashes, and timeouts are parked without automatic resend. This avoids duplicate routine invocation; it sacrifices automatic recovery. The transport gets an AbortSignal and a wait bounded by remaining TTL and at most three seconds. A future HTTP implementation must honor cancellation and forbid redirects/dynamic targets; abort cannot retract bytes already sent or guarantee provider cancellation.

Grok-origin requests are retrieved by Dots using explicit `ping_pending`, followed by `ping_reply`. Automatic Dots notification/reception is unverified and unimplemented. Neither direction polls or starts recurring jobs by default.

## Local verification

Run `npm ci`, `npm run lint`, `npm run typecheck`, and `npm test` with Node 26 or newer. SQLite and local D1 fixtures exercise both directions, expiry, correlation mismatch, scope/identity rejection, duplicate and concurrent requests/replies, durable stops, restart reconciliation, one-attempt wake delivery, HTTP 200 without completion, failed/lost acknowledgements, and bounded hung-transport waits. OAuth MCP tests use ephemeral mock signing keys and an in-process mocked issuer; no live provider is contacted.

## Proposed connection boundary

Hub and SQLite stay on the Mac. Auth0 is the identity-provider candidate; actual configuration and authenticated entrypoint wiring are unfinished. Prefer evaluating the existing Tailscale installation, preserving its separate model-agent MCP route. Owner reports that existing service reached through Funnel/Grok and rejected unauthenticated use. This is owner-provided evidence for that service, not a HAB Hub connection or independent cloud reachability test.

The local Hub entrypoint binds 127.0.0.1:8787 and defaults to denial. Hub-specific path/port, OAuth public resource URL and publication are undecided and unapproved. Current OAuthResource rejects nonstandard ports and paths other than /mcp. Same-host subpath requires path-specific metadata and challenge changes without overwriting shared root discovery; separate 8443 requires narrowly reviewed resource-port support and actual client compatibility tests. Both require preserving Authorization, verifying exact callbacks/PKCE/resource/audience and bounding requests. See [security](hab-security.md) and [ADR](hab-decisions.md).

Funnel is public internet exposure, not a tailnet-only authentication gate. Mac-to-own-Funnel success does not establish Grok cloud reachability. No existing route, port, identity or credential is reused by implication. Cloudflare Tunnel remains an alternative; custom-domain ownership is not a prerequisite for the preferred Tailscale investigation. No new tunnel, subscription, Hub publication or resident process has been authorized by source publication.

Before live registration approval, confirm the exact public endpoint, cost/usage limits, pinned issuer/resource, actual callbacks/client methods, distinct client IDs and allowed subjects. Only the four diagnostic scopes are needed. A real Grok wake requires a separately approved fixed-target backend transport, routine instruction, secret storage, bounded cancellation and redirect rejection; no webhook URL enters task arguments. Decide whether Dots needs explicit polling or a separately reviewed automatic receiver. Creating credentials, changing scopes, publishing routes, contacting bots or starting a resident dispatcher remain separate approval gates.
