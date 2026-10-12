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
  | "anomaly"
  | "aggregate";
export interface AuditSink {
  record(category: AuditCategory, correlation: string): void | Promise<void>;
  check?(): void;
  note?(category: AuditCategory): void;
}
export type ToolFinish = (
  outcome: "tool_succeeded" | "tool_error",
) => Promise<void>;
export interface SecurityContext {
  correlation: string;
  beginTool(): Promise<ToolFinish>;
  record(category: AuditCategory): Promise<void>;
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
  async enter(
    onAdmitted?: (release: () => void) => void,
  ): Promise<SecurityContext & { release(): void }> {
    const correlation = crypto.randomUUID();
    this.sink.check?.();
    const time = this.now();
    if (time - this.window >= 60000) {
      this.window = time;
      this.requests = 0;
      this.tools = 0;
    }
    this.requests = Math.min(121, this.requests + 1);
    if (this.requests > 120 || this.active >= 4) {
      this.sink.note?.("rate_limited");
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
    try {
      onAdmitted?.(release);
      await this.sink.record("request", correlation);
      if (closing) throw new Error("Admission rejected");
    } catch {
      release();
      throw new Error("Admission rejected");
    }
    const record = async (category: AuditCategory) => {
      if (
        category === "tool_started" &&
        (closing || (this.tools = Math.min(61, this.tools + 1)) > 60)
      ) {
        this.sink.note?.("rate_limited");
        throw new Error("Admission rejected");
      }
      await this.sink.record(category, correlation);
    };
    return {
      correlation,
      record,
      release,
      beginTool: async () => {
        pending++;
        try {
          await record("tool_started");
          if (closing) throw new Error("Admission rejected");
        } catch (error) {
          pending--;
          if (closing) release();
          throw error;
        }
        let finished = false;
        return async (outcome) => {
          if (finished) return;
          finished = true;
          try {
            await record(outcome);
          } finally {
            pending--;
            if (closing) release();
          }
        };
      },
    };
  }
}
export async function boundedBody(
  request: Request,
  timeoutMs = 5000,
): Promise<Request> {
  if (!request.body) return request;
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  let expired = false;
  const timer = setTimeout(() => {
    expired = true;
    void reader.cancel();
  }, timeoutMs);
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
    void reader.cancel().catch(() => {});
  }
}
/** Hold admission until the complete bounded response is consumed or cancelled. */
export function guardedResponse(
  response: Response,
  context: SecurityContext & { release(): void },
  timeoutMs = 30000,
): Response {
  if (!response.body) {
    context.release();
    return response;
  }
  const reader = response.body.getReader();
  let bytes = 0;
  let controller: ReadableStreamDefaultController<Uint8Array>;
  const timer = setTimeout(() => {
    void context.record("resource_rejected").catch(() => {});
    void reader.cancel().catch(() => {});
    context.release();
    controller.error(new Error("Response rejected"));
  }, timeoutMs);
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
          await context.record("resource_rejected");
          throw new Error("Response rejected");
        }
        controller.enqueue(item.value);
      } catch {
        clearTimeout(timer);
        context.release();
        void reader.cancel().catch(() => {});
        controller.error(new Error("Response rejected"));
      }
    },
    async cancel() {
      clearTimeout(timer);
      void reader.cancel().catch(() => {});
      context.release();
    },
  });
  const headers = new Headers(response.headers);
  headers.set("X-Request-ID", context.correlation);
  return new Response(body, { status: response.status, headers });
}
/** Bound SDK response creation too, including legacy dispatch that awaits a tool. */
export async function exchangeResponse(
  work: Promise<Response>,
  timeoutMs = 30000,
): Promise<Response> {
  let expired = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  void work.then(
    (response) => {
      if (expired) void response.body?.cancel().catch(() => {});
    },
    () => {},
  );
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      expired = true;
      reject(new Error("Response rejected"));
    }, timeoutMs);
  });
  try {
    return await Promise.race([work, deadline]);
  } finally {
    clearTimeout(timer);
  }
}
