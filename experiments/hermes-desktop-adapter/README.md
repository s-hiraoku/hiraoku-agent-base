# Hermes Desktop adapter for HAB

This standalone plugin connects HAB's common notifier to an **existing** Hermes
Desktop conversation. It does not fork Hermes, create a replacement Hermes agent,
start a CLI conversation, or implement a second decision database.

## Boundaries

- HAB owns authentication, receipt lookup, durable decisions, revisions, read marking,
  retry policy, and duplicate prevention.
- The Hermes adapter owns a profile-local transport and a conversation-scoped card.
  User choices go to HAB's `adapter-action`; the existing configured Hermes handoff
  reaches the same saved session through its owner gateway.
- Publishing a card is not proof that the user saw it. `queued` is not proof that
  the model started. An uncertain handoff must not be automatically repeated.
- No Gemini or Antigravity integration is claimed.

## Host requirement

The runtime plugin requires two generic SDK capabilities: the **rendered
conversation's** saved session/connection/profile context, and explicit owner routing
for plugin REST. A focused-window or ambient-profile guess is not an alternative.
Unpatched hosts must fail closed. The separately supplied minimal SDK patch is based
on Hermes commit `b189f28f7462e1cbb568db6878f096277048c079`; it contains no HAB business
logic. Do not apply the earlier external-message companion or the discarded upstream
integration as a prerequisite.

This source package has not been installed, enabled, or exercised in the user's live
Desktop. Source tests do not certify a native end-to-end exchange.

## Installation boundary

Use Hermes's supported trusted **user plugin** installation/enable workflow for the
unified package (agent backend plus `desktop/plugin.js`). The backend declares only
its own namespace, `/api/plugins/hab-desktop-adapter`, and relies on Hermes gateway
authentication and profile-local plugin hosting. Never expose its FastAPI router as
an unauthenticated standalone service. Project-local backend loading is not supported.

Create the private `config.json` in the owning profile's
`plugins/hab-desktop-adapter/` directory only after choosing and verifying the exact
saved session. The file must be a regular owner-only file (0600), not a symlink.
Do not put credentials in this file or commit it. The trusted `command` must invoke
HAB's notifier with an absolute executable and explicit notifier configuration;
it must not be constructed from messages or renderer input.

Configuration identifies:

- `binding_id` and `destination_binding`: the exact values returned by HAB `binding`;
- `stored_session_id`: the existing non-archived saved conversation;
- `connection_id` and `profile`: the Hermes UI owner (not the HAB endpoint);
- `backend_namespace`, `profile_scope`, `receiver_id`: the configured Hermes feed;
- `command`: trusted argv prefix ending with the notifier's `--config` path;
- `cwd`: absolute HAB checkout path.

The destination tuple includes the HAB connection identity, recipient, product,
profile, and session. It is checked again on reads and decisions. A changed config,
missing/archived/compressed session, mismatched owner, stale or malformed state,
or unsupported host results in unavailable actions, never a guessed replacement.

## Switching and rollback

Keep existing notifications and decisions backed up. Do not run the older built-in
external-message reader and this plugin for the same binding simultaneously: that
would display duplicate surfaces. Selecting a replacement integration is an explicit
operator cutover, not an automatic action performed by this package.

If upgrading a legacy HAB decision/feed binding, use the common **paired** migration
procedure before changing readers. Missing decision rows are not recreated from
screen history. Do not restore a pre-decision database after new decisions without
reconciliation; doing so can re-enable already handled work.

To roll back the UI, disable this plugin and restore the previous application/config
under the operator's normal process. Preserve the current authoritative HAB decision
database. Installing the SDK patch must preserve the user's selected application icon;
this package does not rebuild, overwrite, or launch the installed application.

## Identity and latency limits

Hermes's UI `connection_id` is operator-pinned separately from the HAB connection.
The HAB binding does not cryptographically identify the Hermes owner gateway URL.
The operator must pair the UI connection with the same Hermes profile/session used
by the configured trusted handoff command. This plugin does not discover or certify
that pairing automatically.

A request has a 50-second overall deadline (read command 8 seconds, decision command
40 seconds, child cleanup 2 seconds). After an uncertain decision response the UI may
refresh authoritative state, but must not automatically resend the choice. Native
handoff verification remains a separate operator check.

## Tests

Backend synthetic suite (requires Python, pytest, pytest-asyncio, FastAPI):

```sh
python -m pytest experiments/hermes-desktop-adapter/tests/test_backend.py -q
```

Fixtures use temporary private configuration and fake commands/sessions. They cover
binding/owner mismatch, malformed and missing state, reply choices, byte-bounded
pagination and key batches, config races, and timeout cleanup. They do not create a
Hermes conversation or contact HAB. Additional frontend/SDK checks are recorded with
the final source patch; do not substitute a passing synthetic test for live delivery.

The card is a runtime contribution **inside the owning conversation's composer**,
not a separate mailbox panel. Draft, hidden, historical, or unresolved-owner surfaces
cannot start polling/actions. The bounded display window retains up to 1,000 cards
and 8 MiB, discarding oldest terminal entries first; if more must be omitted it shows
an explicit truncated-history notice. This affects the UI cache only, not HAB's
stored decisions. Cursor progress continues so newer messages are not blocked.

The shared `tests/fixtures/roundtrip.json` is generated from the real backend adapter
against a synthetic HAB runner and replayed by both Python and Node tests. It covers
initial cursor omission, bounded retained-key refresh, the common `{choice,label}`
shape, an explicit decision and a later authoritative state. No native agent is used.

Catch-up uses at most four serial pages per refresh under a shared 20-second budget.
The backend requests 50 notices normally; only a locally detected output-size overflow
retries the same read-only cursor once with a one-notice page. Other failures and
user decisions are never retried automatically. Remaining history resumes on the next
poll, including after a bounded display-window eviction.
