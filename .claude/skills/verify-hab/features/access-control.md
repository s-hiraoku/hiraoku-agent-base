# Access control

Every host call must carry a bearer that maps to a verified, active agent connection. Requests without one, or with an unknown one, are refused at the HTTP layer before any tool runs.

## Sub-features

- `auth-missing` no `Authorization` header → HTTP 401 with `WWW-Authenticate: Bearer`; `audit.jsonl` gets an `auth_denied` line with `reason` `bearer_missing`.
- `auth-unknown` unknown bearer → HTTP 401; the `auth_denied` line has `reason` `credential_rejected` (an OAuth ingress names why instead, e.g. `client_not_registered`, `scope_missing`, `audience_mismatch`), never the token.
- `auth-scoped` an authenticated agent only sees its own receipts (see `send-status` in [send-message.md](./send-message.md)).

## How to get to it (user POV)

- Any `POST /mcp` call: `tools/list` or `tools/call` for any `hab_*` tool.

## Driving it with verify-hab

Preconditions:

- Baseline run, doctor OK.

- **No token.** Run `$S/mcp.sh "$RUN" none tools/list` and `$S/mcp.sh "$RUN" none hab_poll`. Both print `HTTP 401`; the saved `.headers` file has `www-authenticate: Bearer`.
- **Unknown token.** Run `$S/mcp.sh "$RUN" BAD tools/list`. `HTTP 401`. `grep auth_denied "$RUN/evidence/audit.jsonl"` shows `bearer_missing` and `credential_rejected`. Each accepted request also writes an `authenticated` line whose `connection` is the registered connection ID (`verify-a`, `verify-b`, …), never the token.
- **Known token.** Run `$S/mcp.sh "$RUN" a tools/list`. `HTTP 200` with exactly the agent catalog `hab_inbox, hab_reply, hab_send, hab_status`. Run `HAB_CATALOG=delivery $S/mcp.sh "$RUN" a tools/list`: the same token lists exactly `hab_ack, hab_mark_read, hab_peek, hab_poll, hab_resolve, hab_status, hab_submit` at `/mcp/delivery`.
- **Proof.** Keep the three `.res`/`.headers` pairs. Run `node $S/inspect.mjs "$RUN" after-auth`: no `messages` and no `delivery_audit` rows were created by the refused calls.

## Gotchas

- The tokens are synthetic (`verify-a|b|c`). A pass proves the gateway refuses unauthenticated calls, not that production Auth0 binding works.
- The Hub server on 8787 has its own, separate deny-all boundary; see "Other surfaces" in `SKILL.md`.
