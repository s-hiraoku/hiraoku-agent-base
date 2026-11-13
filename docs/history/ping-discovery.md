# Ping discovery only

This separate, manually invoked diagnostic mode publishes authentication guidance
without enrolling a peer or permitting an MCP operation. It never promotes itself
to the operational ping runner. It does not instantiate a database, JWT verifier,
JWKS client, peer registry, MCP tool server, worker or model. Bearer content is
ignored, never decoded, persisted or logged. No outbound fetch is performed.

The strict config has `mode: "ping-discovery"` and `enabled: false`. Peer fields,
activation flags and unknown settings are rejected. `OAuthResource` validates the
explicit Auth0 issuer and HTTPS resource; the MCP path must be `/hab/mcp`. The
example's issuer placeholder is intentionally invalid. It contains no identity or
credentials. Use a separately approved, owner-only canonical `*.local.json`.

For admitted, bounded requests, `/hab/mcp` always returns an empty HTTP 401 with
`WWW-Authenticate` referring to its protected-resource metadata. It does not parse
JSON-RPC or expose `tools/list`, including when a Bearer header is present. GET
`/.well-known/oauth-protected-resource/hab/mcp` returns the existing OAuthResource
metadata with exactly `hub:ping_submit`, `hub:ping_get`, `hub:ping_reply`, and
`hub:ping_pending`. Other metadata methods return 405, other paths return 404.

Only the configured public Host and optional matching Origin are accepted;
loopback Hosts and forwarded authority are not trusted. Duplicate Host, Origin or
Authorization is rejected. Limits are 16 KiB Node headers, 32 KiB bodies, five
seconds to read a body, 32 connections, 60 requests per socket, and the existing
SecurityMonitor admission limits (120 requests per minute, four concurrent).
Boundary/limit/shutdown failures may return 403/413/503 or close the connection.
Bodies are consumed within limits and discarded without parsing or logging.
No detailed request or credential logs are written in this discovery mode.

The sole listener is `127.0.0.1:8789`, with a config lifetime of 1 second through
15 minutes. Deadline, SIGINT/SIGTERM or server errors close admission and owned
connections. Cleanup is bounded; failure to confirm listener/handler shutdown is
`ping_discovery_stop_uncertain`. A crash or OS kill cannot guarantee graceful
cleanup. This mode does not create a service, publish routes or acquire secrets.

After separate approval, the operator invocation is:

```sh
HAB_PING_DISCOVERY_CONFIG=/approved/private/discovery.local.json \
node src/ping-discovery-cli.ts
```

This documentation and the tests do not start a listener or publish anything.
A later finite publication must add only `/hab/mcp` and the exact metadata path,
then remove both and verify the existing `/mcp` and Dashboard paths remain. The
proxy route needs its own removal deadline; listener expiry does not remove it.

Discovery does not establish a Grok callback or client identity. Metadata contains
no client ID or redirect URI. When dynamic client registration is disabled, a
client may need a separately pre-registered OAuth client and exact callback before
it can start authorization. Confirm those through the client/provider UI; never
invent an identity, reuse another peer's client, or infer a callback from a 401.
Real ping/pong acceptance still requires verified peers, grants, a separate active
config/process, and a confirmed manual round trip. No callback/OAuth flow is tested
by the dummy suite.
