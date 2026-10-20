# Access control

Every Relay call must carry a bearer that maps to a verified, active agent connection. Requests without one, or with an unknown one, are refused at the HTTP layer before any tool runs.

## Sub-features

- `auth-missing` no `Authorization` header → HTTP 401 with `WWW-Authenticate: Bearer`.
- `auth-unknown` unknown bearer → HTTP 401.
- `auth-scoped` an authenticated agent only sees its own receipts (see `send-status` in [send-message.md](./send-message.md)).

## How to get to it (user POV)

- Any `POST /mcp` call: `tools/list` or `tools/call` for any `relay_*` tool.

## Driving it with verify-hab

Preconditions:

- Baseline run, doctor OK.

- **No token.** Run `$S/mcp.sh "$RUN" none tools/list` and `$S/mcp.sh "$RUN" none relay_poll`. Both print `HTTP 401`; the saved `.headers` file has `www-authenticate: Bearer`.
- **Unknown token.** Run `$S/mcp.sh "$RUN" BAD tools/list`. `HTTP 401`.
- **Known token.** Run `$S/mcp.sh "$RUN" a tools/list`. `HTTP 200` with exactly `relay_ack, relay_poll, relay_resolve, relay_status, relay_submit`.
- **Proof.** Keep the three `.res`/`.headers` pairs. Run `node $S/inspect.mjs "$RUN" after-auth`: no `messages` and no `delivery_audit` rows were created by the refused calls.

## Gotchas

- The tokens are synthetic (`verify-a|b|c`). A pass proves the gateway refuses unauthenticated calls, not that production Auth0 binding works.
- The Hub server on 8787 has its own, separate deny-all boundary; see "Other surfaces" in `SKILL.md`.
