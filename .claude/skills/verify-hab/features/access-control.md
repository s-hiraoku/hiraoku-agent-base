# Access control

Every host call must carry a bearer that maps to a verified, active agent connection. Requests without one, or with an unknown one, are refused at the HTTP layer before any tool runs.

## Sub-features

- `auth-missing` no `Authorization` header → HTTP 401 with `WWW-Authenticate: Bearer`; `audit.jsonl` gets an `auth_denied` line with `reason` `bearer_missing`.
- `auth-malformed` an `Authorization` header that is not `Bearer <token>`, or longer than 8192 characters → HTTP 401 with `reason` `bearer_malformed`.
- `auth-unknown` unknown bearer → HTTP 401; the `auth_denied` line has `reason` `credential_rejected` (an OAuth ingress names why instead, e.g. `client_not_registered`, `scope_missing`, `audience_mismatch`), never the token.
- `method-code` every authenticated request also writes a `method` line whose code names the MCP method (`tools_list`, `tools_call`, `prompts_list`, `resources_read_ui`, `subscriptions_listen`, `notifications_message`, …; the table follows the MCP SDK's client methods and notifications). A method outside the table is `other`; a refused one is followed by exactly one `resource_rejected` line on the same correlation (not two). The caller's method string and URI are never written.
- `auth-scoped` an authenticated agent only sees its own receipts (see `send-status` in [send-message.md](./send-message.md)).

## How to get to it (user POV)

- Any `POST /mcp` call: `tools/list` or `tools/call` for any `hab_*` tool.

## Driving it with verify-hab

Preconditions:

- Baseline run, doctor OK.

- **No token.** Run `$S/mcp.sh "$RUN" none tools/list` and `$S/mcp.sh "$RUN" none hab_poll`. Both print `HTTP 401`; the saved `.headers` file has `www-authenticate: Bearer`.
- **Unknown token.** Run `$S/mcp.sh "$RUN" BAD tools/list`. `HTTP 401`. `grep auth_denied "$RUN/evidence/audit.jsonl"` shows `bearer_missing` and `credential_rejected`. Each accepted request also writes an `authenticated` line whose `connection` is the registered connection ID (`verify-a`, `verify-b`, …), never the token.
- **Known token.** Run `$S/mcp.sh "$RUN" a tools/list`. `HTTP 200` with exactly the agent catalog `hab_inbox, hab_reply, hab_send, hab_status`. Run `HAB_CATALOG=delivery $S/mcp.sh "$RUN" a tools/list`: the same token lists exactly `hab_ack, hab_mark_read, hab_peek, hab_poll, hab_resolve, hab_status, hab_submit` at `/mcp/delivery`.
- **Method codes.** After the known-token calls, `grep '"category":"method"' "$RUN/evidence/audit.jsonl"` shows `tools_list` and `tools_call`. POST `{"jsonrpc":"2.0","id":9,"method":"prompts/list","params":{}}` with `Bearer verify-a` to the stack URL: HTTP 405, a `method` line `prompts_list`, then `resource_rejected` on the same correlation. A made-up method such as `x-private/probe` is recorded as `other` and the string does not appear in `audit.jsonl`.
- **Proof.** Keep the three `.res`/`.headers` pairs. Run `node $S/inspect.mjs "$RUN" after-auth`: no `messages` and no `delivery_audit` rows were created by the refused calls.

## Gotchas

- The tokens are synthetic (`verify-a|b|c`). A pass proves the gateway refuses unauthenticated calls, not that production Auth0 binding works.
- A shipped host with no valid credential answers `tools/list` with HTTP 401. A valid local credential that is not connected to a Registry address still lists the full static agent or delivery catalog; authorization is checked when a tool is called (typically `forbidden` until connect). That path is covered by [configured-host.md](./configured-host.md), not a separate fixed-port Hub binary.
