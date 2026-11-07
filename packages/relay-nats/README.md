# HAB JetStream delivery

This package is HAB's only delivery backend. It preserves the existing HAB five-tool API. The Relay host (`npm run relay:local`) wires it from the `delivery` section of the service configuration. This package creates no OS service, external listener, grant, or cloud resource.

The [delivery design](DESIGN.md) explains acceptance, authorization, capacity, the delivery audit, saved ACKs, and retention. The [Linux operating guide](OPERATIONS.md) covers private configuration, volume checks, backup requirements, and rollback.

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

The actual Registry-backed common adapter is `test/hab-lab-adapter.js`. Its `guardedJetStreamBackend(t, { serverBinary })` accepts an explicit verified path. The synthetic broker adapter in `test/lab-adapter.js` runs the same contracts against the backend alone, without a Registry.

## Start the Relay

Start a verified private broker with File storage and `sync_interval: always`. The [broker example](config/nats-server.example.conf) binds only loopback.

Prepare the private Relay service configuration from [config/relay-service.example.json](../../config/relay-service.example.json). Its `delivery` section has four parts:

- `broker`: the loopback server URL, dedicated user and password, stream, subject prefix, and finite consumer, byte, message-size, and request-timeout limits.
- `pump`: the publication and prefetch cycle interval and per-cycle record budget.
- `volume`: the volume marker file (directly inside the service data directory), its logical ID, and the expected device number.
- `queue`: the admission, lease, retry, scan, and required per-sender `agent_capacity` limits.

An optional `migrate_journal: true` permits an explicit journal schema upgrade. Replace every placeholder and the expected device number.

```sh
npm run relay:local -- --config /absolute/service.local.json
```

The configuration file must be a canonical, owner-private `.local.json` file. The CLI prints only its state and local URL. It uses the existing listener, authentication, audit limits, address selection, and MCP catalog.

A configuration that still has the retired SQLite `store` section, or a `delivery.routing` section, is refused with `reason=config_invalid` and the offending field paths before any state is created. Messages held by the retired SQLite store are not migrated.

If the volume marker is missing, outside the data directory, or on the wrong device, startup stops before creating state files.

Do not reissue an uncertain NATS message under a new ID. Independent snapshot restore and the combined A2A Task proof remain separate integration gates.
