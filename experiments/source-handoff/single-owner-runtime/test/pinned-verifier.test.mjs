/** Unit substitution for pinned module lifecycle, not native verification. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync,rmSync,realpathSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {selectionFixture} from './control-fixture.mjs';
import {prepareNativeDeployment} from '../private/native_deployment.ts';
import {fixedWakePolicy,fixedWakeText} from '../private/fixed_wake_policy.ts';
const hash=p=>createHash('sha256').update(readFileSync(p)).digest('hex');
function fixture(t){
 const dir=realpathSync(mkdtempSync(join(tmpdir(),'hab-pinned-composed-')));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const scope={domain_id:'synthetic',account_uid:process.getuid(),audience:'all-effective-selected-profile-viewers-and-host-operators',native_privilege:'interactive-profile-operator',
 create_effects:['durable-session','profile-config-and-secrets','eager-mcp-discovery','native-hooks-and-inventory','possible-background-update-check'],platform_trust:'same-user-host-operators-and-macos-system-runtime',expires_at_ms:Date.now()+120000};
 const paths=Object.fromEntries(['interpreter','native_entry.py','driver.mjs','owner.mjs','manifest.json'].map(k=>[k,join(dir,k)]));
 writeFileSync(paths.interpreter,'SYNTHETIC NEVER EXECUTED');writeFileSync(paths['native_entry.py'],'# SYNTHETIC NEVER EXECUTED\n');
 writeFileSync(paths['driver.mjs'],`export function createAcpOwnerDriver(o){let checked=false,woken=false;return {ownerSignal:o.scopeSignal,exited:Promise.resolve({code:0}),
 async create(l){return {launch:l}},async verifyCommitted(r,l){const b=await o.verifyDeployment({sessionId:'synthetic-correlation',launch:l});checked=true;return b},
 async wake(){if(!checked||woken||!o.fixedWake.text.includes('Authorized source key'))throw Error('invalid');woken=true;return {stopReason:'end_turn'}},async close(){}}}`);
 writeFileSync(paths['owner.mjs'],`export async function startExternalOwner(o){const launch={generation:{},signal:o.ownerSignal,mcp:{name:o.serverName,type:'http',url:'http://127.0.0.1:1/mcp',headers:{Authorization:'Bearer '+o.bearerToken}}};
 const r=await o.driver.create(launch),b=await o.driver.verifyCommitted(r,launch);let finish;const completion=new Promise(r=>finish=r);o.ownerSignal.addEventListener('abort',finish,{once:true});
 const c=b.hostOptions.control;await o.onBound({signal:o.ownerSignal,status:()=>({paused:c.snapshot().paused,owner:'held',epoch:0,running:false,draining:0}),updatePermission:()=>({epoch:0}),resume:()=>c.resume()});
 return {ready:Promise.resolve({phase:'bound'}),completion,async stop(){await o.driver.close();await o.closeStores();finish()}}}`);
 const source={sender_id:'synthetic-peer',message_id:'synthetic-question'},claim={source,launch_id:'sl_'+'a'.repeat(32),claimed_at:Date.now()};
 let paused=true,closed=false,activations=0;const stop=new AbortController();
 const stores=Object.fromEntries(['owner','control','inbox','outbox','budget','answer_intents'].map(k=>[k,{agentId:'synthetic-recipient'}]));
 stores.control.snapshot=()=>({paused});stores.control.resume=()=>{paused=false};stores.inbox.withEntry=(sender,id,fn)=>fn({sender_id:sender,receipt_confirmed:true,message:{message_id:id,recipient_id:'synthetic-recipient',kind:'question',in_reply_to:null,body:{parts:[{type:'text',text:'untrusted'}]}}});
 const policy={account_uid:process.getuid(),agent_id:'synthetic-recipient',actor_id:'synthetic-root',source,audience:scope.audience,operations:['receive','send','inbox_read','answer_prepare','answer_inspect','answer_enqueue'],expires_at_ms:scope.expires_at_ms};
 const trusted={profileHome:'/fake/root/profiles/synthetic-profile',scope,scopeSignal:stop.signal,localOwner:{hostOptions:{...stores,transport:()=>{throw Error('no network')}},policy},bearerToken:'synthetic_no_real_credential_12345678901234567890',serverName:'synthetic',closeStores(){closed=true},fixedWake:{claim,activate(c){activations++;const enabled=c.updatePermission(c.status().epoch,true);c.resume(enabled.epoch)}}};
 const node=realpathSync(process.execPath),m={format:1,interpreter:paths.interpreter,entry:paths['native_entry.py'],driver:paths['driver.mjs'],owner:paths['owner.mjs'],parent_interpreter:node,
 files:Object.fromEntries([paths.interpreter,paths['native_entry.py']].map(p=>[p,hash(p)])),parent_files:Object.fromEntries([node,paths['driver.mjs'],paths['owner.mjs']].map(p=>[p,hash(p)])),dynamic_links:{},absent_paths:[],lifetime_seconds:60,selection:selectionFixture(scope),hab:{agent_id:policy.agent_id,actor_id:policy.actor_id,...source},wake_policy:fixedWakePolicy(claim)};
 const save=()=>{writeFileSync(paths['manifest.json'],JSON.stringify(m));return {manifestPath:paths['manifest.json'],manifestSha256:hash(paths['manifest.json']),trusted}};
 return {m,trusted,save,stop,state:()=>({paused,closed,activations})};
}
test('pinned composition actually configures fixed wake and permits only post-bind active phase',async t=>{
 const f=fixture(t),prepared=prepareNativeDeployment(f.save());const run=await prepared.start();await run.owner.ready;
 assert.deepEqual(run.wakeResult(),{stopReason:'end_turn'});assert.equal(f.state().activations,1);assert.equal(f.state().paused,false);
 await delay(320);assert.equal(f.stop.signal.aborted,false);prepared.check();await run.owner.stop();await run.owner.completion;assert.equal(f.state().closed,true);
});
test('old create-only manifest, wrong claim, or missing local activation is rejected',t=>{
 for(const mutate of [f=>delete f.m.wake_policy,f=>{f.m.wake_policy={...f.m.wake_policy,input_id:'wrong'}},f=>delete f.trusted.fixedWake,
 f=>{f.trusted.fixedWake={...f.trusted.fixedWake,activate:null}},f=>{f.m.hab.message_id='wrong-source'}]){
 const f=fixture(t);mutate(f);assert.throws(()=>prepareNativeDeployment(f.save()));}
});
