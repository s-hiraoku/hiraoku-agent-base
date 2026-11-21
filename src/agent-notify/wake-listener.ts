/**
 * ADR-032: the notifier's doorbell. HAB rings it on new mail (an operator-registered
 * doorbell to a loopback URL, ADR-029), and the notifier checks at once instead of waiting
 * for its interval. The listener only binds 127.0.0.1, accepts only Standard Webhooks
 * requests signed with the shared `whsec_` key and at most five minutes old.
 *
 * A session probe can report presence or absence only for a signed ring for the
 * configured address and session. Other signed requests still receive HTTP 200.
 */
import { createServer, type Server } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { HAB_EVENT_NAME, signWebhook } from "../hab/events.ts";

const MAX_BODY = 16_384;
const MAX_SKEW_S = 300;

export interface WakeListener {
  port: number;
  close(): Promise<void>;
}

/** Whether a Standard Webhooks request was signed with `secret` within the allowed skew. */
export function verifyWebhook(
  secret: string,
  headers: Record<string, string | string[] | undefined>,
  body: string,
  nowS = Math.floor(Date.now() / 1000),
): boolean {
  const id = headers["webhook-id"],
    ts = headers["webhook-timestamp"],
    sig = headers["webhook-signature"];
  if (
    typeof id !== "string" ||
    typeof ts !== "string" ||
    typeof sig !== "string"
  )
    return false;
  if (!/^[0-9]{1,12}$/.test(ts) || Math.abs(nowS - Number(ts)) > MAX_SKEW_S)
    return false;
  let expected: Buffer;
  try {
    expected = Buffer.from(signWebhook(secret, id, Number(ts), body));
  } catch {
    return false;
  }
  return sig.split(" ").some((candidate) => {
    const given = Buffer.from(candidate);
    return given.length === expected.length && timingSafeEqual(given, expected);
  });
}

/** Whether a signed ring can be accepted, or reports on the bound session. */
export type WakeAnswer = "accepted" | "session_gone" | "session_unconfirmed";

interface WakeBinding {
  address: string | undefined;
  session: string;
}

function matchesWakeBinding(body: string, binding: WakeBinding): boolean {
  try {
    const event = JSON.parse(body) as {
      name?: unknown;
      data?: { to?: unknown; session?: unknown };
    } | null;
    return (
      binding.address !== undefined &&
      event?.name === HAB_EVENT_NAME &&
      event.data?.to === binding.address &&
      event.data?.session === binding.session
    );
  } catch {
    return false;
  }
}

const SESSION_GONE_BODY = JSON.stringify({ reason: "session_gone" });
const SESSION_UNCONFIRMED_BODY = JSON.stringify({
  reason: "session_unconfirmed",
});

/** Listen on loopback and wake on a signed ring. A probe reports on its own binding only. */
export function startWakeListener(options: {
  port: number;
  secret: string;
  binding?: WakeBinding;
  onWake: () => WakeAnswer | void | Promise<WakeAnswer | void>;
}): Promise<WakeListener> {
  if (!options.secret.startsWith("whsec_"))
    throw new Error("wake_secret_invalid");
  const server: Server = createServer((req, res) => {
    if (req.method !== "POST") {
      res.writeHead(405).end();
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY) req.destroy();
      else chunks.push(chunk);
    });
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      if (!verifyWebhook(options.secret, req.headers, body)) {
        res.writeHead(401).end();
        return;
      }
      void (async () => {
        let answer: WakeAnswer | void;
        try {
          answer = await options.onWake();
        } catch {
          answer = undefined;
        }
        const binding = options.binding;
        const matches =
          binding !== undefined && matchesWakeBinding(body, binding);
        if (matches && answer === "session_gone") {
          res
            .writeHead(410, { "Content-Type": "application/json" })
            .end(SESSION_GONE_BODY);
          return;
        }
        res.writeHead(200, { "Content-Type": "application/json" }).end(
          binding && (!matches || answer !== "accepted")
            ? SESSION_UNCONFIRMED_BODY
            : "{}",
        );
      })();
    });
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, "127.0.0.1", () => {
      const address = server.address();
      resolve({
        port:
          typeof address === "object" && address ? address.port : options.port,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

/**
 * A sleep that a ring ends early. A ring during a check is remembered, so the next
 * sleep returns at once and no mail waits for a full interval.
 */
export function wakeableSleep() {
  let pending = false;
  let wake: (() => void) | undefined;
  return {
    ring() {
      if (wake) {
        const done = wake;
        wake = undefined;
        done();
      } else pending = true;
    },
    sleep(ms: number): Promise<"rung" | "interval"> {
      if (pending) {
        pending = false;
        return Promise.resolve("rung");
      }
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          wake = undefined;
          resolve("interval");
        }, ms);
        wake = () => {
          clearTimeout(timer);
          resolve("rung");
        };
      });
    },
  };
}
