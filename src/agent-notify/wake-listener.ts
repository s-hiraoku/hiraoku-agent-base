/**
 * ADR-032: the notifier's doorbell. HAB rings it on new mail (an operator-registered
 * doorbell to a loopback URL, ADR-029), and the notifier checks at once instead of waiting
 * for its interval. The listener only binds 127.0.0.1, accepts only Standard Webhooks
 * requests signed with the shared `whsec_` key and at most five minutes old.
 *
 * The listener only checks the signature. Which session a ring is for, and whether it may
 * answer 410, is decided by its owner (product-host.ts answerRing).
 */
import { createServer, type Server } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { signWebhook } from "../hab/events.ts";

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

/**
 * What the owner of the doorbell made of one verified ring. Only `session_gone` (HTTP 410)
 * counts toward "recipient absent" at HAB; deciding it is the owner's job (answerRing).
 */
export type WakeAnswer =
  "accepted" | "session_gone" | "session_unconfirmed" | "bad_request";

const SESSION_GONE_BODY = JSON.stringify({ reason: "session_gone" });
const SESSION_UNCONFIRMED_BODY = JSON.stringify({
  reason: "session_unconfirmed",
});

/** Listen on loopback and hand each signed ring's body to `onWake`. A failure is unconfirmed. */
export function startWakeListener(options: {
  port: number;
  secret: string;
  onWake: (body: string) => WakeAnswer | void | Promise<WakeAnswer | void>;
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
          answer = await options.onWake(body);
        } catch {
          answer = "session_unconfirmed";
        }
        const json = { "Content-Type": "application/json" };
        if (answer === "bad_request") res.writeHead(400).end();
        else if (answer === "session_gone")
          res.writeHead(410, json).end(SESSION_GONE_BODY);
        else if (answer === "session_unconfirmed")
          res.writeHead(200, json).end(SESSION_UNCONFIRMED_BODY);
        else res.writeHead(200, json).end("{}");
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
