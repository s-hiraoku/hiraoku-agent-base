/** Private product-owned MCP transport. No credential extraction or native import.
 * Reuses HAB's existing sender/receiver request and receipt validation. The trusted
 * root must provide a per-command guard; main's fetch-only factory is NOT sufficient.
 */
import { HabMcpClient, type HabMcpClientOptions } from '../../../../src/hab/mcp-client.ts';
import { MessagingError } from '../../../../src/messaging/delivery-service.ts';
import { isPublicToolError } from '../../../../src/messaging/tool-errors.ts';

import type { ManagedOperation } from '../../../../src/adapter-host/cycle.ts';
export type NativeCallControl = ManagedOperation;
export type NativeTool = 'relay_poll' | 'relay_ack' | 'relay_submit' | 'relay_status';
export interface NativeRelayPort {
  readonly version: 1;
  readonly resource_url: string;
  readonly activeRequests: number;
  callTool(name: NativeTool, args: Readonly<Record<string, unknown>>, control: NativeCallControl): Promise<string>;
}
const failure = () => new MessagingError('relay_transport_failed');
function bounded(raw: string, max: number, depthLimit: number, nodeLimit: number): unknown {
  if (typeof raw !== 'string' || Buffer.byteLength(raw) > max) throw failure();
  const value: unknown = JSON.parse(raw), pending = [{value, depth: 1}]; let nodes = 0;
  while (pending.length) {
    const {value: v, depth} = pending.pop()!;
    if (++nodes > nodeLimit || depth > depthLimit || (typeof v === 'number' && !Number.isFinite(v))) throw failure();
    if (v && typeof v === 'object') {
      const values = Object.values(v); if (values.length + pending.length + nodes > nodeLimit) throw failure();
      pending.push(...values.map(value => ({value, depth:depth + 1})));
    }
  }
  return value;
}
function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object' || Array.isArray(a) !== Array.isArray(b)) return false;
  const l = a as Record<string, unknown>, r = b as Record<string, unknown>;
  const keys = Object.keys(l); return keys.length === Object.keys(r).length && keys.every(k => Object.hasOwn(r,k) && same(l[k],r[k]));
}
export class NativeHabMcpClient extends HabMcpClient {
  readonly #port: NativeRelayPort;
  readonly #options: HabMcpClientOptions;
  readonly #control: NativeCallControl;
  #active = 0;
  constructor(port: NativeRelayPort, options: Omit<HabMcpClientOptions,'authorization'|'fetch'> & {as_address: string}, control: NativeCallControl) {
    super(options);
    if (port?.version !== 1 || port.resource_url !== options.policy.resource_url || typeof port.callTool !== 'function' ||
      port.activeRequests !== 0 || options.policy.max_active_requests !== 1 || !options.as_address ||
      !(control?.signal instanceof AbortSignal) || control.signal.aborted || typeof control.check !== 'function') throw failure();
    this.#port = port;
    this.#options = { ...options, policy: Object.freeze({...options.policy}), limits: Object.freeze({...options.limits}) };
    this.#control = Object.freeze({signal: control.signal, check: control.check});
    this.#control.check();
  }
  override get activeRequests() {
    const value = this.#port.activeRequests;
    if (!Number.isSafeInteger(value) || value < 0) throw failure();
    return Math.max(value, this.#active);
  }
  protected override async requestTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    if (!['relay_poll','relay_ack','relay_submit','relay_status'].includes(name)) throw new MessagingError('forbidden');
    if (this.activeRequests) throw new MessagingError('relay_client_busy');
    const policy = this.#options.policy, controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, this.#control.signal]);
    const check = () => {
      if (signal.aborted || this.#port.resource_url !== policy.resource_url) throw failure();
      this.#control.check();
    };
    check();
    const input = Object.freeze({...structuredClone(args), as_address: this.#options.as_address, expected_agent_id: this.agentId});
    if (Buffer.byteLength(JSON.stringify(input)) > policy.max_request_bytes) throw failure();
    this.#active++;
    const work = Promise.resolve().then(() => { check(); return this.#port.callTool(name as NativeTool, input, {signal, check}); })
      .finally(() => {this.#active--;});
    let timer: ReturnType<typeof setTimeout> | undefined;
    let aborted: (() => void) | undefined;
    try {
      const text = await Promise.race([work, new Promise<never>((_, reject) => {
        aborted = () => reject(failure()); signal.addEventListener('abort', aborted, {once:true});
        if (signal.aborted) aborted();
        timer = setTimeout(() => controller.abort(), policy.timeout_ms);
      })]);
      check();
      const result = bounded(text, policy.max_response_bytes, policy.max_json_depth, policy.max_json_nodes) as Record<string, unknown>;
      if (!result || typeof result !== 'object' || Array.isArray(result) ||
        Object.keys(result).some(k => !['resultType','_meta','content','structuredContent','isError'].includes(k)) ||
        (result.resultType !== undefined && result.resultType !== 'complete') ||
        (result.isError !== undefined && typeof result.isError !== 'boolean') ||
        !Array.isArray(result.content) || result.content.length !== 1) throw failure();
      const item = result.content[0];
      if (!item || Object.keys(item).length !== 2 || item.type !== 'text' || typeof item.text !== 'string') throw failure();
      const content = bounded(item.text, policy.max_response_bytes, policy.max_json_depth, policy.max_json_nodes);
      if (!content || typeof content !== 'object' || Array.isArray(content) || !same(content,result.structuredContent)) throw failure();
      if (result.isError) {
        const error = content as Record<string, unknown>;
        if (Object.keys(error).length !== 1 || typeof error.error !== 'string' || !isPublicToolError(error.error)) throw failure();
        throw new MessagingError(error.error);
      }
      return content;
    } catch (error) {
      if (error instanceof MessagingError && isPublicToolError(error.code)) throw error;
      throw failure();
    } finally {
      if (timer) clearTimeout(timer);
      if (aborted) signal.removeEventListener('abort',aborted);
      controller.abort();
    }
  }
}
