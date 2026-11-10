import test from 'node:test';
import assert from 'node:assert/strict';
import {rmSync,statSync} from 'node:fs';
import {setTimeout as delay} from 'node:timers/promises';
import {DatabaseSync} from 'node:sqlite';
import {fixture} from './fixture.mjs';
import {runApprovedSources} from '../source_sequence.ts';
import {openOwnedStores} from '../runtime.ts';
import {sourceBoundOutbox} from '../private/source_outbox.ts';
import {SQLiteOutbox} from '../../../../src/agent-sdk/sqlite-outbox.ts';
import {AnswerIntents} from '../../../../src/answer-intents/answers.ts';
import {makeReplayBoundMessageId} from '../../../../src/messaging/contract.ts';
test('source view claims exact journal ID despite old due row and preserves real store brands/count/close',async t=>{
 const f=fixture();f.stores.budget.max_thread_replies=2;
 const owned=openOwnedStores(f.stores,f.options.policy,'recover',f.options.managedTransport);
 const {inbox,answer_intents:answers,budget}=owned.hostOptions;
 const raw=new SQLiteOutbox(f.stores.paths.actionOutbox,f.stores.actionOutbox);raw.migrate();let rawClosed=false;
 t.after(()=>{if(!rawClosed)raw.close();owned.closeAfterRelease();f.close();rmSync(f.dir,{recursive:true,force:true})});
 const keys=[];
 function save(n){const m={...f.message,message_id:makeReplayBoundMessageId(f.message.first_sent_at,String(n).repeat(32))},source={sender_id:'synthetic-peer',message_id:m.message_id};
  inbox.save({message:{...m,sender_id:source.sender_id},generation:1,lease_token:'z'.repeat(43),lease_until:new Date(Date.now()+60000).toISOString()});
  const ack=inbox.claimAck();inbox.confirmAck(ack,{recipient_id:m.recipient_id,sender_id:source.sender_id,message_id:m.message_id,request_id:ack.request_id,receipt_id:'ack-'+n,acked_at:new Date().toISOString(),state:'acked'});keys.push(source);return source;}
 const a=save(1),b=save(2),context={};
 const producer=new AnswerIntents(answers,inbox,raw,budget,f.stores.inbox.limits,(ctx,_op,source)=>ctx===context&&keys.some(k=>k.message_id===source.message_id)?{agent_id:f.options.policy.agentId,actor_id:f.options.policy.actorId}:undefined);
 const first=producer.prepare(context,a,{parts:[{type:'text',text:'first'}]});producer.enqueueOnce(context,a);await delay(5);
 const second=producer.prepare(context,b,{parts:[{type:'text',text:'second'}]});producer.enqueueOnce(context,b);
 const db=new DatabaseSync(f.stores.paths.actionOutbox,{readOnly:true});assert.equal(db.prepare("SELECT message_id FROM relay_outbox WHERE state='queued' ORDER BY next_retry_at,message_id").get().message_id,first.reply_id);db.close();
 let checks=0;const view=sourceBoundOutbox(raw,answers,b,()=>{checks++});assert.ok(view instanceof SQLiteOutbox);assert.equal(view.agentId,raw.agentId);
 assert.throws(()=>view.claim(first.reply_id),/source_outbox_wrong_reply/);
 const job=view.claim();assert.equal(job.message_id,second.reply_id);assert.equal(raw.get(first.reply_id).state,'queued');assert.equal(view.get(second.reply_id).state,'sending');assert.equal(view.retainedCounts(0).total,2);assert.ok(checks>0);
 // A source capability view cannot reset or bypass the shared thread budget.
 const third=save(3);producer.prepare(context,third,{parts:[{type:'text',text:'third'}]});
 assert.throws(()=>producer.enqueueOnce(context,third),/reply_thread_exhausted/);
 const budgetDb=new DatabaseSync(f.stores.paths.budget,{readOnly:true});try{assert.equal(budgetDb.prepare('SELECT count(*) n FROM reply_budget_reservations').get().n,2);}finally{budgetDb.close();}
 assert.equal(view.retainedCounts(0).total,2);assert.equal(producer.inspect(context,third).state,'prepared');
 view.close();rawClosed=true;assert.throws(()=>raw.get(first.reply_id));
});
test('two explicit sources share all store paths, budget and claims; restart requires settlement proof without model replay',async t=>{
 const f=fixture();t.after(()=>{f.close();rmSync(f.dir,{recursive:true,force:true})});
 const initial=structuredClone(f.message),secondId=makeReplayBoundMessageId(initial.first_sent_at,'2'.repeat(32));let secondFactories=0;
 function select(id){f.message.message_id=id;f.source.message_id=id;f.state.received=false;f.options.policy={...f.options.policy,source:{sender_id:f.source.sender_id,message_id:id}};return {...f.options};}
 const roots=[()=>select(initial.message_id),()=>{secondFactories++;return select(secondId)}];
 const allPaths=JSON.stringify(f.stores.paths),first=await runApprovedSources({roots});assert.equal(first.state,'completed_finite_sequence',JSON.stringify(first));assert.equal(first.results.length,2);
 assert.equal(f.state.creates,2);assert.equal(f.state.submits,2);assert.equal(JSON.stringify(f.stores.paths),allPaths);
 const ownerInode=statSync(f.stores.paths.owner).ino;
 for(const [file,table] of [[f.stores.paths.budget,'reply_budget_reservations'],[f.stores.paths.claims,'source_launch_claims'],[f.stores.paths.answers,'answer_intents'],[f.stores.paths.actionOutbox,'relay_outbox']]){
  const db=new DatabaseSync(file,{readOnly:true});assert.equal(db.prepare('SELECT count(*) n FROM '+table).get().n,2);db.close();}
 const before=secondFactories,blocked=await runApprovedSources({roots});assert.equal(blocked.state,'prior_native_settlement_unverified');assert.equal(secondFactories,before);assert.equal(f.state.creates,2);
 let proofs=0;const recovered=await runApprovedSources({roots,checkPreviousNativeSettled({source,launchId}){
  // Explicit TEST-only native settlement substitution; an ACK is not this evidence.
  assert.ok([initial.message_id,secondId].includes(source.message_id));assert.ok(first.results.some(r=>r.launchId===launchId));proofs++;
 }});
 assert.equal(recovered.state,'completed_finite_sequence');assert.equal(proofs,2);assert.equal(f.state.creates,2);assert.equal(f.state.submits,2);assert.equal(statSync(f.stores.paths.owner).ino,ownerInode);
 assert.deepEqual(recovered.results.map(r=>r.replyId),first.results.map(r=>r.replyId));
});
test('sequence rejects a fresh store recipe instead of resetting shared lineage',async t=>{
 const f=fixture();t.after(()=>{f.close();rmSync(f.dir,{recursive:true,force:true})});
 await assert.rejects(runApprovedSources({roots:[()=>f.options,()=>({...f.options,stores:{...f.stores}})]}),/source_sequence_shared_lineage_required/);
 assert.equal(f.state.creates,1);
});
test('unknown retained native source prevents second source; only owned process exit releases test locks',async()=>{
 const {spawn}=await import('node:child_process'),{mkdtempSync}=await import('node:fs'),{tmpdir}=await import('node:os'),{join}=await import('node:path'),{fileURLToPath}=await import('node:url');
 const dir=mkdtempSync(join(tmpdir(),'hab-sequence-unknown-'));let child,exited=false;
 try{
  child=spawn(process.execPath,[fileURLToPath(new URL('./sequence-unknown-child.mjs',import.meta.url)),dir],{stdio:['ignore','ignore','ignore','ipc'],env:{CLOUDFLARE_CF_FETCH_ENABLED:'false',WRANGLER_SEND_METRICS:'false',DO_NOT_TRACK:'1',TMPDIR:dir}});
  let result;child.on('message',value=>result=value);const timer=setTimeout(()=>child.kill('SIGKILL'),10000);
  const status=await new Promise(resolve=>child.once('exit',(code,signal)=>resolve({code,signal})));clearTimeout(timer);exited=true;
  assert.deepEqual(status,{code:0,signal:null});assert.equal(result.state,'stopped');assert.equal(result.first.state,'native_outcome_or_cleanup_unknown');
  assert.equal(result.first.retained,true);assert.equal(result.second,false);assert.equal(result.nativeChildExitObserved,true);
 }finally{if(!exited&&child){child.kill('SIGKILL');await new Promise(resolve=>child.once('exit',resolve));exited=true;}if(exited)rmSync(dir,{recursive:true,force:true});}
});
