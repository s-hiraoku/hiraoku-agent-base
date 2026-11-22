import { createServer } from "node:net";
import { once } from "node:events";

/**
 * A loopback port the OS says is free now. A random pick can land in Linux's ephemeral
 * range (32768–60999), where a parallel test file's outgoing connection may hold it:
 * the listener then fails with EADDRINUSE and every ring is refused.
 */
export async function freePort() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  await new Promise((done) => server.close(done));
  return port;
}
