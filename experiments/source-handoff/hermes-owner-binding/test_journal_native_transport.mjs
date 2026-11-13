/** Real disposable HMAC-backed journals/stores; explicitly synthetic native peers only. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { syntheticStores } from '../../../test/external-owner-fixture.js';
import { AnswerIntents } from '../../../src/answer-intents/answers.ts';
import { AdapterHostCycle } from '../../../src/adapter-host/cycle.ts';
import { journalNativeTransport } from './journal_native_transport.ts';
import { NativeHabStdioPort } from './native_stdio.ts';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
const deferred = () => { let resolve; const promise = new Promise(r => {resolve=r}); return {promise,resolve}; };
const tick = () => new Promise(r => setImmediate(r));
function fixture(t) {
  const dir=mkdtempSync(join(tmpdir(),'hab-native-scope-')), stores=syntheticStores(dir);
  t.after(()=>{stores.close();rmSync(dir,{recursive:true,force:true})});
  const {transport,...base}=stores.binding.hostOptions, source=Object.freeze({...stores.binding.source});
  const view={inbox:base.inbox,outbox:base.outbox,answers:base.answer_intents,source};
  const state={opened:[],closed:[],calls:[],closing:null,closeError:false,openError:false};
  const abort=new AbortController();
  const operation={signal:abort.signal,check(){if(abort.signal.aborted)throw Error('fixture_stopped')}};
  const options={client:{as_address:'worker@demo.hab',limits:base.limits,policy:{resource_url:'https://hab.example/mcp',agent_id:base.control.agentId,
    max_request_bytes:65536,max_response_bytes:131072,timeout_ms:5000,max_active_requests:1,max_sse_events:16,max_sse_lines:1000,max_json_depth:32,max_json_nodes:10000}},
    openPeer(scope){
      state.opened.push(scope);if(state.openError)throw Error('fixture_open_uncertain');
      return {version:1,resource_url:'https://hab.example/mcp',activeRequests:0,
        async callTool(name,args,control){control.check();state.calls.push([name,args]);
          const value=name==='hab_poll'?{delivery:null}:name==='hab_ack'?{...args,recipient_id:base.control.agentId,receipt_id:'fixture-ack',acked_at:new Date().toISOString(),state:'acked'}:{
            sender_id:base.control.agentId,message_id:args.message_id,recipient_id:source.sender_id,receipt_id:'fixture-receipt',accepted_at:new Date().toISOString(),
            expires_at:view.answers.get(source,()=>{}).expires_at,state:'pending'};
          return JSON.stringify({content:[{type:'text',text:JSON.stringify(value)}],structuredContent:value});},
        async close(){if(state.closing)await state.closing.promise;if(state.closeError)throw Error('fixture_close_uncertain');state.closed.push(scope);}};
    }};
  const factory=journalNativeTransport(options);
  const answers=new AnswerIntents(view.answers,base.inbox,base.outbox,base.budget,base.limits,()=>({agent_id:base.control.agentId,actor_id:'fixture-actor'}));
  const prepare=(enqueue=true)=>{
    const now=Date.now(),message={version:1,message_id:source.message_id,recipient_id:base.control.agentId,kind:'question',thread_id:'fixture-thread',
      in_reply_to:null,body:{parts:[{type:'text',text:'fixture only'}]},first_sent_at:new Date(now-100).toISOString(),expires_at:new Date(now+3599900).toISOString()};
    base.inbox.save({message:{...message,sender_id:source.sender_id},generation:1,lease_token:'a'.repeat(43),lease_until:new Date(now+30000).toISOString()});
    const ack=base.inbox.claimAck();base.inbox.confirmAck(ack,{recipient_id:base.control.agentId,...source,request_id:ack.request_id,receipt_id:'fixture-ack',acked_at:new Date().toISOString(),state:'acked'});
    const intent=answers.prepare({},source,{parts:[{type:'text',text:'fixture answer'}]});
    if(enqueue)answers.enqueueOnce({},source);
    return intent;
  };
  return {dir,stores,base,view,source,state,abort,operation,options,factory,prepare,transport:(stage='native')=>factory(operation,view,stage)};
}
test('receive can open before any answer ID exists and closes its exact owned peer',async t=>{
  const f=fixture(t),io=f.transport('receive');assert.equal(f.state.opened.length,0);
  assert.equal(await io.poll(),null);assert.deepEqual(f.state.opened,[{mode:'receive',agent_id:f.base.control.agentId,as_address:'worker@demo.hab'}]);
  assert.equal(f.state.closed.length,1);assert.equal(io.activeRequests,0);
});
test('submit derives the single reply ID only after real prepare/enqueue and uses confirmed source thread',async t=>{
  const f=fixture(t),io=f.transport();const intent=f.prepare(),job=f.base.outbox.claim(intent.reply_id);
  assert.equal(job.operation,'submit');await io.submit(job.message);
  assert.deepEqual(f.state.opened[0],{mode:'submit',agent_id:f.base.control.agentId,as_address:'worker@demo.hab',source_sender_id:f.source.sender_id,
    source_message_id:f.source.message_id,message_ids:[intent.reply_id],thread_id:'fixture-thread'});
  assert.ok(Object.isFrozen(f.state.opened[0])&&Object.isFrozen(f.state.opened[0].message_ids));assert.equal(f.state.closed.length,1);
});
test('unprepared, prepared-only, unclaimed and unrelated reply rows never open a peer',async t=>{
  const f=fixture(t),io=f.transport();assert.throws(()=>io.status('guess'));
  const intent=f.prepare(false);assert.throws(()=>io.status(intent.reply_id));
  assert.equal(f.state.opened.length,0);
});
test('unqueued ownership and corrupted journal data cannot become native policy',async t=>{
  const f=fixture(t),intent=f.prepare(),io=f.transport();
  assert.throws(()=>io.status(intent.reply_id)); // Queued is not the sender's leased job.
  f.base.outbox.claim(intent.reply_id);
  const raw=new DatabaseSync(join(f.dir,'answers.sqlite'));
  try{raw.exec("UPDATE answer_intents SET data=json_set(data,'$.source.thread_id','forged-thread')");}finally{raw.close();}
  assert.throws(()=>io.status(intent.reply_id));assert.equal(f.state.opened.length,0);
});
test('different source, thread, timestamp, recipient, agent and arbitrary reply cannot expand scope',async t=>{
  const f=fixture(t),intent=f.prepare(),job=f.base.outbox.claim(intent.reply_id),io=f.transport();
  for(const delta of [{thread_id:'other'},{recipient_id:'other'},{message_id:'other'},{in_reply_to:{...f.source,message_id:'other'}},{first_sent_at:'2000-01-01T00:00:00.000Z'}])
    assert.throws(()=>io.submit({...job.message,...delta}));
  const other=f.factory(f.operation,{...f.view,source:{...f.source,message_id:'other'}},'native');assert.throws(()=>other.status(intent.reply_id));
  assert.throws(()=>f.factory(f.operation,{...f.view,answers:{agentId:'other',get(){throw Error('must_not_read')}}},'native'));
  assert.equal(f.state.opened.length,0);
});
test('status recovery needs exact durable ID but neither released source body nor invented thread',async t=>{
  const f=fixture(t),intent=f.prepare(),job=f.base.outbox.claim(intent.reply_id);
  f.base.outbox.defer(job,true);await new Promise(r=>setTimeout(r,20));
  const status=f.base.outbox.claim(intent.reply_id);assert.equal(status.operation,'status');
  assert.equal(f.base.inbox.releaseBody(f.source.sender_id,f.source.message_id),true);
  const io=f.transport('recover');await io.status(intent.reply_id);
  assert.equal(f.state.opened[0].mode,'status');assert.equal('thread_id' in f.state.opened[0],false);
  assert.deepEqual(f.state.opened[0].message_ids,[intent.reply_id]);assert.equal(f.state.calls[0][0],'hab_status');
  assert.throws(()=>io.submit(job.message));assert.equal(f.state.opened.length,1);
});
test('receive and recovery stages cannot use each other operations',async t=>{
  const f=fixture(t),intent=f.prepare();f.base.outbox.claim(intent.reply_id);
  assert.throws(()=>f.transport('receive').status(intent.reply_id));assert.throws(()=>f.transport('recover').poll());
  assert.equal(f.state.opened.length,0);
});
test('owned peer close must settle before a result, idle admission or another open',async t=>{
  const f=fixture(t);f.state.closing=deferred();const io=f.transport('receive');let finished=false;
  const pending=io.poll().then(()=>{finished=true});await tick();assert.equal(io.activeRequests,1);assert.equal(finished,false);
  await assert.rejects(io.poll());assert.equal(f.state.opened.length,1);
  f.state.closing.resolve();await pending;assert.equal(io.activeRequests,0);
  f.state.closing=null;await io.poll();assert.equal(f.state.opened.length,2);
});
test('uncertain owned close permanently retains admission and prevents another peer',async t=>{
  const f=fixture(t);f.state.closeError=true;const io=f.transport('receive');await assert.rejects(io.poll());
  assert.equal(io.activeRequests,1);f.state.closeError=false;await assert.rejects(io.poll());assert.equal(f.state.opened.length,1);
});
test('uncertain opener retains admission; stopped operation never reaches opener',async t=>{
  const f=fixture(t);f.state.openError=true;const io=f.transport('receive');await assert.rejects(io.poll());assert.equal(io.activeRequests,1);
  f.abort.abort();assert.throws(()=>f.transport('receive').poll());assert.equal(f.state.opened.length,1);
});
test('pause while closing keeps admission until exit then refuses the stale result',async t=>{
  const f=fixture(t);f.state.closing=deferred();const io=f.transport('receive'),pending=io.poll();await tick();f.abort.abort();
  assert.equal(io.activeRequests,1);f.state.closing.resolve();await assert.rejects(pending);assert.equal(io.activeRequests,0);
});
test('actual managed host sends new journaled answer without predeclared IDs and releases only after close',async t=>{
  const f=fixture(t),intent=f.prepare(),context={};
  const host=new AdapterHostCycle({...f.base,authorization:c=>c===context?{agent_id:f.base.control.agentId,actor_id:'fixture-actor'}:undefined,
    managedTransport:operation=>f.factory(operation,f.view,'native')});
  host.setPaused(context,false,host.status(context).epoch);
  const result=await host.stepOnce(context,{op:'send'});assert.equal(result.state,'done');assert.equal(f.state.closed.length,1);
  assert.equal(f.base.outbox.get(intent.reply_id).state,'accepted');host.setPaused(context,true,host.status(context).epoch);host.releaseOwner(context);
});
test('actual owned Node/Python peers enforce late journal submit scope then body-free status-only scope',async t=>{
  const f=fixture(t),intent=f.prepare(),job=f.base.outbox.claim(intent.reply_id),ports=[];
  const make=journalNativeTransport({...f.options,openPeer(scope){
    const port=NativeHabStdioPort.start({command:'/usr/bin/python3',args:['-B',fileURLToPath(new URL('./fake_journal_scope_entry.py',import.meta.url))],
      cwd:fileURLToPath(new URL('.',import.meta.url)),env:{HAB_SYNTHETIC_SCOPE:JSON.stringify(scope),HAB_SYNTHETIC_EXPIRY:intent.expires_at},
      resource_url:'https://hab.example/mcp',max_frame_bytes:65536,shutdown_timeout_ms:200});
    ports.push(port);return port;
  }});
  t.after(async()=>{for(const port of ports)await port.close()});
  const submit=make(f.operation,f.view,'native');assert.equal((await submit.submit(job.message)).message_id,intent.reply_id);
  assert.equal(submit.activeRequests,0);assert.equal(ports[0].failed,true);
  f.base.outbox.defer(job,true);await new Promise(r=>setTimeout(r,20));assert.equal(f.base.outbox.claim(intent.reply_id).operation,'status');
  f.base.inbox.releaseBody(f.source.sender_id,f.source.message_id);
  const status=make(f.operation,f.view,'recover');assert.equal((await status.status(intent.reply_id)).message_id,intent.reply_id);
  assert.equal(status.activeRequests,0);assert.equal(ports.length,2);assert.equal(ports[1].failed,true);
});
