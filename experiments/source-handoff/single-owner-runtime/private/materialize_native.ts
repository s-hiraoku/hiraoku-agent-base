/** Private deterministic manifest derivation. No credential issuance, profile discovery,
 * native import or network. Every source pin comes from independently approved input.
 */
import {mkdirSync,writeFileSync,lstatSync,realpathSync,openSync,closeSync,fsyncSync} from 'node:fs';
import {isAbsolute,join} from 'node:path';
import {createHash} from 'node:crypto';
import {readPinned} from './native_deployment.ts';
import {fixedWakePolicy} from './fixed_wake_policy.ts';
import type {SourceLaunchRecord} from '../../../../src/owner-integrations/source-launch-journal.ts';
export type SelectedNative = Readonly<{
 profile_home:string;session_cwd:string;request_id:string;
 endpoint:Readonly<Record<string,unknown>>;scope:Readonly<Record<string,unknown>>;
 control_paths:Readonly<Record<string,Readonly<Record<string,unknown>>>>;
}>;
export type NativeMaterializerInput = Readonly<{
 templatePath:string;templateSha256:string;
 /** Already approved full native-parent closure, not a directory to scan and trust. */
 parentFiles:Readonly<Record<string,string>>;
 driverPath:string;ownerPath:string;
 /** Existing private staging parent. A new claim directory is created exclusively. */
 stagingParent:string;
 selection:Omit<SelectedNative,'request_id'>;
 agentId:string;actorId:string;
 /** Current owner-root approval/provenance check; never derived from template JSON. */
 check():void;
}>;
const require=(v:unknown,code:string)=>{if(!v)throw Error(code)};
const digest=(data:Uint8Array)=>createHash('sha256').update(data).digest('hex');
function canonical(value:unknown):string{
 if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';
 if(value&&typeof value==='object')return '{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+canonical((value as Record<string,unknown>)[k])).join(',')+'}';
 return JSON.stringify(value);
}
function path(value:unknown):asserts value is string{require(typeof value==='string'&&isAbsolute(value)&&!/[\x00-\x1f\x7f]/.test(value),'invalid_native_path');}
/** Preparation checks source/policy consistency without writing or opening a profile/store. */
export function createNativeMaterializer(input:NativeMaterializerInput){
 require(typeof input?.check==='function','root_native_authorizer_required');input.check();
 path(input.templatePath);path(input.stagingParent);path(input.driverPath);path(input.ownerPath);
 require(realpathSync(input.stagingParent)===input.stagingParent,'canonical_staging_parent_required');
 const parent=lstatSync(input.stagingParent);require(parent.isDirectory()&&!(parent.mode&0o077)&&parent.uid===process.getuid?.(),'private_staging_parent_required');
 const template=JSON.parse(readPinned(input.templatePath,input.templateSha256).toString('utf8'));
 require(template.format===1&&template.selection===null&&template.hab===null&&template.wake_policy===null,'unselected_approved_template_required');
 require(template.lifetime_seconds===60&&template.files&&template.modules&&template.parent_interpreter&&template.interpreter,'complete_native_template_required');
 require(template.files[template.entry]&&template.files[template.interpreter],'native_entry_and_interpreter_pins_required');
 const entry=readPinned(template.entry,template.files[template.entry]);
 const selection=structuredClone(input.selection),parentFiles=structuredClone(input.parentFiles);
 require(selection&&Object.keys(selection).sort().join(',')==='control_paths,endpoint,profile_home,scope,session_cwd','exact_native_selection_required');
 path(selection.profile_home);path(selection.session_cwd);
 require(selection.scope?.account_uid===process.getuid?.()&&typeof selection.scope.expires_at_ms==='number'&&selection.scope.expires_at_ms>Date.now()+60000,'current_native_scope_required');
 require(selection.endpoint?.code_sha===template.native_code_sha,'native_revision_mismatch');
 require(parentFiles[input.driverPath]&&parentFiles[input.ownerPath]&&parentFiles[template.parent_interpreter],'complete_parent_pins_required');
 for(const [filename,sha] of Object.entries(parentFiles)){path(filename);require(/^[a-f0-9]{64}$/.test(sha),'invalid_parent_pin');}
 require(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(input.agentId)&&/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(input.actorId),'native_actor_identity_required');
 const snapshot=canonical({selection,parentFiles,agentId:input.agentId,actorId:input.actorId,driverPath:input.driverPath,ownerPath:input.ownerPath,stagingParent:input.stagingParent,
 templatePath:input.templatePath,templateSha256:input.templateSha256});
 const check=()=>{input.check();require(snapshot===canonical({selection:input.selection,parentFiles:input.parentFiles,agentId:input.agentId,actorId:input.actorId,
 driverPath:input.driverPath,ownerPath:input.ownerPath,stagingParent:input.stagingParent,templatePath:input.templatePath,templateSha256:input.templateSha256}),'native_materializer_input_changed');
 require(selection.scope.expires_at_ms as number>Date.now()+60000,'native_scope_expiring');};
 function derive(claim:SourceLaunchRecord){
  check();const wake=fixedWakePolicy(claim),directory=join(input.stagingParent,claim.launch_id),entryPath=join(directory,'native_entry.py');
  const manifest={...structuredClone(template),entry:entryPath,driver:input.driverPath,owner:input.ownerPath,
   files:{...template.files,[entryPath]:digest(entry)},parent_files:parentFiles,
   selection:{...structuredClone(selection),request_id:'hab-native-v1-'+claim.launch_id},hab:{agent_id:input.agentId,actor_id:input.actorId,...wake.source},wake_policy:wake,missing_trusted_inputs:[]};
  return {directory,entryPath,manifestPath:join(directory,'deployment.json'),manifest,entry:Buffer.from(entry)};
 }
 return Object.freeze({
  /** Pure preview after checking already-approved local source bytes. No native proof is created. */
  plan:(claim:SourceLaunchRecord)=>{const p=derive(claim);return Object.freeze({directory:p.directory,entryPath:p.entryPath,manifestPath:p.manifestPath,manifest:structuredClone(p.manifest)});},
  materialize(claim:SourceLaunchRecord){
   const p=derive(claim);check();
   // Exclusive directory/file creation. No overwrite/reuse, symlink adoption or old-manifest edit.
   mkdirSync(p.directory,{mode:0o700});
   const bytes=Buffer.from(JSON.stringify(p.manifest,null,2)+'\n');
   try{
    writeFileSync(p.entryPath,p.entry,{mode:0o600,flag:'wx'});writeFileSync(p.manifestPath,bytes,{mode:0o600,flag:'wx'});
    for(const filename of [p.entryPath,p.manifestPath]){const fd=openSync(filename,'r');try{fsyncSync(fd)}finally{closeSync(fd)}}
    check();readPinned(p.entryPath,digest(p.entry));readPinned(p.manifestPath,digest(bytes));
    return Object.freeze({manifestPath:p.manifestPath,manifestSha256:digest(bytes),directory:p.directory});
   }catch{throw Error('native_materialization_incomplete_retained');}
  }
 });
}
