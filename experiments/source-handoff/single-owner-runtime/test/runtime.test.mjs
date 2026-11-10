import test from 'node:test';
import assert from 'node:assert/strict';
import {statSync,rmSync,readFileSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {fixture} from './fixture.mjs';
import {openOwnedStores,runOneSource} from '../runtime.ts';
for(const mode of ['normal','prepared','enqueued'])test(`single owner ${mode}: receive save ACK claim ACP MCP answer saved ACK`,async t=>{
 const f=fixture(mode);t.after(()=>{f.close();rmSync(f.dir,{recursive:true,force:true});});
 const r=await f.run();assert.equal(r.state,'reply_receipt_saved');assert.equal(r.nativeStopReason,'end_turn');assert.equal(r.delivery,'acked');
 assert.equal(f.state.creates,1);assert.equal(f.state.submits,1);assert.equal(f.state.acks,1);assert.equal(r.retained,false);
 const traces=f.readTrace();assert.ok(traces.some(x=>x.savedBeforeAck));assert.ok(traces.some(x=>x.prebindDenied));
 assert.equal(traces.filter(x=>x.method==='session/new').length,1);assert.equal(traces.filter(x=>x.method==='session/prompt').length,1);
 assert.equal(traces.find(x=>x.replyId).replyId,r.replyId);
 for(const tool of ['recipient_inbox_read','recipient_answer_prepare','recipient_answer_inspect'])assert.ok(traces.some(x=>x.tool===tool));
 const inode=statSync(f.stores.paths.owner).ino;
 const again=await f.run();assert.equal(again.state,'reply_receipt_saved');assert.equal(again.replyId,r.replyId);assert.equal(again.launchId,r.launchId);
 assert.equal(again.nativeStarted,false);assert.equal(f.state.creates,1);assert.equal(f.state.submits,1);assert.equal(statSync(f.stores.paths.owner).ino,inode);
 const db=new DatabaseSync(f.stores.paths.budget,{readOnly:true});assert.equal(db.prepare('SELECT count(*) n FROM reply_budget_reservations').get().n,1);db.close();
 f.peer.withEntry('synthetic-recipient',r.replyId,e=>assert.equal(e.receipt_confirmed,true));
});
test('missing ACK confirmation never claims or creates',async t=>{
 const f=fixture();t.after(()=>{f.close();rmSync(f.dir,{recursive:true,force:true});});f.state.failAck=true;
 const r=await f.run();assert.equal(r.state,'blocked');assert.equal(f.state.creates,0);
 const db=new DatabaseSync(f.stores.paths.claims,{readOnly:true});assert.equal(db.prepare('SELECT count(*) n FROM source_launch_claims').get().n,0);db.close();
});
test('same owner DB prevents second host; no alternate owner used',async t=>{
 const f=fixture();t.after(()=>{f.close();rmSync(f.dir,{recursive:true,force:true});});
 const first=openOwnedStores(f.stores,f.options.policy,'receive',f.options.managedTransport);
 assert.throws(()=>openOwnedStores(f.stores,f.options.policy,'receive',f.options.managedTransport));
 // No host/work ever attached here, so this is only factory setup teardown.
 first.closeAfterRelease();
});
test('same inode aliases rejected before acquisition',async t=>{
 const f=fixture();t.after(()=>{f.close();rmSync(f.dir,{recursive:true,force:true});});
 const patched={...f.stores,paths:{...f.stores.paths,actionOutbox:f.stores.paths.receiveOutbox}};
 assert.throws(()=>openOwnedStores(patched,f.options.policy,'receive',f.options.managedTransport),/distinct_store_paths/);
});
test('receipt-confirmed noninitial source cannot become native work',async t=>{
 const f=fixture();t.after(()=>{f.close();rmSync(f.dir,{recursive:true,force:true});});
 f.message.in_reply_to={sender_id:'synthetic-recipient',message_id:'synthetic-previous'};
 const r=await f.run();assert.equal(r.state,'blocked');assert.equal(f.state.creates,0);
});
test('original receive-only supervisor resumes with same stores after finite answer path',async t=>{
 const {continueReceiving}=await import('../runtime.ts');
 const f=fixture();t.after(()=>{f.close();rmSync(f.dir,{recursive:true,force:true});});
 assert.equal((await f.run()).state,'reply_receipt_saved');
 f.options.receiverContinuation={lifetimeMs:20,policy:{interval_ms:1000,retry_base_ms:1000,retry_cap_ms:1000,drain_timeout_ms:1000}};
 const result=await continueReceiving(f.options);assert.equal(result.drained,true);assert.equal(result.receive_steps,1);assert.equal(result.retained,false);assert.equal(f.state.creates,1);
});
