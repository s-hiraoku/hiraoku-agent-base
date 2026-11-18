# New-mail events for cloud agents

A cloud agent such as Dots (ChatGPT) subscribes, over its own OAuth connection to the ingress `/mcp`, to the MCP event `hab.message.received` (ADR-022). When mail arrives for it, HAB POSTs a signed Standard Webhooks doorbell to the subscribed public HTTPS callback carrying only `{to, arrived_at}`; the agent still reads the mail with its own `hab_inbox`, and the doorbell marks nothing read. Off unless the host config has `ingress.events`.

## Sub-features

- `events-capability` with `ingress.events`, `initialize` on the ingress `/mcp` advertises `capabilities.events`; `events/list` returns one event `hab.message.received` with an empty `inputSchema` and a payload of `to` and `arrived_at` only. Without `ingress.events`, on `/mcp/delivery` and on loopback, the HTTP admission refuses `events/*` with 405 and no `events` capability is advertised.
- `events-subscribe` `events/subscribe {name, arguments:{}, delivery:{mode:"webhook", url, secret:"whsec_…"}, ttlMs}` first POSTs a signed `{"type":"verification","challenge"}` and subscribes only when the same challenge comes back; it returns `{id:"hab_sub_…", refreshBefore, cursor:null, truncated:false}`. The same connection and URL get the same `id`; resubscribing replaces the secret and resets the lifetime to now + `ttlMs` (clamped to 60 s – `max_ttl_ms`), so a smaller `ttlMs` shortens it. Refusals carry `data.reason`: `unknown_event`, `invalid_arguments`, `invalid_params`, `unsupported_delivery`, `invalid_secret`, `invalid_callback_url`, `too_many_subscriptions` (-32602); `callback_not_public`, `challenge_failed`, `timeout` (-32015).
- `events-doorbell` each new unread message sends one POST per subscription with `webhook-id` = `eventId`, `webhook-timestamp`, `webhook-signature: v1,<base64 HMAC-SHA256 of id.timestamp.body>` and `X-MCP-Subscription-Id`; the body has no text, sender, kind or message ID, and the message stays `pending` until `hab_inbox`.
- `events-retry` a non-2xx is resent with the same `eventId` (up to 8 attempts; the wait is `2 s × 2^failures` capped at 5 min, so the first retry comes after 4 s, then 8 s, 16 s, …); 413 or the 8th failure moves on; 410 deletes the subscription. Expired subscriptions and `events/unsubscribe` stop delivery.
- `events-store` subscriptions live in `<state>/events.sqlite`, owner-only (0600); it holds the webhook secrets.
- `events-outage` (ADR-024) the dispatcher stamps a clock every tick, also while a slow pass runs. A gap longer than `outage_after_ms` (default 60 s, never below 3 polls so ordinary ticks never extend lifetimes; config 1000–86400000) means the host was stopped or the Mac slept: subscriptions alive when the gap began get the gap added to their lifetime, at most `max_ttl_ms`. A subscription that had already expired while ticks were running is not revived.
- `events-lapse` (ADR-024) a subscription ending by expiry, 410 or `events/unsubscribe` records the recipient's last `lapsed_at` and reason (`expired`/`gone`/`unsubscribed`); subscribing again clears it. `hab:admin status` → `inboxes[]` shows `unread`, `oldest_unread_at`, `doorbell` (`live`/`lapsed`/`none`/`off`) and adds `problems` `unread_waiting` (unread ≥ 30 min) and `doorbell_lapsed`, without callback URLs or secrets. Once a recipient has been rung it also shows `doorbell_last_rang_at`, `doorbell_last_status` (the callback's HTTP status, `0` for no answer) and `doorbell_last_delivered_at` (last 2xx), with `doorbell_failing` when the latest ring was not 2xx. HAB never re-creates a subscription itself.

## How to get to it (user POV)

- Operator adds `"events": {}` to the host `ingress` config and restarts ([MCPイベントで新着を知らせる](../../../../docs/connections/mcp-events.md)). The user reconnects the ChatGPT connector and asks Dots to run a task on `hab.message.received` that calls `hab_inbox`. Muse has no events; it uses its own scheduled task calling `hab_inbox`.

## Driving it with verify-hab

- The verify-hab stack starts only the loopback catalogs, which never offer events, and has no OAuth issuer or public HTTPS callback. Check the absence there: a raw JSON-RPC POST of `events/list` to `/mcp` → HTTP 405.
- Everything else is covered by unit tests with an injected HTTPS poster and an in-process OAuth ingress: `node --test test/hab-events.test.js` (signature vector, SSRF refusals, capability and list, verification and idempotency, challenge failure, doorbell without content with the message still unread, retry/backoff/410, expiry and unsubscribe, owner-only store, outage credit and its cap, lapse records, latest ring status, a slow pass is not an outage) and `node --test --test-name-pattern "ingress events" test/host-oauth.test.js` (the configured ingress advertises and answers events; the loopback and delivery catalogs do not).
- A live check needs a public HTTPS receiver and a real OAuth agent connection; do it only in an owner-authorized acceptance run (for example Dots on the Mac mini), never with a callback this run does not own.

## Gotchas

- The doorbell is not delivery. Never assert on mail content from a webhook; read it with `hab_inbox` as the subscribed agent.
- Callbacks to private, loopback, link-local, mapped or `.local`/`.internal` names are refused before any request, so a local test receiver cannot be used without the injected poster.
- Whether ChatGPT actually starts work on an event, and how late, is ChatGPT's decision; HAB only proves it sent a signed POST.
- Outage credit cannot be shown on the verify-hab stack (no events there). It is unit-tested with an injected clock; `node --test --test-name-pattern "unread mail waiting" test/host-admin.test.js` covers the `inboxes` view on a configured host. On a live host, check `hab:admin status` for `doorbell_lapsed` after the host was down.
