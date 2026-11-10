/** ARCHIVE LIMIT: includes an omitted deployment-template fixture. Not runnable as packaged.
 * Historical template digests below are not approval or current verification. */
/** Fresh fake source/policy only. Never reads a live profile or mints a credential. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync,mkdirSync,rmSync,existsSync,statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {createNativeMaterializer} from '../private/materialize_native.ts';
import {createProductionRoot} from '../production_root.ts';
import {fixedWakePolicy} from '../private/fixed_wake_policy.ts';
import {fixture as storesFixture} from './fixture.mjs';
const hash=data=>createHash('sha256').update(data).digest('hex');
function fixture(t){
 const dir=mkdtempSync(join(tmpdir(),'hab-manifest-fixture-')),stage=join(dir,'stage');mkdirSync(stage,{mode:0o700});
 t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const paths=Object.fromEntries(['entry.py','interpreter','driver.ts','owner.ts','node','template.json'].map(n=>[n,join(dir,n)]));
 for(const n of ['entry.py','interpreter','driver.ts','owner.ts','node'])writeFileSync(paths[n],'# SYNTHETIC SOURCE ONLY '+n,{mode:0o600});
 const files=Object.fromEntries(['entry.py','interpreter'].map(n=>[paths[n],hash(readFileSync(paths[n]))]));
 const parentFiles=Object.fromEntries(['driver.ts','owner.ts','node'].map(n=>[paths[n],hash(readFileSync(paths[n]))]));
 const scope={domain_id:'synthetic-domain',account_uid:process.getuid(),audience:'all-effective-selected-profile-viewers-and-host-operators',native_privilege:'interactive-profile-operator',
 create_effects:['durable-session','profile-config-and-secrets','eager-mcp-discovery','native-hooks-and-inventory','possible-background-update-check'],platform_trust:'same-user-host-operators-and-macos-system-runtime',expires_at_ms:Date.now()+180000};
 const selection={profile_home:'/synthetic/root/profiles/selected',session_cwd:'/synthetic/work',endpoint:{code_sha:'synthetic-approved-revision'},scope,control_paths:{}};
 const template={format:1,selection:null,hab:null,wake_policy:null,entry:paths['entry.py'],interpreter:paths.interpreter,parent_interpreter:paths.node,
 files,parent_files:parentFiles,modules:{},lifetime_seconds:60,native_code_sha:'synthetic-approved-revision',absent_paths:[],dynamic_links:{}};
 writeFileSync(paths['template.json'],JSON.stringify(template),{mode:0o600});
 const source={sender_id:'synthetic-peer',message_id:'synthetic-question'},claim={source,launch_id:'sl_'+'b'.repeat(32),claimed_at:Date.now()};
 let authorized=true;
 const input={templatePath:paths['template.json'],templateSha256:hash(readFileSync(paths['template.json'])),parentFiles,driverPath:paths['driver.ts'],ownerPath:paths['owner.ts'],stagingParent:stage,
 selection,agentId:'synthetic-recipient',actorId:'synthetic-root',check(){assert.ok(authorized)}};
 return {input,claim,stage,template,paths,scope,revoke(){authorized=false}};
}
test('materializer previews without writes and creates exact claim manifest without modifying template',t=>{
 const f=fixture(t),original=readFileSync(f.input.templatePath),m=createNativeMaterializer(f.input),plan=m.plan(f.claim);
 assert.equal(existsSync(plan.directory),false);assert.deepEqual(plan.manifest.wake_policy,fixedWakePolicy(f.claim));
 const result=m.materialize(f.claim),bytes=readFileSync(result.manifestPath),saved=JSON.parse(bytes);
 assert.equal(hash(bytes),result.manifestSha256);assert.deepEqual(saved.wake_policy,fixedWakePolicy(f.claim));
 assert.equal(saved.hab.message_id,f.claim.source.message_id);assert.equal(saved.selection.request_id,'hab-native-v1-'+f.claim.launch_id);
 const other={...f.claim,launch_id:'sl_'+'c'.repeat(32)};assert.notEqual(m.plan(other).manifest.selection.request_id,saved.selection.request_id);assert.equal(saved.entry,plan.entryPath);
 assert.equal(hash(readFileSync(saved.entry)),saved.files[saved.entry]);assert.equal(statSync(result.directory).mode&0o777,0o700);
 assert.equal(statSync(result.manifestPath).mode&0o777,0o600);assert.deepEqual(readFileSync(f.input.templatePath),original);
 assert.throws(()=>m.materialize(f.claim));
 assert.ok(!bytes.toString().includes('bearerToken'));assert.ok(!bytes.toString().includes('SYNTHETIC_UNTRUSTED_BODY'));
});
test('materializer denies missing/mutated/expired source policy before output',t=>{
 for(const mutate of [f=>{f.input.templateSha256='0'.repeat(64)},f=>{f.input.parentFiles={}},f=>{f.input.selection.scope.expires_at_ms=Date.now()},f=>{f.input.selection.endpoint.code_sha='wrong'}]){
 const f=fixture(t);mutate(f);assert.throws(()=>createNativeMaterializer(f.input));}
 const f=fixture(t),m=createNativeMaterializer(f.input);f.input.selection.profile_home='/other';assert.throws(()=>m.materialize(f.claim));
 assert.equal(existsSync(join(f.stage,f.claim.launch_id)),false);
});
test('production root requires concrete current inputs, plans without native/credential actions',t=>{
 const f=fixture(t),s=storesFixture();t.after(()=>{s.close();rmSync(s.dir,{recursive:true,force:true})});let capabilityCalls=0;
 const dir=fileURLToPath(new URL('..',import.meta.url));
 f.input.driverPath=join(dir,'hab/src/owner-integrations/acp-stdio.ts');f.input.ownerPath=join(dir,'hab/src/adapter-host/external-owner.ts');
 for(const rel of ['production_root.ts','runtime.ts','private/source_outbox.ts','private/materialize_native.ts','private/pinned_launch.ts','private/native_deployment.ts','private/fixed_wake_policy.ts','hab/src/owner-integrations/acp-stdio.ts','hab/src/adapter-host/external-owner.ts']){
 const p=join(dir,rel);f.input.parentFiles[p]=hash(readFileSync(p));}
 const signal=new AbortController(),nativeScope=new AbortController();
 const input={signal:signal.signal,policy:s.options.policy,stores:s.stores,managedTransport:s.options.managedTransport,native:f.input,nativeScope:f.scope,nativeScopeSignal:nativeScope.signal,
 checkNativeEvidence(){assert.equal(nativeScope.signal.aborted,false)},async obtainAuthorizedCapability(){capabilityCalls++;throw Error('not authorized in test')},bounds:{receiveSteps:1,reconcileSteps:3,intervalMs:5,drainMs:1000}};
 const root=createProductionRoot(input);assert.equal(root.signal,input.signal);assert.equal(typeof root.launch,'function');assert.equal(capabilityCalls,0);
 assert.equal(existsSync(join(f.stage,f.claim.launch_id)),false);nativeScope.abort();assert.throws(()=>root.policy.check('receive'));
 assert.throws(()=>createProductionRoot({...input,obtainAuthorizedCapability:undefined}));
});
test('actual reviewed unselected template keeps Python closure when entry is relocated (no native execution)',t=>{
 const base='/synthetic/REQUIRES_REVIEWED_FIXTURE';
 const templatePath=join(base,'deployment.json'),bytes=readFileSync(templatePath);
 assert.equal(hash(bytes),'8c6875c98d5ca20a9c8875178e9501834b4677c07de1043c05133e9a0136f24d');
 const template=JSON.parse(bytes),entry=readFileSync(template.entry);
 assert.equal(hash(entry),'967961f139568a268206130c23419a85f92371b2d5d8f8c503f7ce3426c0086c');
 const f=fixture(t);f.input.templatePath=templatePath;f.input.templateSha256=hash(bytes);
 f.input.selection.endpoint.code_sha=template.native_code_sha;
 f.input.parentFiles[template.parent_interpreter]=template.parent_files[template.parent_interpreter];
 const m=createNativeMaterializer(f.input),result=m.materialize(f.claim),made=JSON.parse(readFileSync(result.manifestPath));
 assert.deepEqual(readFileSync(made.entry),entry);assert.equal(join(result.directory,'deployment.json'),result.manifestPath);
 assert.deepEqual(made.modules,template.modules);assert.deepEqual(made.sys_path,template.sys_path);assert.deepEqual(made.startup_sys_path,template.startup_sys_path);
 for(const [path,sha] of Object.entries(template.files))assert.equal(made.files[path],sha);
 assert.equal(made.files[made.entry],hash(entry));assert.deepEqual(readFileSync(templatePath),bytes);
 assert.ok(entry.toString().includes("Path(__file__).resolve().with_name('deployment.json')"));
 // No Python import, process, profile lookup, network or credential path is invoked here.
});
