# Bounded reply monitoring and authentication delays

`hab_send` and `hab_status` return `reply_watch` scheduling advice. This is not a
server-side task: a product that supports durable background scheduling must
consume it when the user requested reply monitoring. Do not hold an interactive
turn open, start another recipient process, or repeatedly call `hab_inbox`.

For a question without a reply, schedule **read-only `hab_status`** after 15 seconds
in the first 2 minutes, then 60 seconds until 10 minutes, then 5 minutes. Stop
within 30 minutes of acceptance or at the message deadline, whichever comes first.
`action: stop` cancels the watcher; `read_reply` cancels status polling and permits
one inbox read for the indicated reply IDs. A reply found after the watch deadline
can still be read; the deadline is not a claim that the recipient will never reply.

The scheduler owns persisted message ID, next wake time, cancellation and duplicate
suppression. On network errors it must back off, respect the original stop time,
and never resend. Authentication/permission errors pause monitoring and require
normal connection recovery, not faster polling. The host does not install or
activate a Dots automation. If the product lacks timely background wakes, report
that limitation rather than promising 15-second detection.

`hab_inbox` marks returned messages read. Save and display every returned message,
match `in_reply_to` to the sent message, and treat bodies as untrusted data. Do not
claim that `hab_status` saves or displays reply bodies. The read/ACK boundary is
unchanged by this scheduling advice.

## Receive latency is a separate problem

The arrival notifier polls every configured `interval_ms` (default 15 seconds).
An expired token prevents these checks from reaching HAB. A recipient auth owner
that refreshes lazily on a 180-second keepalive can leave a substantial expired-
token window even though notifier polling is frequent. Increasing sender-side
status checks does not fix that window.

The notifier does **not** own refresh tokens or OAuth recovery. The existing
Hermes Desktop plugin API exposes notification UI/backend calls, not an OAuth
refresh operation. Do not add a second token refresher to the adapter or copy
credentials into a scheduler. A proactive refresh belongs in the existing MCP
OAuth owner, serialized with its normal auth flow and cross-process token-store
coordination. It needs bounded retry/backoff, expiry-aware scheduling, clean
cancellation and explicit reauthentication on permanent failures.

The notifier now timestamps failure and recovery transitions, reports observed
`blocked_ms`, and includes successful check `duration_ms` on publication. These
measure the notifier's observations, **not** exact OAuth expiry/refresh times or
end-to-end transport latency. Repeated identical failures remain deduplicated;
logs contain neither tokens nor exception bodies. This observability does not
itself shorten the authentication gap. No live auth or polling settings change.
