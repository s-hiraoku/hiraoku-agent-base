/** Private root composition. Durable routing policy, not authentication or a wire API. */
import type { ManagedOperation, HostTransport } from '../../../src/adapter-host/cycle.ts';
import type { SQLiteAnswerJournal } from '../../../src/answer-intents/sqlite-journal.ts';
import type { SQLiteInbox } from '../../../src/agent-sdk/sqlite-inbox.ts';
import type { SQLiteOutbox } from '../../../src/agent-sdk/sqlite-outbox.ts';
import type { Submission } from '../../../src/messaging/contract.ts';
import { NativeHabMcpClient, type NativeHabPort } from './native_mcp_client.ts';

type Key = Readonly<{ sender_id: string; message_id: string }>;
export type JournalNativeStores = Readonly<{
  inbox: Pick<SQLiteInbox, 'agentId' | 'withEntry'>;
  outbox: Pick<SQLiteOutbox, 'agentId' | 'get'>;
  answers: Pick<SQLiteAnswerJournal, 'agentId' | 'get'>;
  source: Key;
}>;
type Identity = Readonly<{ agent_id: string; as_address: string }>;
type Reply = Identity & Readonly<{
  source_sender_id: string; source_message_id: string; message_ids: readonly [string];
}>;
export type NativePeerScope =
  | (Identity & Readonly<{ mode: 'receive' }>)
  | (Reply & Readonly<{ mode: 'submit'; thread_id: string }>)
  | (Reply & Readonly<{ mode: 'status' }>);
export interface OwnedNativePeer extends NativeHabPort {
  /** Must resolve only after actual owned process exit. Rejection is not settlement. */
  close(): Promise<void>;
}
export type JournalNativeOptions = Readonly<{
  client: ConstructorParameters<typeof NativeHabMcpClient>[1];
  /** Trusted synchronous root opener, normally NativeHabStdioPort.start.
   * Scope is derived here, never from an MCP argument or guessed latest row.
   * A thrown opener has uncertain side effects and permanently retains admission.
   */
  openPeer(scope: NativePeerScope, operation: ManagedOperation): OwnedNativePeer;
}>;
function must(value: unknown): asserts value { if (!value) throw Error('native_journal_scope_refused'); }
const exact = (a: Key | null | undefined, b: Key) => a?.sender_id === b.sender_id && a.message_id === b.message_id;
const id = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(v);

/** No IO at factory construction. The owning host supplies current store handles. */
export function journalNativeTransport(options: JournalNativeOptions) {
  const clientOptions = Object.freeze({ ...options.client,
    limits: Object.freeze({ ...options.client.limits }), policy: Object.freeze({ ...options.client.policy }) });
  const openPeer = options.openPeer;
  must(typeof openPeer === 'function');
  return (operation: ManagedOperation, stores: JournalNativeStores, stage: 'receive' | 'native' | 'recover'): HostTransport => {
    must(['receive', 'native', 'recover'].includes(stage));
    const source = Object.freeze({ ...stores.source });
    const agentId = clientOptions.policy.agent_id;
    must(id(source.sender_id) && id(source.message_id));
    must([stores.inbox, stores.outbox, stores.answers].every(s => s.agentId === agentId));
    const journalGet = stores.answers.get.bind(stores.answers), outboxGet = stores.outbox.get.bind(stores.outbox);
    const inboxEntry = stores.inbox.withEntry.bind(stores.inbox);
    const check = () => {
      must(!operation.signal.aborted && exact(stores.source, source));
      must([stores.inbox, stores.outbox, stores.answers].every(s => s.agentId === agentId));
      operation.check();
      must(!operation.signal.aborted);
    };
    const control = Object.freeze({ signal: operation.signal, check });
    const identity = Object.freeze({ agent_id: agentId, as_address: clientOptions.as_address });
    let active = 0;
    // Strong references are kept when opening/cleanup has an uncertain outcome.
    let retained: OwnedNativePeer | undefined;
    const replyScope = (messageId: string, message?: Submission): NativePeerScope => {
      check();
      must(stage !== 'receive');
      const intent = journalGet(source, check);
      must(intent && exact(intent.source, source) && intent.state === 'enqueued' && intent.reply_id === messageId);
      const record = outboxGet(intent.reply_id);
      check();
      must(record.message_id === intent.reply_id && record.recipient_id === source.sender_id && record.expires_at === intent.expires_at);
      // get() exposes sending state, not lease expiry/fence. Current authority is
      // the owner's operation.check; DurableSender separately fences local commits.
      must(record.state === 'sending');
      const reply = { ...identity, source_sender_id: source.sender_id, source_message_id: source.message_id,
        message_ids: Object.freeze([intent.reply_id]) as readonly [string] };
      if (!message) return Object.freeze({ ...reply, mode: 'status' as const });
      must(message.version === 1 && message.kind === 'answer' && message.message_id === intent.reply_id
        && message.recipient_id === source.sender_id && exact(message.in_reply_to, source)
        && message.first_sent_at === intent.first_sent_at && message.expires_at === intent.expires_at);
      const thread = inboxEntry(source.sender_id, source.message_id, entry => {
        check();
        must(entry.receipt_confirmed === true && entry.sender_id === source.sender_id
          && entry.message.message_id === source.message_id && entry.message.recipient_id === agentId
          && entry.message.kind === 'question' && entry.message.thread_id === message.thread_id);
        return entry.message.thread_id;
      });
      must(id(thread)); check();
      return Object.freeze({ ...reply, mode: 'submit' as const, thread_id: thread });
    };
    const run = async <T>(scope: NativePeerScope, call: (client: NativeHabMcpClient) => Promise<T>): Promise<T> => {
      must(active === 0); check();
      active = 1;
      // Opener failure cannot prove that no owned child was started. Fail closed.
      retained = openPeer(scope, control);
      let result: T;
      try {
        must(retained && typeof retained.close === 'function');
        check();
        result = await call(new NativeHabMcpClient(retained, clientOptions, control));
      } finally {
        await retained.close();
        // A successful close is the root opener's proof of actual owned exit.
        active = 0;
        retained = undefined;
      }
      check();
      return result;
    };
    const receiving = () => { check(); must(stage !== 'recover'); return Object.freeze({ ...identity, mode: 'receive' as const }); };
    return Object.freeze({
      agentId,
      get activeRequests() { return active; },
      poll: () => run(receiving(), c => c.poll()),
      ack: (request: Parameters<HostTransport['ack']>[0]) => run(receiving(), c => c.ack(request)),
      submit: (message: Submission) => {
        const snapshot = structuredClone(message);
        return run(replyScope(snapshot.message_id, snapshot), c => c.submit(snapshot));
      },
      status: (messageId: string) => run(replyScope(messageId), c => c.status(messageId)),
    });
  };
}
