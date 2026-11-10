/** Private root orchestration, not a new HAB API or authentication authority.
 * Real stores/host/claim/owner/ACP remain the production classes. No default live inputs.
 */
import { lstatSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { SQLiteHostOwner } from '../../../src/adapter-host/sqlite-owner.ts';
import { SQLiteHostControl } from '../../../src/adapter-host/sqlite-control.ts';
import { SQLiteInbox } from '../../../src/agent-sdk/sqlite-inbox.ts';
import { SQLiteOutbox } from '../../../src/agent-sdk/sqlite-outbox.ts';
import { SQLiteReplyBudget } from '../../../src/adapter-policy/sqlite-reply-budget.ts';
import { SQLiteAnswerJournal } from '../../../src/answer-intents/sqlite-journal.ts';
import { SQLiteSourceLaunchJournal, type SourceLaunchRecord } from '../../../src/owner-integrations/source-launch-journal.ts';
import { AdapterHostCycle, type ManagedOperation, type HostTransport, type HostOperation } from '../../../src/adapter-host/cycle.ts';
import { startExternalOwner, type ExternalOwnerControls, type VerifiedOwnerBinding } from '../../../src/adapter-host/external-owner.ts';
import { createAcpOwnerDriver, type AcpOwnerOptions } from '../../../src/owner-integrations/acp-stdio.ts';
import { sourceBoundOutbox } from './private/source_outbox.ts';
import { ReceiveSupervisor, type ReceiveSupervisorPolicy } from '../../../src/adapter-host/receive-supervisor.ts';
import { fixedWakePolicy, fixedWakeText } from './private/fixed_wake_policy.ts';

type Options<T> = T extends new(path:string, options:infer O)=>unknown ? O : never;
type Key = Readonly<{sender_id:string;message_id:string}>;
export type Stage = 'receive' | 'native' | 'recover';
export type NativeStoreView = Readonly<{inbox:SQLiteInbox;outbox:SQLiteOutbox;answers:SQLiteAnswerJournal;source:Key}>;
export type StoreRecipe = {
  paths: Readonly<Record<'owner'|'control'|'inbox'|'budget'|'receiveOutbox'|'actionOutbox'|'answers'|'claims',string>>;
  owner: Options<typeof SQLiteHostOwner>; control: Options<typeof SQLiteHostControl>;
  inbox: Options<typeof SQLiteInbox>; budget: Options<typeof SQLiteReplyBudget>;
  receiveOutbox: Options<typeof SQLiteOutbox>; actionOutbox: Options<typeof SQLiteOutbox>;
  answers: Options<typeof SQLiteAnswerJournal>;
  claims: Pick<Options<typeof SQLiteSourceLaunchJournal>,'agent_id'|'policy_id'|'fingerprint_key'|'limits'|'max_records'>;
};
export type RootPolicy = Readonly<{
  agentId:string; actorId:string; source:Key; authorityEpoch:string;
  /** Trusted LOCAL current authorizer. JSON flags, remote text, and registry rows cannot supply this. */
  check(action:'acquire'|'receive'|'handoff'|'activate'|'recover'):void;
}>;
export type OwnerRun = {owner:Awaited<ReturnType<typeof startExternalOwner>>; exited:Promise<unknown>;
  wakeResult():Readonly<{stopReason:string}>|null};
export type RuntimeOptions = {
  stores:StoreRecipe; policy:RootPolicy; signal:AbortSignal;
  managedTransport(operation:ManagedOperation, stores:NativeStoreView, stage:Stage):HostTransport;
  /** Optional finite receive-only continuation, preserving the preexisting receiver role. */
  receiverContinuation?:Readonly<{lifetimeMs:number;policy:ReceiveSupervisorPolicy}>;
  /** Native launch is deliberately delayed until the source journal committed a NEW claim.
   * The real implementation must use prepareNativeDeployment, not synthetic contexts.
   */
  launch(input:{claim:SourceLaunchRecord;stores:OwnedStores;activate(controls:ExternalOwnerControls):void}):Promise<OwnerRun>;
  receiveSteps:number; reconcileSteps:number; intervalMs:number; drainMs:number;
};
// Strong ownership references survive an unknown return; no GC-based lock/store release.
const retainedRuns=new Map<string,{stores:OwnedStores;native?:OwnerRun;host?:AdapterHostCycle}>();
export const retainedCount=()=>retainedRuns.size;
function must(v:unknown, reason:string):asserts v {if(!v)throw Error(reason);}
function exact(a:Key,b:Key){return a.sender_id===b.sender_id&&a.message_id===b.message_id;}
function recipeCheck(r:StoreRecipe,p:RootPolicy){
  const paths=Object.values(r.paths);must(paths.length===8&&new Set(paths).size===8,'distinct_store_paths_required');
  const files=new Set<string>();
  for(const path of paths){
    must(isAbsolute(path)&&realpathSync(dirname(path))===dirname(path),'canonical_private_store_parent_required');
    const parent=lstatSync(dirname(path));must(parent.isDirectory()&&!(parent.mode&0o077),'private_store_parent_required');
    const st=lstatSync(path,{throwIfNoEntry:false});if(st){must(st.isFile()&&!st.isSymbolicLink()&&st.nlink===1&&!(st.mode&0o077),'private_regular_store_required');
      const identity=`${st.dev}:${st.ino}`;must(!files.has(identity),'distinct_store_inodes_required');files.add(identity);}
  }
  for(const o of [r.owner,r.control,r.inbox,r.budget,r.receiveOutbox,r.actionOutbox,r.answers,r.claims])must(o.agent_id===p.agentId,'store_identity_mismatch');
}
/** A fresh owner handle is acquired BEFORE business DBs are opened. One handle attaches once. */
export function openOwnedStores(r:StoreRecipe,p:RootPolicy,stage:Stage,transport:RuntimeOptions['managedTransport']){
  recipeCheck(r,p);p.check('acquire');
  const all:{close():void}[]=[];let closed=false,claimJournal:SQLiteSourceLaunchJournal|undefined;
  try{
    const owner=new SQLiteHostOwner(r.paths.owner,r.owner);all.push(owner);owner.migrate();owner.acquire(()=>p.check('acquire'));
    const control=new SQLiteHostControl(r.paths.control,r.control);all.push(control);control.migrate();
    const inbox=new SQLiteInbox(r.paths.inbox,r.inbox);all.push(inbox);inbox.migrate();
    const budget=new SQLiteReplyBudget(r.paths.budget,r.budget);all.push(budget);budget.migrate();
    const outbox=new SQLiteOutbox(stage==='receive'?r.paths.receiveOutbox:r.paths.actionOutbox,stage==='receive'?r.receiveOutbox:r.actionOutbox);all.push(outbox);outbox.migrate();
    const answers=new SQLiteAnswerJournal(r.paths.answers,r.answers);all.push(answers);answers.migrate();
    const scopedOutbox=stage==='receive'?outbox:sourceBoundOutbox(outbox,answers,p.source,()=>p.check(stage==='native'?'activate':'recover'));
    const view=Object.freeze({inbox,outbox:scopedOutbox,answers,source:Object.freeze({...p.source})});
    const hostOptions={owner,control,inbox,budget,outbox:scopedOutbox,answer_intents:answers,limits:r.inbox.limits,managedTransport:(operation:ManagedOperation):HostTransport=>{
      const client=transport(operation,view,stage);
      const checkedReply=(messageId:string)=>{
        operation.check();must(stage!=='receive','receive_transport_cannot_send');
        const intent=answers.get(view.source,operation.check);must(intent&&intent.reply_id===messageId,'exact_saved_reply_required');
        const record=outbox.get(messageId);must(record.recipient_id===view.source.sender_id&&record.expires_at===intent.expires_at,'saved_reply_route_mismatch');
        operation.check();return intent;
      };
      return {agentId:client.agentId,get activeRequests(){return client.activeRequests},poll:()=>client.poll(),ack:request=>client.ack(request),
        submit:async message=>{checkedReply(message.message_id);must(message.kind==='answer'&&message.in_reply_to&&exact(message.in_reply_to,view.source),'exact_reply_source_required');
          return client.submit(message);},status:async messageId=>{checkedReply(messageId);return client.status(messageId);}};
    }};
    const close=()=>{if(closed)return;claimJournal?.close();for(const item of all.toReversed())item.close();closed=true;};
    return {hostOptions,stage,get closed(){return closed;},
      // Only call after host release and known transport/native settlement. No no-op cleanup.
      closeAfterRelease:close,
      claims(checkOwner:()=>void){
        must(!closed&&!claimJournal,'claim_handle_already_open');
        claimJournal=new SQLiteSourceLaunchJournal(r.paths.claims,{...r.claims,inbox,checkOwner,
          authorization:(context,_op,source)=>{
            p.check('handoff');return context===p&&exact(source,p.source)?{agent_id:p.agentId,actor_id:p.actorId,authority_epoch:p.authorityEpoch}:undefined;
          }});claimJournal.migrate();return claimJournal;
      }};
  }catch(error){for(const item of all.toReversed())item.close();throw error;}
}
export type OwnedStores=ReturnType<typeof openOwnedStores>;
function rootHost(s:OwnedStores,p:RootPolicy,stage:'receive'|'recover'){
  const ops:HostOperation[]=stage==='receive'?['receive','inbox']:['answer_inspect','answer_enqueue','send'];
  return new AdapterHostCycle({...s.hostOptions,authorization:(context,operation,source)=>{
    if(context!==p)return undefined;
    if(!['status','control','release_owner'].includes(operation)){
      if(!ops.includes(operation))return undefined;p.check(stage==='receive'?'receive':'recover');
      if(source&&!exact(source,p.source))return undefined;
    }
    return {agent_id:p.agentId,actor_id:p.actorId};
  }});
}
async function stopHost(host:AdapterHostCycle,p:RootPolicy,s:OwnedStores,ms:number){
  host.setPaused(p,true,host.status(p).epoch);const end=performance.now()+ms;
  while(host.status(p).running||host.status(p).draining){must(performance.now()<end,'host_drain_unknown');await delay(5);}
  host.releaseOwner(p);s.closeAfterRelease();
}
function resume(host:AdapterHostCycle,p:RootPolicy,action:'receive'|'recover'){
  p.check(action);const state=host.status(p);must(state.owner==='held'&&!state.running&&!state.draining,'owner_not_idle');
  host.setPaused(p,false,state.epoch);
}
function assertBounds(o:RuntimeOptions){
  for(const [value,max] of [[o.receiveSteps,100],[o.reconcileSteps,100],[o.intervalMs,60000],[o.drainMs,60000]])must(Number.isSafeInteger(value)&&value>=1&&value<=max,'invalid_runtime_bound');
  must(!o.signal.aborted&&typeof o.launch==='function','runtime_unavailable');
}
/** One approved exact-source finite automatic path. Repeated calls keep the SAME store recipe.
 * An existing claim NEVER invokes launch, even when native outcome is unknown.
 */
export async function runOneSource(o:RuntimeOptions){
  assertBounds(o);must(!retainedRuns.has(o.stores.paths.owner),'retained_owner_requires_recovery');const original=o.policy;const p=Object.freeze({...original,source:Object.freeze({...original.source}),check(action:Parameters<RootPolicy['check']>[0]){
    must(original.agentId===p.agentId&&original.actorId===p.actorId&&original.authorityEpoch===p.authorityEpoch&&exact(original.source,p.source),'root_policy_changed');original.check(action);
  }});let active:OwnedStores|undefined,host:AdapterHostCycle|undefined;
  let claim:SourceLaunchRecord|undefined,newly=false;
  try{
    active=openOwnedStores(o.stores,p,'receive',o.managedTransport);host=rootHost(active,p,'receive');resume(host,p,'receive');
    const journal=active.claims(()=>{const s=host!.status(p);must(s.owner==='held'&&!s.running&&!s.draining&&!o.signal.aborted,'claim_owner_not_idle');});
    // Recovery checks a prior claim before intake: no re-launch or dependence on body retention.
    claim=journal.inspect(p,p.source)??undefined;
    // Recovery must not depend on unrelated poll/ACK health. Receive continuation is
    // independently composed after this finite durable outbound recovery phase.
    if(!claim){
      for(let i=0;i<o.receiveSteps;i++){
        must(!o.signal.aborted,'runtime_stopped');const receive=await host.stepOnce(p,{op:'receive'});
        must(receive.state==='done','receive_incomplete');
        // This guarded host operation is the sole metadata intake, never SQLiteInbox.inbox directly.
        const inbox=await host.stepOnce(p,{op:'inbox'});must(inbox.state==='done'&&Array.isArray(inbox.value),'inbox_metadata_unavailable');
        const found=inbox.value.some((v:any)=>exact(v,p.source)&&v.kind==='question'&&v.receipt_confirmed===true);
        if(found){const c=journal.claim(p,p.source);claim=c.record;newly=c.newly_claimed;break;}
        if(i+1<o.receiveSteps)await delay(o.intervalMs,undefined,{signal:o.signal});
      }
    }
    await stopHost(host,p,active,o.drainMs);host=undefined;active=undefined;
    if(!claim)return Object.freeze({state:'waiting_for_source',newlyClaimed:false,nativeStarted:false,retained:false});
    let nativeStopReason:string|null=null;
    if(newly){
      // Same owner DB is reopened only AFTER old host stopped, released, and all handles closed.
      active=openOwnedStores(o.stores,p,'native',o.managedTransport);
      must(active.hostOptions.control.snapshot().paused,'native_requires_paused_control');
      const owned=active;
      const native=await o.launch({claim,stores:owned,activate(controls){
        p.check('activate');must(!o.signal.aborted&&!controls.signal.aborted,'activation_revoked');
        const before=controls.status();must(before.paused&&before.owner==='held'&&!before.running&&!before.draining,'activation_requires_idle_owner');
        const enabled=controls.updatePermission(before.epoch,true);p.check('activate');controls.resume(enabled.epoch);
      }});
      try{
        await native.owner.ready;nativeStopReason=native.wakeResult()?.stopReason??null;
        await native.owner.stop();await native.owner.completion;await native.exited;
        must(owned.closed,'native_store_close_not_confirmed');active=undefined;
      }catch{
        await native.owner.stop().catch(()=>{});await native.owner.completion.catch(()=>{});
        // Unknown remote work or failed cleanup retains all owner/store handles; NEVER reopen here.
        if(!owned.closed)retainedRuns.set(o.stores.paths.owner,{stores:owned,native});
        return Object.freeze({state:'native_outcome_or_cleanup_unknown',newlyClaimed:true,nativeStarted:true,retained:!owned.closed,launchId:claim.launch_id});
      }
    }
    active=openOwnedStores(o.stores,p,'recover',o.managedTransport);host=rootHost(active,p,'recover');resume(host,p,'recover');
    let inspected=await host.stepOnce(p,{op:'answer_inspect',source:p.source});must(inspected.state==='done','answer_inspect_incomplete');
    let intent=inspected.value as {state:string;reply_id:string;outbox_state:string}|null;
    if(!intent){await stopHost(host,p,active,o.drainMs);return Object.freeze({state:'claimed_without_answer_blocked',newlyClaimed:newly,nativeStarted:newly,retained:false,launchId:claim.launch_id,nativeStopReason});}
    if(intent.state==='prepared'){
      const enqueued=await host.stepOnce(p,{op:'answer_enqueue',source:p.source});must(enqueued.state==='done','answer_enqueue_incomplete');
    }
    let delivery:string|null=null;
    for(let i=0;i<o.reconcileSteps;i++){
      must(!o.signal.aborted,'runtime_stopped');const sent=await host.stepOnce(p,{op:'send'});must(sent.state==='done','send_incomplete');
      const record=active.hostOptions.outbox.get(intent.reply_id);delivery=record.receipt?.state??null;
      if(delivery==='acked'||['quarantined','expired_unknown'].includes(record.state))break;
      if(i+1<o.reconcileSteps)await delay(o.intervalMs,undefined,{signal:o.signal});
    }
    const replyId=intent.reply_id;await stopHost(host,p,active,o.drainMs);host=undefined;active=undefined;
    return Object.freeze({state:delivery==='acked'?'reply_receipt_saved':'reply_pending',newlyClaimed:newly,nativeStarted:newly,retained:false,launchId:claim.launch_id,replyId,delivery,nativeStopReason});
  }catch{
    // Local hosts can stop only through the real pause/drain/release path. Unattached native
    // handles are intentionally retained because launch may have had an uncertain side effect.
    if(active&&host){try{await stopHost(host,p,active,o.drainMs);}catch{}}
    if(active&&!active.closed)retainedRuns.set(o.stores.paths.owner,{stores:active,host});
    return Object.freeze({state:'blocked',newlyClaimed:newly,nativeStarted:newly,retained:!!active&&!active.closed,launchId:claim?.launch_id??null});
  }
}
/** Shared implementation for the synthetic ACP integration. The real deployment adapter below
 * uses pinned native verification, not this factory's externally supplied verifier.
 */
export async function startFixedAcpOwner(input:{claim:SourceLaunchRecord;stores:OwnedStores;activate(controls:ExternalOwnerControls):void}, options:{
  acp:Omit<AcpOwnerOptions,'fixedWake'|'verifyDeployment'>;
  verifyDeployment: NonNullable<AcpOwnerOptions['verifyDeployment']>;
  bearerToken:string;serverName:string;scopeSignal:AbortSignal;
}) : Promise<OwnerRun> {
  const policy=fixedWakePolicy(input.claim);let result:Readonly<{stopReason:string}>|null=null;
  const driver=createAcpOwnerDriver({...options.acp,verifyDeployment:options.verifyDeployment,fixedWake:{text:fixedWakeText(policy),timeoutMs:5000}});
  const owner=await startExternalOwner({driver,bearerToken:options.bearerToken,serverName:options.serverName,
    lifetimeMs:15000,shutdownTimeoutMs:2000,ownerSignal:options.scopeSignal,
    onBound:async controls=>{input.activate(controls);result=await driver.wake();},
    closeStores:()=>input.stores.closeAfterRelease()});
  return {owner,exited:driver.exited,wakeResult:()=>result};
}

/** Continue the previous receive-only responsibility on the SAME owner/inbox/control/budget.
 * Existing ReceiveSupervisor owns scheduling; no new model/source dispatch loop is invented.
 */
export async function continueReceiving(o:RuntimeOptions){
  const config=o.receiverContinuation;must(config&&Number.isSafeInteger(config.lifetimeMs)&&config.lifetimeMs>=1&&config.lifetimeMs<=900000,'invalid_receive_lifetime');
  must(!retainedRuns.has(o.stores.paths.owner),'retained_owner_requires_recovery');
  const p=o.policy,stores=openOwnedStores(o.stores,p,'receive',o.managedTransport);let host:AdapterHostCycle|undefined;
  const stop=new AbortController(),signal=AbortSignal.any([o.signal,stop.signal]);
  const timer=setTimeout(()=>stop.abort(),config.lifetimeMs);
  try{
    host=rootHost(stores,p,'receive');resume(host,p,'receive');
    const supervisor=new ReceiveSupervisor({version:1,host,context:p},config.policy);
    const result=await supervisor.run(signal);must(result.drained,'receive_drain_unknown');
    await stopHost(host,p,stores,o.drainMs);return Object.freeze({...result,retained:false});
  }catch{
    if(host){try{await stopHost(host,p,stores,o.drainMs);}catch{}}
    if(!stores.closed)retainedRuns.set(o.stores.paths.owner,{stores,host});
    return Object.freeze({reason:'host_unavailable',retained:!stores.closed});
  }finally{clearTimeout(timer);}
}
