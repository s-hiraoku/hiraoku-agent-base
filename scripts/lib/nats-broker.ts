/** A private loopback nats-server for local simulations and tests. Never a production broker. */
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { createServer, createConnection } from "node:net";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Buffer } from "node:buffer";
import { randomBytes } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

const repo = new URL("../../", import.meta.url);

/** The fixed, secret-free refusal printed when no pinned nats-server binary can be found. */
export const NATS_SERVER_REQUIRED =
  "nats_server_required: set HAB_NATS_SERVER to the pinned nats-server 2.15.2, or run `mkdir -m 700 -p .runtime && node packages/relay-nats/scripts/install-server.mjs > .runtime/nats-install.json`";

/** The pinned nats-server binary: HAB_NATS_SERVER, else the repo's `.runtime/nats-install.json`. */
export function natsServerBinary(environment = process.env) {
  if (environment.HAB_NATS_SERVER) {
    if (existsSync(environment.HAB_NATS_SERVER))
      return environment.HAB_NATS_SERVER;
  } else {
    const record = new URL(".runtime/nats-install.json", repo);
    if (existsSync(record)) {
      const { binary } = JSON.parse(readFileSync(record, "utf8"));
      if (typeof binary === "string" && existsSync(binary)) return binary;
    }
  }
  throw Object.assign(Error(NATS_SERVER_REQUIRED), {
    code: "nats_server_required",
  });
}

async function freePort() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string")
    throw Error("nats_server_port_unavailable");
  const { port } = address;
  await new Promise((done) => server.close(done));
  return port;
}
async function reachable(port: number) {
  const socket = createConnection({ host: "127.0.0.1", port });
  try {
    await Promise.race([
      once(socket, "connect"),
      once(socket, "error").then(([error]) => {
        throw error;
      }),
    ]);
    return true;
  } catch {
    return false;
  } finally {
    socket.destroy();
  }
}

/**
 * Starts nats-server with JetStream file storage under `directory` and one random-password user.
 * The caller owns the returned `stop`; the process is also killed if this process exits first.
 * `keepAlive` holds this process open while the broker runs (a run that owns its broker);
 * shared test brokers leave it off so they never keep a finished test process alive.
 */
export async function startLocalBroker(
  directory: string,
  { maxFileStore = "1GB", keepAlive = false } = {},
) {
  const binary = natsServerBinary();
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const port = await freePort();
  const password = Buffer.from(randomBytes(24)).toString("hex");
  const config = join(directory, "broker.conf");
  writeFileSync(
    config,
    `host: 127.0.0.1\nport: ${port}\njetstream {\n store_dir: ${JSON.stringify(join(directory, "store"))}\n max_file_store: ${maxFileStore}\n max_memory_store: 0\n sync_interval: always\n}\naccounts { HAB {\n jetstream: enabled\n users: [{user: backend, password: ${JSON.stringify(password)}}]\n} }\n`,
    { mode: 0o600 },
  );
  let child: ChildProcess | undefined;
  const kill = () => child?.kill("SIGKILL");
  const start = async () => {
    child = spawn(binary, ["-c", config], { stdio: "ignore" });
    if (!keepAlive) child.unref();
    const failure: { error?: NodeJS.ErrnoException } = {};
    child.once("error", (error) => (failure.error = error));
    const deadline = Date.now() + 10000;
    while (!(await reachable(port))) {
      if (failure.error || child.exitCode !== null)
        throw Error(
          `nats_server_start_failed (${failure.error?.code ?? `exit ${child.exitCode}`}); check HAB_NATS_SERVER`,
        );
      if (Date.now() > deadline) throw Error("nats_server_start_timed_out");
      await delay(20);
    }
  };
  const stop = async () => {
    process.removeListener("exit", kill);
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, "exit");
    child.kill("SIGTERM");
    await exited;
  };
  process.once("exit", kill);
  try {
    await start();
  } catch (error) {
    kill();
    process.removeListener("exit", kill);
    throw error;
  }
  return {
    server: `nats://127.0.0.1:${port}`,
    user: "backend",
    password,
    async restart() {
      await stop();
      process.once("exit", kill);
      await start();
    },
    stop,
  };
}
