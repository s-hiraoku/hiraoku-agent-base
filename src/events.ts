import { Webhook } from "standardwebhooks";
import { timingSafeEqual } from "node:crypto";
import type { Outbox } from "./types.ts";
export class CallbackPolicyError extends Error {}
export interface Subscription {
  id: string;
  subject: string;
  task_id: string;
  url: string;
  secret: string;
  expiresAt: number;
}
export interface CallbackTransport {
  post(
    url: string,
    headers: Record<string, string>,
    body: string,
  ): Promise<{ status: number; body: string }>;
}
export class EventSender {
  private verifiedUntil = 0;
  constructor(readonlyOptions: {
    subscription: Subscription;
    transport: CallbackTransport;
    authorise: (subject: string, taskId: string) => Promise<boolean>;
    now?: () => number;
    wait?: (ms: number) => Promise<void>;
    maxAttempts?: number;
    allowGrantedRecipient?: boolean;
    previousSecret?: { secret: string; until: number };
  }) {
    this.options = readonlyOptions;
  }
  private readonly options: {
    subscription: Subscription;
    transport: CallbackTransport;
    authorise: (subject: string, taskId: string) => Promise<boolean>;
    now?: () => number;
    wait?: (ms: number) => Promise<void>;
    maxAttempts?: number;
    allowGrantedRecipient?: boolean;
    previousSecret?: { secret: string; until: number };
  };
  private now() {
    return this.options.now?.() ?? Date.now();
  }
  private async active(taskId: string) {
    const s = this.options.subscription;
    if (
      s.expiresAt <= this.now() ||
      s.task_id !== taskId ||
      !(await this.options.authorise(s.subject, taskId)) ||
      s.expiresAt <= this.now()
    )
      throw new CallbackPolicyError("subscription_not_authorised");
    return s;
  }
  private headers(id: string, body: string) {
    const s = this.options.subscription,
      date = new Date(this.now());
    let signature = new Webhook(s.secret).sign(id, date, body);
    const previous = this.options.previousSecret;
    if (previous && previous.until > this.now())
      signature += ` ${new Webhook(previous.secret).sign(id, date, body)}`;
    return {
      "Content-Type": "application/json",
      "webhook-id": id,
      "webhook-timestamp": String(Math.floor(date.getTime() / 1000)),
      "webhook-signature": signature,
      "X-MCP-Subscription-Id": s.id,
    };
  }
  async verify(): Promise<void> {
    const s = await this.active(this.options.subscription.task_id);
    this.verifiedUntil = 0;
    const challenge = crypto.randomUUID(),
      body = JSON.stringify({ type: "verification", challenge }),
      id = crypto.randomUUID();
    const response = await this.options.transport.post(
      s.url,
      this.headers(id, body),
      body,
    );
    if (
      response.status >= 300 &&
      response.status < 500 &&
      response.status !== 429
    )
      throw new CallbackPolicyError("callback_verification_terminal_rejection");
    if (
      response.status < 200 ||
      response.status >= 300 ||
      response.body.length > 16384
    )
      throw new Error("callback_verification_failed");
    let returned: unknown;
    try {
      returned = (JSON.parse(response.body) as { challenge?: unknown })
        .challenge;
    } catch {
      throw new Error("callback_verification_failed");
    }
    if (
      typeof returned !== "string" ||
      Buffer.byteLength(returned) !== Buffer.byteLength(challenge) ||
      !timingSafeEqual(Buffer.from(returned), Buffer.from(challenge))
    )
      throw new Error("callback_verification_failed");
    this.verifiedUntil = Math.min(s.expiresAt, this.now() + 300000);
  }
  async send(event: Outbox): Promise<void> {
    const s = await this.active(event.task);
    if (
      this.verifiedUntil <= this.now() ||
      (event.owner !== s.subject && !this.options.allowGrantedRecipient) ||
      !["succeeded", "failed", "cancelled"].includes(event.event)
    )
      throw new Error("event_not_authorised");
    const body = JSON.stringify({
      eventId: event.id,
      name: "task.terminal",
      timestamp: new Date(event.at).toISOString(),
      data: { task_id: event.task, state: event.event },
      cursor: null,
    });
    if (Buffer.byteLength(body) > 262144) throw new Error("event_too_large");
    const attempts = Math.min(this.options.maxAttempts ?? 3, 5);
    for (let n = 0; n < attempts; n++) {
      await this.active(event.task);
      if (this.verifiedUntil <= this.now())
        throw new Error("verification_expired");
      let status: number;
      try {
        status = (
          await this.options.transport.post(
            s.url,
            this.headers(event.id, body),
            body,
          )
        ).status;
      } catch (e) {
        if (e instanceof CallbackPolicyError) throw e;
        status = 503;
      }
      if (status >= 200 && status < 300) return;
      if (
        status === 410 ||
        status === 413 ||
        (status >= 300 && status < 500 && status !== 429)
      )
        throw new Error("delivery_terminal_rejection");
      if (n + 1 < attempts)
        await (
          this.options.wait ?? ((ms) => new Promise((r) => setTimeout(r, ms)))
        )(Math.min(100 * 2 ** n, 1000));
    }
    throw new Error("delivery_retry_exhausted");
  }
}
