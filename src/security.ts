/** Portable, bounded security counters. Never key by forwarded IP, token or arguments. */
export type AuditCategory =
  | "request"
  | "auth_denied"
  | "access_denied"
  | "rate_limited"
  | "resource_rejected"
  | "tool_started"
  | "tool_succeeded"
  | "tool_error"
  | "transport_error"
  | "anomaly";
export interface AuditSink {
  record(category: AuditCategory, correlation: string): void;
}
export type ToolFinish = (outcome: "tool_succeeded" | "tool_error") => void;
export interface SecurityContext {
  correlation: string;
  beginTool(): ToolFinish;
  record(category: AuditCategory): void;
}
export class SecurityMonitor {
  private window = 0;
  private requests = 0;
  private tools = 0;
  private active = 0;
  private readonly sink: AuditSink;
  private readonly now: () => number;
  constructor(sink: AuditSink = { record() {} }, now = Date.now) {
    this.sink = sink;
    this.now = now;
  }
  enter(): SecurityContext & { release(): void } {
    const correlation = crypto.randomUUID();
    this.sink.record("request", correlation);
    const time = this.now();
    if (time - this.window >= 60000) {
      this.window = time;
      this.requests = 0;
      this.tools = 0;
    }
    this.requests = Math.min(121, this.requests + 1);
    if (this.requests > 120 || this.active >= 4) {
      this.sink.record("rate_limited", correlation);
      throw new Error("Admission rejected");
    }
    this.active++;
    let released = false,
      closing = false,
      pending = 0;
    const release = () => {
      closing = true;
      if (!released && pending === 0) {
        released = true;
        this.active--;
      }
    };
    const record = (category: AuditCategory) => {
      if (
        category === "tool_started" &&
        (closing || (this.tools = Math.min(61, this.tools + 1)) > 60)
      ) {
        this.sink.record("rate_limited", correlation);
        throw new Error("Admission rejected");
      }
      this.sink.record(category, correlation);
    };
    return {
      correlation,
      record,
      release,
      beginTool: () => {
        record("tool_started");
        pending++;
        let finished = false;
        return (outcome) => {
          if (finished) return;
          finished = true;
          try {
            record(outcome);
          } finally {
            pending--;
            if (closing) release();
          }
        };
      },
    };
  }
}
export async function boundedBody(request: Request): Promise<Request> {
  if (!request.body) return request;
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  let expired = false;
  const timer = setTimeout(() => {
    expired = true;
    void reader.cancel();
  }, 5000);
  try {
    for (;;) {
      const item = await reader.read();
      if (item.done) break;
      bytes += item.value.byteLength;
      if (bytes > 32768) throw new Error("Body rejected");
      chunks.push(item.value);
    }
    if (expired) throw new Error("Body rejected");
    const body = new Uint8Array(bytes);
    let offset = 0;
    for (const chunk of chunks) {
      body.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return new Request(request.url, {
      method: request.method,
      headers: request.headers,
      body,
    });
  } finally {
    clearTimeout(timer);
    await reader.cancel().catch(() => {});
  }
}
/** Hold admission until the complete bounded response is consumed or cancelled. */
export function guardedResponse(
  response: Response,
  context: SecurityContext & { release(): void },
): Response {
  if (!response.body) {
    context.release();
    return response;
  }
  const reader = response.body.getReader();
  let bytes = 0;
  let controller: ReadableStreamDefaultController<Uint8Array>;
  const timer = setTimeout(() => {
    try {
      context.record("resource_rejected");
    } catch {
      /* No unsafe fallback logging. */
    }
    void reader.cancel().catch(() => {});
    context.release();
    controller.error(new Error("Response rejected"));
  }, 30000);
  if (typeof timer !== "number") timer.unref();
  const body = new ReadableStream<Uint8Array>({
    start(value) {
      controller = value;
    },
    async pull(controller) {
      try {
        const item = await reader.read();
        if (item.done) {
          clearTimeout(timer);
          context.release();
          controller.close();
          return;
        }
        bytes += item.value.byteLength;
        if (bytes > 65536) {
          context.record("resource_rejected");
          throw new Error("Response rejected");
        }
        controller.enqueue(item.value);
      } catch {
        clearTimeout(timer);
        context.release();
        await reader.cancel().catch(() => {});
        controller.error(new Error("Response rejected"));
      }
    },
    async cancel() {
      clearTimeout(timer);
      await reader.cancel().catch(() => {});
      context.release();
    },
  });
  const headers = new Headers(response.headers);
  headers.set("X-Request-ID", context.correlation);
  return new Response(body, { status: response.status, headers });
}
