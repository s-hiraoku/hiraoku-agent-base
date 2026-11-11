/** Finite explicitly approved source order. No body-driven selection or background model loop. */
import {createHash} from 'node:crypto';
import {runOneSource,type RuntimeOptions} from './runtime.ts';
type Result=Awaited<ReturnType<typeof runOneSource>>;
export type SourceSequenceOptions=Readonly<{
 roots:readonly (()=>RuntimeOptions)[];
 /** Independent trusted native reconciliation, not ACK/answer/policy-shaped JSON.
  * Required before advancing after a recovered existing claim. Omitted means denial.
  */
 checkPreviousNativeSettled?(input:Readonly<{source:RuntimeOptions['policy']['source'];launchId:string;signal:AbortSignal}>):void|Promise<void>;
}>;
const stable=(value:unknown):string=>Array.isArray(value)?'['+value.map(stable).join(',')+']':value&&typeof value==='object'?'{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+stable((value as Record<string,unknown>)[k])).join(',')+'}':JSON.stringify(value);
// Ephemeral comparison only. Never write or report keys, serialized recipes or this fingerprint.
const stamp=(value:unknown)=>createHash('sha256').update(stable(value)).digest('hex');
export async function runApprovedSources(o:SourceSequenceOptions){
 if(!o||!Array.isArray(o.roots)||o.roots.length<1||o.roots.length>32||o.roots.some(f=>typeof f!=='function'))throw Error('approved_source_sequence_required');
 const roots=[...o.roots],results:Result[]=[];let recipe:RuntimeOptions['stores']|undefined,recipeStamp:string|undefined,identity:string|undefined,signal:AbortSignal|undefined;
 const sources=new Set<string>();
 for(let i=0;i<roots.length;i++){
  if(signal?.aborted)throw Error('source_sequence_stopped');
  const current=roots[i]();
  if(!recipe){recipe=current.stores;recipeStamp=stamp(recipe);identity=current.policy.agentId;signal=current.signal;}
  if(current.stores!==recipe||stamp(current.stores)!==recipeStamp||current.policy.agentId!==identity||current.signal!==signal)
   throw Error('source_sequence_shared_lineage_required');
  const source=Object.freeze({...current.policy.source}),key=JSON.stringify([source.sender_id,source.message_id]);
  if(sources.has(key))throw Error('source_sequence_duplicate');sources.add(key);
  const result=await runOneSource(current);results.push(result);
  if(result.retained||result.state!=='reply_receipt_saved')return Object.freeze({state:'stopped',results:Object.freeze(results),nextIndex:i});
  if(!(result.nativeStarted&&result.nativeStopReason==='end_turn')){
   if(!o.checkPreviousNativeSettled)return Object.freeze({state:'prior_native_settlement_unverified',results:Object.freeze(results),nextIndex:i+1});
   await o.checkPreviousNativeSettled(Object.freeze({source,launchId:result.launchId,signal:current.signal}));
   if(current.signal.aborted)throw Error('source_sequence_stopped');
  }
 }
 return Object.freeze({state:'completed_finite_sequence',results:Object.freeze(results),nextIndex:roots.length});
}
