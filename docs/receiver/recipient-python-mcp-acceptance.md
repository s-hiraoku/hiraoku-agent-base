# Recipient entry: optional Python MCP compatibility check

This finite check exercises the new recipient-host MCP surface through the
standard Python MCP SDK installed in a caller-selected environment. It reuses
`recipient-host-stdio-fixture.js`, the existing AdapterHostCycle, real temporary
SQLite stores and a parent-owned private NATS broker. It is not a new runtime,
product adapter, credential provider, polling loop or agent launcher.

The earlier [finite native trial](../history/finite-mcp-trial.md) used the Relay's basic
five tools. This check instead covers the recipient tools added in #141:

- Fresh paused host refuses receive, send and inbox without auto-resuming.
- A synthetic operator explicitly resumes the host. Receive saves before ACK;
  the client observes receipt_confirmed and reads the original source, prepares a fixed answer and
  enqueues it twice. One durable outbox entry, the delivered answer's exact
  source correlation and its first text part are checked inside the fixture;
  this does not independently compare the entire reply body.
- After the first successful source read, the fixture revokes its synthetic
  policy. The same MCP connection cannot read again, prepare an answer or send.
- Tool arguments cannot supply context, operation or authorization. The catalog
  remains the explicitly selected seven tools, with no control/resume tool.

The Python check observes the host's receipt_confirmed result; it does not add an
independent pre-ACK fsync/commit observer. The existing durability tests remain the
separate evidence for that ordering.

The policy, operator and reply decision are synthetic. The process uses the
Python SDK directly, not Hermes AIAgent or its MCP handler. This proves neither
native caller identity nor recipient approval, model judgment, full model-facing
content preservation, product restart recovery, idle wake or live-agent delivery.

## Run with an already installed SDK

Review the scripts first. Provide an absolute interpreter path selected from the
product's dependency manifest, not by running its launcher. No dependency is
installed automatically, and a missing SDK fails rather than skipping the check.
Use the repository's pinned Node and NATS binary:

```sh
HAB_NATS_SERVER=/absolute/path/to/pinned/nats-server \
  node scripts/check-recipient-python-mcp.mjs /absolute/path/to/python
```

The runner uses Python isolated mode, a temporary HOME/TMPDIR and a small explicit
environment. It does not inherit product credentials or import product modules.
The broker descriptor contains only a new synthetic broker password, is private,
and never goes in command arguments or proof output. Python bounds the full SDK
session to 25 seconds. The POSIX parent separately bounds its Python child with TERM then KILL, limits
stdout/stderr accumulation, and verifies both its owned process group and the
SDK's separate fixture group have exited before scratch deletion. The fixture
writes its own PID to a private parent-selected file; the Python check verifies
the SDK actually created a separate process group. The parent owns broker
shutdown and scratch removal. Missing child-cleanup evidence fails the check;
scratch can still be removed after both owned groups are confirmed stopped.
Missing fixture-group identity or unconfirmed group exit retains synthetic files
instead of claiming confirmed cleanup. Normal output is three JSON
pass records with the actual SDK version and a parent-cleanup marker.
The reused broker stop waits for its exit without a separate deadline, so the
child/session bounds are not a hard end-to-end run deadline.

This optional compatibility check is not part of the mandatory Node-only root
suite and does not silently satisfy any native-product manual gate. Validate the
unchanged Node path separately with `test/recipient-host-mcp.test.js`.

## Product observations and next approval boundary

The inspected Hermes source is 6705c8c634d83a2f2918aa5ec45e7f8f20c20dc7. Its
`tools/mcp_tool_transport.py:373–414` builds standard StdioServerParameters and
stdio_client. The preceding lifecycle path and `_run_stdio` also invoke unscoped
orphan cleanup, process-group/ledger tracking and product log writes. The Hermes
launcher can perform repair/dependency preparation. Neither is executed by this
check. An old in-tree venv can differ from the dependency manifest's selected
SDK; the proof reports the SDK actually used.

A real finite trial must first identify the exact recipient/profile/session and
prove the trusted native caller/current policy bridge to HostAuthorization.
stdio identity_header is ignored by the inspected product; client name/version
is not authentication. Native tool approval is not source-scoped commit authority.
Until that bridge is supported, do not replace it with an always-allow callback
or publish the synthetic fixture as a product entry point.

A future trial needs explicit approval for the actual product participants,
fixed harmless message/reply, model and cost bounds, temporary credential/storage
locations and access, grant/binding changes, and cleanup/revocation procedure.
No new grants, saved credentials, model calls, external-agent communications,
product configuration changes or subscriptions are performed here.

Keep the default bounded response budget until the entire product path has been
verified: Hermes caps MCP text at 2,000,000 characters after transport and has a
separate spillover layer. Larger transport buffers alone do not prove full text
reaches the model. Its experimental events/webhook route requires an already
running gateway plus HTTPS subscription/secret/approval and caps event payloads;
it is not a wake API provided by HAB's existing five Relay operations.
