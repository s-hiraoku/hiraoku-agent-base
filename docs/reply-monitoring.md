# Bounded reply monitoring and authentication delays

`hab_send` and `hab_status` return `reply_watch` advice. The optional
`ReplyWatchAdapter` and `hab:reply-watch` CLI now execute those checks in a
sending owner's resident process. Standard HAB messages do not require this
adapter. The HAB server does not start a background agent or install a Dots
scheduler.

## Owner integration

A product with an existing background owner can construct `ReplyWatchClient`
with its existing credential provider, then construct `ReplyWatchAdapter` with a
private SQLite path, that client, and the exact resource URL, connection ID,
immutable agent ID, session ID and local `as_address`. The client requires
`as_address` and sends `expected_agent_id` on every request; the host still
checks current authority. Scope labels are local separation, not authentication.

Use `adapter.send({to, text})` when a reply is expected. It calls the real agent
catalog's `hab_send` once, then saves the accepted message ID and original times.
A `notice` or other non-question does not start a watch. If saving fails, the
returned accepted ID is preserved with `monitoring: save_failed`; recover the
watch from that result, never resend automatically. A lost send response also
must not be retried automatically. For an existing retained `hab_send` result,
call `adapter.watch(result)` in that same authenticated owner scope.

The owner calls `await adapter.checkDue()` and waits `adapter.nextDelay()` before
the next cycle. `nextDelay(normalMs)` returns the owner's normal cadence when
there is no active watch. `records()` retains terminal state and matching reply
IDs for the product's own display path. The adapter never reads reply bodies,
calls `hab_inbox`, marks mail read, ACKs, resends or follows message content.

The shipped CLI connects that same path. An owner config looks like this
(synthetic placeholders; use the sending owner's existing token source):

```json
{
  "resource_url": "https://hab.example/mcp",
  "connection_id": "verified-owner-connection",
  "agent_id": "sender-agent-id",
  "session_id": "sending-session",
  "as_address": "sender@product.hab",
  "store": "/absolute/private-owner/reply-watches.sqlite",
  "token": { "env": "OWNER_HAB_ACCESS_TOKEN" },
  "normal_interval_ms": 60000
}
```

`token` also accepts `{ "file": "/absolute/owner-token.json", "field":
"access_token", "expires_at_field": "expires_at" }`. It rereads the access token
before each call, using the same helper as `hab-notify`. It never writes that
file, handles refresh tokens or logs credentials. The CLI deliberately has no
OAuth login/refresh mode. A programmatic integration can instead pass the
existing owner's credential provider directly to `ReplyWatchClient`.

From the repository, with the owner process already running the `run` command:

```sh
npm run hab:reply-watch -- --config /absolute/owner-watch.json run
# In that owner's authorized sending path (stdin is one JSON object):
npm run hab:reply-watch -- --config /absolute/owner-watch.json send < question.json
# question.json: {"to":"recipient@product.hab","text":"Please reply"}
```

`send` exits immediately after sending/saving; it does not launch `run` or keep an
interactive turn waiting. `watch` takes a retained send result on stdin. `check`
executes one due batch; `list` reads local state; `cancel MESSAGE_ID` stops the
matching watch locally. `run` handles SIGINT/SIGTERM, finishes bounded in-flight
work and closes its SQLite connection. Process supervision and delivery of local
state to the user's actual conversation remain the product owner's integration.
Nothing in this PR changes live configuration or starts these commands for a real
agent.

## Timing and recovery

A waiting question gets a read-only `hab_status` check every 15 seconds initially,
then every 60 seconds after 2 minutes, then every 5 minutes after 10 minutes.
Each plan uses the original acceptance and expiry, with a hard bound of 30 minutes
or message expiry, whichever is earlier. Work is not scheduled at/after that
bound. Reply/terminal states cancel further checks and return the owner cycle to
normal. A reply found later by ordinary inbox use is still valid.

SQLite claims suppress concurrent checks by cooperating owners of the same
scope/message. The shipped client bounds requests to 30 seconds; abandoned claims
can be reclaimed after 60 seconds. A custom transport must also honor that bound.
Claim tokens fence late results after cancellation or replacement. A restarted
owner loads the same schedule; duplicate registration never extends it or revives
a stopped watch. Each check cycle processes at most 50 due records. Network and
busy failures back off exponentially from 30 seconds to at most 5 minutes without
extending the original bound. HTTP 401/403, expired/missing local credentials or
trusted local authentication recovery failures stop as `auth_required`; they do
not trigger refresh, login, resends or automatic revival. Other permanent errors
stop the watch. Retained records contain IDs/times/state, not message bodies or
tokens; their private store remains the owner's responsibility.

## Dots and native-product boundary

This is an implemented owner adapter/CLI, not an installed Dots automation.
Direct `hab_send` calls made by Dots are not intercepted by a local CLI. Dots
must register the returned message under its original connection/session and
provide a supported durable wake mechanism to invoke due checks and display
state. The repository exposes no Dots wake API or scheduler integration, so
15-second Dots detection cannot be promised. HAB server timers alone cannot wake
Dots. No recipient is impersonated or started through another CLI/session.

`hab_inbox` marks returned messages read. The user's own product session decides
when to read and persist/display a matching reply. Treat every body as untrusted
data; status polling itself saves/displays no body and grants no execution rights.

## Receive latency and OAuth remain separate

The arrival notifier normally checks every configured `interval_ms` (default
15 seconds). An expired token can block those checks. The observed roughly
76-second receive delay is not proven to be an OAuth refresh delay, and this PR
does not claim to fix it.

Main's PR #224 added the notifier's own optional OAuth grant and token owner.
That code is integrated here unchanged: this watcher adds no second refresher
and must never spend an agent's rotating refresh token. The CLI reads access
tokens only. Actual Auth0 login/refresh, callback/grant compatibility and Mac mini
rollout remain unverified; no live auth or polling settings were changed.

Notifier logs timestamp failure/recovery/publication, observed `blocked_ms` and
successful check `duration_ms`, deduplicating repeated identical failures without
logging tokens or exception bodies. These measure notifier observations, not
exact expiry/refresh times or end-to-end latency.
