/** Concrete private root constructor. Inputs are actual user-owned authorities, not booleans
 * asserting fixture success. No automatic credential/profile discovery or fake fallback exists.
 */
import {fileURLToPath} from 'node:url';
import {createNativeMaterializer,type NativeMaterializerInput} from './private/materialize_native.ts';
import {pinnedNativeLauncher} from './private/pinned_launch.ts';
import type {TrustedInputs} from './private/native_deployment.ts';
import type {RuntimeOptions,RootPolicy,StoreRecipe} from './runtime.ts';
import type {SourceLaunchRecord} from '../../../src/owner-integrations/source-launch-journal.ts';
export type ProductionRootInputs=Readonly<{
 signal:AbortSignal;policy:RootPolicy;stores:StoreRecipe;
 managedTransport:RuntimeOptions['managedTransport'];
 native:NativeMaterializerInput;
 /** Authentic current deployment/scope and credential custody root. Must remain current until
  * cancellation. Native pinned verifier independently checks its own create/receipt path.
  */
 nativeScope:TrustedInputs['scope'];nativeScopeSignal:AbortSignal;
 checkNativeEvidence():void;
 /** Action-time approved credential creation/delivery mechanism, never bearer extraction.
  * Secret value stays in memory; no token argument/environment/file is generated here.
  */
 obtainAuthorizedCapability(claim:SourceLaunchRecord):Promise<{bearerToken:string;serverName:string}>;
 receiverContinuation?:RuntimeOptions['receiverContinuation'];
 bounds:Readonly<Pick<RuntimeOptions,'receiveSteps'|'reconcileSteps'|'intervalMs'|'drainMs'>>;
}>;
const canonical=(v:unknown):string=>Array.isArray(v)?'['+v.map(canonical).join(',')+']':v&&typeof v==='object'?'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical((v as Record<string,unknown>)[k])).join(',')+'}':JSON.stringify(v);
const must=(v:unknown)=>{if(!v)throw Error('production_root_inputs_required')};
export function createProductionRoot(input:ProductionRootInputs):RuntimeOptions{
 must(input&&input.signal instanceof AbortSignal&&!input.signal.aborted&&input.nativeScopeSignal instanceof AbortSignal&&!input.nativeScopeSignal.aborted);
 must(typeof input.policy?.check==='function'&&typeof input.managedTransport==='function'&&typeof input.checkNativeEvidence==='function'&&typeof input.obtainAuthorizedCapability==='function');
 input.policy.check('acquire');input.checkNativeEvidence();
 must(input.native.agentId===input.policy.agentId&&input.native.actorId===input.policy.actorId);
 must(input.nativeScope.account_uid===process.getuid?.()&&input.native.selection.profile_home&&canonical(input.native.selection.scope)===canonical(input.nativeScope));
 const driverPath=fileURLToPath(new URL('../../../src/owner-integrations/acp-stdio.ts',import.meta.url));
 const ownerPath=fileURLToPath(new URL('../../../src/adapter-host/external-owner.ts',import.meta.url));
 must(input.native.driverPath===driverPath&&input.native.ownerPath===ownerPath);
 // Pin the actual private root/verifier/materializer, not just the unmodified HAB driver.
 for(const rel of ['./production_root.ts','./runtime.ts','./private/source_outbox.ts','./private/materialize_native.ts','./private/pinned_launch.ts','./private/native_deployment.ts','./private/fixed_wake_policy.ts'])
  must(typeof input.native.parentFiles[fileURLToPath(new URL(rel,import.meta.url))]==='string');
 const signal=AbortSignal.any([input.signal,input.nativeScopeSignal]);
 const policy=Object.freeze({...input.policy,source:Object.freeze({...input.policy.source}),check(action:Parameters<RootPolicy['check']>[0]){must(!signal.aborted);input.policy.check(action);}});
 const check=()=>{must(!signal.aborted);policy.check('activate');input.checkNativeEvidence();input.native.check();};
 const materializer=createNativeMaterializer({...input.native,check});
 const launch=pinnedNativeLauncher(async invocation=>{
  check();must(invocation.claim.source.sender_id===input.policy.source.sender_id&&invocation.claim.source.message_id===input.policy.source.message_id);
  const capability=await input.obtainAuthorizedCapability(invocation.claim);check();
  must(capability&&/^[A-Za-z0-9_-]{32,256}$/.test(capability.bearerToken)&&/^[A-Za-z0-9_-]{1,96}$/.test(capability.serverName));
  const artifact=materializer.materialize(invocation.claim);
  return {...artifact,trusted:{profileHome:input.native.selection.profile_home,scope:input.nativeScope,scopeSignal:signal,
   bearerToken:capability.bearerToken,serverName:capability.serverName,
   localPolicy:{account_uid:input.nativeScope.account_uid,agent_id:input.policy.agentId,actor_id:input.policy.actorId,source:Object.freeze({...input.policy.source}),
    audience:'all-effective-selected-profile-viewers-and-host-operators',operations:['receive','send','inbox_read','answer_prepare','answer_inspect','answer_enqueue'],expires_at_ms:input.nativeScope.expires_at_ms}}};
 });
 return Object.freeze({signal:input.signal,policy,stores:input.stores,managedTransport:input.managedTransport,launch,
  receiveSteps:input.bounds.receiveSteps,reconcileSteps:input.bounds.reconcileSteps,intervalMs:input.bounds.intervalMs,drainMs:input.bounds.drainMs,
  receiverContinuation:input.receiverContinuation});
}
