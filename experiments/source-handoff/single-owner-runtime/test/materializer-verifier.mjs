/** ARCHIVE LIMIT: includes an omitted deployment-template fixture. Not runnable as packaged.
 * Historical template digests below are not approval or current verification. */
/** Actual reviewed template/source -> actual pinned verifier, SYNTHETIC authorities.
 * Parent closure below is a test-only local source snapshot, NOT deployment approval.
 * Never calls start(), imports native Python, reads a profile, or requests a credential.
 * Run directly with Node26: empty execArgv is a verifier precondition.
 */
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,realpathSync,readdirSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {selectionFixture} from './control-fixture.mjs';
import {createNativeMaterializer} from '../private/materialize_native.ts';
import {prepareNativeDeployment} from '../private/native_deployment.ts';
const root=fileURLToPath(new URL('..',import.meta.url)),dir=realpathSync(mkdtempSync(join(tmpdir(),'hab-materializer-verifier-')));
const digest=b=>createHash('sha256').update(b).digest('hex'),sha=p=>digest(readFileSync(p));
const templatePath='/synthetic/REQUIRES_REVIEWED_FIXTURE';
const templateSha256='8c6875c98d5ca20a9c8875178e9501834b4677c07de1043c05133e9a0136f24d';
assert.equal(sha(templatePath),templateSha256);const template=JSON.parse(readFileSync(templatePath));
assert.equal(sha(template.entry),'967961f139568a268206130c23419a85f92371b2d5d8f8c503f7ce3426c0086c');
const driverPath=join(root,'../../../src/owner-integrations/acp-stdio.ts'),ownerPath=join(root,'../../../src/adapter-host/external-owner.ts');
// This snapshot is deliberately test-only, not a claim that the user approved it for native use.
const parentFiles={...template.parent_files};
function snapshot(directory){for(const e of readdirSync(directory,{withFileTypes:true})){const p=join(directory,e.name);if(e.isDirectory())snapshot(p);else if(e.isFile()&&/\.(ts|js|json)$/.test(e.name))parentFiles[p]=sha(p);}}
snapshot(join(root,'../../../src'));snapshot(join(root,'private'));
for(const p of [join(root,'package.json'),join(root,'../../../package.json'),join(root,'runtime.ts'),join(root,'production_root.ts')])parentFiles[p]=sha(p);
const scope={domain_id:'synthetic-only-not-approved',account_uid:process.getuid(),audience:'all-effective-selected-profile-viewers-and-host-operators',native_privilege:'interactive-profile-operator',
 create_effects:['durable-session','profile-config-and-secrets','eager-mcp-discovery','native-hooks-and-inventory','possible-background-update-check'],platform_trust:'same-user-host-operators-and-macos-system-runtime',expires_at_ms:Date.now()+600000};
const {request_id,...selection}=selectionFixture(scope);let sequence=0;
function nextClaim(){return {source:{sender_id:'synthetic-peer',message_id:'synthetic-question'},launch_id:'sl_'+(++sequence).toString(16).padStart(32,'0'),claimed_at:Date.now()};}
function materialize(claim,parents=parentFiles){return createNativeMaterializer({templatePath,templateSha256,parentFiles:parents,driverPath,ownerPath,stagingParent:dir,selection,
 agentId:'synthetic-recipient',actorId:'synthetic-root',check(){}}).materialize(claim);}
function options(produced,claim){return {...produced,trusted:{profileHome:selection.profile_home,scope,scopeSignal:new AbortController().signal,
 binding:{actorId:'synthetic-root',source:claim.source,verifiedRecipientContext:{},verifiedOperatorContext:{},hostOptions:{
 owner:{agentId:'synthetic-recipient'},control:{agentId:'synthetic-recipient',snapshot:()=>({paused:true})},inbox:{},outbox:{},budget:{},answer_intents:{},transport(){throw Error('no transport')}}},
 bearerToken:'synthetic_only_not_native_credential_1234567890',serverName:'synthetic',closeStores(){throw Error('must not close')},fixedWake:{claim,activate(){throw Error('must not activate')}}}};}
let passed=0;
try{
 const first=nextClaim(),one=materialize(first),prepared=prepareNativeDeployment(options(one,first));prepared.check();passed++;
 const fresh=nextClaim(),two=materialize(fresh);prepareNativeDeployment(options(two,fresh)).check();
 assert.notEqual(one.directory,two.directory);assert.notEqual(JSON.parse(readFileSync(one.manifestPath)).selection.request_id,JSON.parse(readFileSync(two.manifestPath)).selection.request_id);passed++;
 assert.throws(()=>prepareNativeDeployment(options(one,fresh)));passed++;
 const wrongSource=options(two,fresh);wrongSource.trusted.binding.source={...fresh.source,message_id:'wrong-source'};assert.throws(()=>prepareNativeDeployment(wrongSource));passed++;
 const bad=nextClaim(),wrongParent=materialize(bad,{...parentFiles,[driverPath]:'0'.repeat(64)});assert.throws(()=>prepareNativeDeployment(options(wrongParent,bad)));passed++;
 const target=JSON.parse(readFileSync(one.manifestPath)).entry;writeFileSync(target,'# tampered copied fixture entry\n',{mode:0o600});assert.throws(()=>prepared.check());passed++;
 assert.equal(sha(templatePath),templateSha256);assert.equal(sha(template.entry),'967961f139568a268206130c23419a85f92371b2d5d8f8c503f7ce3426c0086c');
 console.log(JSON.stringify({passed,failed:0,actualTemplate:true,actualComposedSource:true,parentClosure:'synthetic-test-only-not-deployment-approval',nativeStarted:false,profilesRead:false,credentialsIssued:false}));
}finally{rmSync(dir,{recursive:true,force:true});}
