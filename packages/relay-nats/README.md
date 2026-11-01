# Run opt-in HAB JetStream delivery

Use this package to select JetStream for explicit text and structured-data routes while preserving the existing HAB five-tool API. The ordinary Relay command still selects SQLite. This package creates no OS service, external listener, grant, or cloud resource.

The [delivery design](DESIGN.md) explains acceptance, authorization, route ownership, saved ACKs, and retention. The [Linux operating guide](OPERATIONS.md) covers private configuration, volume checks, backup requirements, and rollback.

## Prepare the pinned runtime

From the repository root, install the package's fixed dependencies.

```sh
npm ci --prefix packages/relay-nats --ignore-scripts
node packages/relay-nats/scripts/install-server.mjs
```

The installer verifies the official NATS Server 2.15.2 archive hash and prints the binary path. It supports Darwin and Linux on amd64 and arm64. The official JavaScript transport and JetStream client are pinned to 3.4.0 in the package lockfile.

## Run the verification

After integrating the common delivery-lab input verifier from commit `caef55b`, run the verified entry point. The verifier checks pinned executable bytes before any execution and gives the tests a private copy.

```sh
node packages/relay-nats/scripts/prove-verified.mjs --nats-server /absolute/path/to/official/nats-server --contracts test/delivery-lab/contracts.test.js --full
```

The proof records the implementation commit, package source hashes, shared contract hash, binary hash, test results, and remaining broker processes in one report. It passes a limited environment to child tests. The existing fixed-port regression group runs serially after a free-port check. A timeout stops the owned test process group.

For package development with an already verified binary, run the tests directly.

```sh
HAB_NATS_SERVER=/absolute/path/to/verified/nats-server npm test --prefix packages/relay-nats
npm run check --prefix packages/relay-nats
```

The actual Registry-backed common adapter is `test/hab-lab-adapter.js`. Its `guardedJetStreamBackend(t, { serverBinary })` accepts an explicit verified path. The earlier synthetic broker adapter remains in `test/lab-adapter.js` for the isolated P4 checks.

## Start the explicit text backend

Prepare the existing private Relay service configuration and a separate private JetStream configuration. Use [config/jetstream.example.json](config/jetstream.example.json) as a field reference. Replace every placeholder and the expected device number. Put the volume marker directly inside the selected service data directory.

Start a verified private broker with File storage and `sync_interval: always`. The [broker example](config/nats-server.example.conf) binds only loopback.

```sh
node packages/relay-nats/scripts/hab-relay-nats.mjs --config /absolute/service.local.json --jetstream-config /absolute/jetstream.local.json
```

Both configuration files must be canonical, owner-private `.local.json` files. The CLI prints only its state and local URL. It uses the existing listener, authentication, audit limits, address selection, and MCP catalog.

If the volume marker is missing, outside the data directory, or on the wrong device, startup stops before creating state files. If an extended state directory is opened through the ordinary SQLite command or a different extension ID, startup refuses. Do not remove the extension marker to bypass this check.

## Roll back new admissions

Set `routing.enabled` to `false`, increase `routing.epoch`, and restart through the same JetStream entry point. New unrelated messages use SQLite. Existing NATS IDs, their saved ACK requests, and their reply chains keep their original owner. The host continues to drain and reconcile NATS.

Do not reissue an uncertain NATS message under a new ID. Do not downgrade to an older host binary that ignores the extension marker. Independent snapshot restore and the combined A2A Task proof remain separate integration gates.
