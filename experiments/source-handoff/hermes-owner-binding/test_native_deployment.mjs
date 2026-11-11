// Offline/fake composition only. Never invoke the shipped live native manifest.
import assert from 'node:assert/strict';
import { selectionFixture } from './test_control_fixture.mjs';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { prepareNativeDeployment } from './native_deployment.ts';
import { SQLiteInbox } from '../../../src/agent-sdk/sqlite-inbox.ts';
const dir = realpathSync(mkdtempSync(join(tmpdir(), 'hab-native-verifier-unit-')));
const hash = p => createHash('sha256').update(readFileSync(p)).digest('hex');
const nodePath=realpathSync(process.execPath), nodeHash=hash(nodePath);
const scope = { domain_id: 'fake-domain', account_uid: process.getuid(),
  audience: 'all-effective-selected-profile-viewers-and-host-operators',
  native_privilege: 'interactive-profile-operator',
  create_effects: ['durable-session', 'profile-config-and-secrets', 'eager-mcp-discovery',
    'native-hooks-and-inventory', 'possible-background-update-check'],
  platform_trust: 'same-user-host-operators-and-macos-system-runtime', expires_at_ms: Date.now() + 120000 };
const token = 'fake_only_not_a_real_credential_12345678901234567890';
let cases = 0;
const fixture = () => {
  const interpreter = join(dir, 'fake-interpreter');
  const entry = join(dir, 'native_entry.py');
  const driver = join(dir, 'fake-driver.mjs');
  const owner = join(dir, 'fake-owner.mjs');
  writeFileSync(interpreter, 'fixture bytes only, never executed');
  writeFileSync(entry, '# fixture bytes only, never executed\n');
  writeFileSync(driver, `export function createAcpOwnerDriver(options) {
    const signal = options.scopeSignal; let launch;
    return { ownerSignal: signal, exited: Promise.resolve({code:0}),
      create(value) { launch = value; return Promise.resolve({}); },
      verifyCommitted(result, value) { return options.verifyDeployment({ sessionId: 'untrusted-correlation', launch: value }); },
      async close() {} };
  }\n`);
  writeFileSync(owner, `export async function startExternalOwner(options) {
    const launch = Object.freeze({ generation: Object.freeze({}), signal: options.ownerSignal,
      mcp: Object.freeze({ name: options.serverName, type: 'http', url: 'http://127.0.0.1:43210/mcp',
        headers: Object.freeze({Authorization:'Bearer '+options.bearerToken}) }) });
    const result = await options.driver.create(launch);
    const binding = await options.driver.verifyCommitted(result, launch);
    let finish; const completion = new Promise(resolve=>{finish=resolve});
    options.driver.ownerSignal.addEventListener('abort', finish, {once:true});
    return { ready: Promise.resolve({phase:'fake-bound-deny', binding}), completion,
      stop: async()=>{ await options.driver.close(); finish(); } };
  }\n`);
  const files = Object.fromEntries([interpreter, entry].map(p => [p, hash(p)]));
  const parent_files = {...Object.fromEntries([driver, owner].map(p => [p, hash(p)])),[nodePath]:nodeHash};
  const m = { format: 1, interpreter, entry, parent_interpreter:nodePath, driver, owner, files, parent_files, dynamic_links: {}, absent_paths: [],
    lifetime_seconds: 60, selection: selectionFixture(scope),
    hab: { agent_id: 'fake-agent', actor_id: 'fake-actor', sender_id: 'fake-peer', message_id: 'fake-question' } };
  const binding = { actorId: 'fake-actor', source: {sender_id:'fake-peer',message_id:'fake-question'},
    verifiedRecipientContext: {}, verifiedOperatorContext: {}, hostOptions: {
      control: { agentId:'fake-agent',snapshot:()=>({paused:true}) }, owner:{agentId:'fake-agent'},
      inbox:{},outbox:{},budget:{},answer_intents:{},transport:()=>{throw Error('no network');} } };
  const controller = new AbortController();
  const t = { profileHome:'/fake/root/profiles/synthetic-profile',scope:structuredClone(scope),scopeSignal:controller.signal,
    binding,bearerToken:token,serverName:'fake-server',closeStores(){} };
  const manifestPath = join(dir,'deployment.json');
  const save = () => { writeFileSync(manifestPath,JSON.stringify(m)); return {manifestPath,manifestSha256:hash(manifestPath),trusted:t}; };
  return {m,t,controller,save,entry};
};
try {
  // The shipped reference-deployment.json case is omitted: deployment manifests are excluded from this archive.
  for (const mutate of [f=>{f.t.scope.domain_id='other';}, f=>{f.controller.abort();},
    f=>{f.t.binding.actorId='wrong';}, f=>{f.t.binding.source.message_id='wrong';},
    f=>{f.t.binding.verifiedOperatorContext=f.t.binding.verifiedRecipientContext;},
    f=>{f.t.binding.hostOptions.control.snapshot=()=>({paused:false});},
    f=>{f.t.bearerToken='short';}, f=>{f.m.files[f.entry]='0'.repeat(64);},
    f=>{f.m.parent_interpreter='/wrong/node';},
    f=>{f.m.selection.endpoint.control_home='/other';},
    f=>{delete f.m.selection.control_paths.profile_lock;},
    f=>{f.m.selection.control_paths.control_lock.mode=0o100644;},
    f=>{f.m.selection.control_paths.control_socket.path='/fake/profile/gateway.sock';},
    f=>{f.m.selection.endpoint.authority_epoch=true;},
    f=>{f.m.selection.endpoint.api_origin='http://evil.example:12';},
    f=>{f.m.selection.profile_home='/fake/root';}]) {
    const f=fixture(); mutate(f);
    assert.throws(()=>prepareNativeDeployment(f.save())); cases++;
  }
  {
    const f=fixture(), p=prepareNativeDeployment(f.save()); p.check();
    f.t.binding.verifiedRecipientContext={}; assert.throws(()=>p.check()); cases++;
  }
  {
    const f=fixture(), p=prepareNativeDeployment(f.save());
    writeFileSync(f.entry,'changed fixture'); assert.throws(()=>p.check()); cases++;
  }
  {
    const f=fixture(); f.m.absent_paths=[join(dir,'unexpected-startup.zip')];
    const p=prepareNativeDeployment(f.save());
    writeFileSync(f.m.absent_paths[0],'unreviewed startup payload');
    assert.throws(()=>p.check()); cases++;
  }
  {
    const f=fixture();
    const source=join(dir,'shadow-source'), base=join(dir,'node_modules/reviewfixture');
    mkdirSync(source,{recursive:true});mkdirSync(base,{recursive:true});
    writeFileSync(join(base,'package.json'),JSON.stringify({name:'reviewfixture',type:'module',exports:'./index.mjs'}));
    writeFileSync(join(base,'index.mjs'),'export const marker="PINNED";\n');
    const old=f.m.driver;
    f.m.driver=join(source,'driver.mjs');
    writeFileSync(f.m.driver,'import {marker} from "reviewfixture";\n'+readFileSync(old,'utf8'));
    for(const path of [f.m.driver,join(base,'package.json'),join(base,'index.mjs')]) f.m.parent_files[path]=hash(path);
    const p=prepareNativeDeployment(f.save());
    const shadow=join(source,'node_modules/reviewfixture');mkdirSync(shadow,{recursive:true});
    writeFileSync(join(shadow,'package.json'),JSON.stringify({name:'reviewfixture',type:'module',exports:'./index.mjs'}));
    writeFileSync(join(shadow,'index.mjs'),'globalThis.__UNPINNED_BODY_RAN=true; export const marker="SHADOW";\n');
    p.check(); // On-disk existing file pins alone are insufficient.
    await assert.rejects(p.start());
    assert.equal(globalThis.__UNPINNED_BODY_RAN,undefined); cases++;
  }
  {
    const f=fixture(), cached=join(dir,'cached-dependency.mjs');
    writeFileSync(cached,'export const marker="OLD";\n');
    assert.equal((await import(pathToFileURL(cached).href)).marker,'OLD');
    writeFileSync(cached,'export const marker="NEW";\n');
    writeFileSync(f.m.driver,'import {marker} from "./cached-dependency.mjs";\nif(marker!=="NEW") throw Error("stale cache");\n'+readFileSync(f.m.driver,'utf8'));
    for(const path of [f.m.driver,cached]) f.m.parent_files[path]=hash(path);
    const p=prepareNativeDeployment(f.save()), result=await p.start();
    assert.equal((await result.owner.ready).binding,f.t.binding);
    await result.owner.stop(); await result.owner.completion; cases++;
  }
  {
    const f=fixture(), nested=join(dir,'nested-fresh.cjs'), fresh=join(dir,'fresh-dependency.cjs');
    writeFileSync(nested,'module.exports={value:7};\n');
    writeFileSync(fresh,'module.exports=require("./nested-fresh.cjs");\n');
    writeFileSync(f.m.driver,'import fresh from "./fresh-dependency.cjs";\nif(fresh.value!==7) throw Error("bad CJS");\n'+readFileSync(f.m.driver,'utf8'));
    for(const path of [f.m.driver,fresh,nested]) f.m.parent_files[path]=hash(path);
    const p=prepareNativeDeployment(f.save()), result=await p.start();
    assert.equal((await result.owner.ready).binding,f.t.binding);
    await result.owner.stop();await result.owner.completion; cases++;
  }
  {
    const f=fixture(), scope=join(dir,'js-source'), inner=join(scope,'inner');mkdirSync(inner,{recursive:true});
    const packagePath=join(scope,'package.json'), dependency=join(inner,'dependency.js');
    writeFileSync(packagePath,JSON.stringify({type:'commonjs'}));
    writeFileSync(dependency,'globalThis.__UNPINNED_SCOPE_BODY_RAN=true; module.exports={};\n');
    writeFileSync(f.m.driver,'import value from "./js-source/inner/dependency.js";\n'+readFileSync(f.m.driver,'utf8'));
    for(const path of [f.m.driver,packagePath,dependency]) f.m.parent_files[path]=hash(path);
    const p=prepareNativeDeployment(f.save());
    writeFileSync(join(inner,'package.json'),JSON.stringify({type:'module'}));
    await assert.rejects(p.start());assert.equal(globalThis.__UNPINNED_SCOPE_BODY_RAN,undefined);cases++;
  }
  {
    const f=fixture(), cached=join(dir,'cached-dependency.cjs'), require=createRequire(import.meta.url);
    writeFileSync(cached,'module.exports={value:1};\n');require(cached);
    f.m.parent_files[cached]=hash(cached);
    const p=prepareNativeDeployment(f.save());
    await assert.rejects(p.start()); delete require.cache[cached]; cases++;
  }
  {
    const f=fixture(), p=prepareNativeDeployment(f.save());
    const result=await p.start(); const ready=await result.owner.ready;
    assert.equal(ready.binding,f.t.binding); // Same trusted contexts, never sessionId-derived.
    assert.equal(ready.phase,'fake-bound-deny');
    await assert.rejects(p.start());
    f.controller.abort(); await result.owner.completion; cases++;
  }

  // Synthetic local root branch: test doubles are NOT live authentication.
  const localFixture = () => {
    const f = fixture(), hostOptions = f.t.binding.hostOptions;
    const entry = { receipt_confirmed: true, sender_id: 'fake-peer', message: {
      message_id: 'fake-question', recipient_id: 'fake-agent', kind: 'question' } };
    for (const store of [hostOptions.inbox, hostOptions.outbox, hostOptions.budget, hostOptions.answer_intents]) store.agentId = 'fake-agent';
    hostOptions.inbox.withEntry = (sender, message, fn) => {
      assert.equal(sender, 'fake-peer'); assert.equal(message, 'fake-question'); return fn(entry);
    };
    f.t.localOwner = {hostOptions, policy: {
      account_uid: process.getuid(), agent_id: 'fake-agent', actor_id: 'fake-actor',
      source: {sender_id:'fake-peer', message_id:'fake-question'}, audience: scope.audience,
      operations:['receive','send','inbox_read','answer_prepare','answer_inspect','answer_enqueue'],
      expires_at_ms:scope.expires_at_ms }};
    delete f.t.binding;
    return {...f,entry,hostOptions};
  };
  for (const mutate of [
    f=>{f.entry.receipt_confirmed=false;}, f=>{f.entry.message.kind='answer';},
    f=>{f.entry.sender_id='other';}, f=>{f.entry.message.recipient_id='other';},
    f=>{f.t.localOwner.policy.account_uid++;}, f=>{f.t.localOwner.policy.actor_id='claimed';},
    f=>{f.t.localOwner.policy.source.message_id='claimed';},
    f=>{f.t.localOwner.policy.operations=['answer_prepare'];},
    f=>{f.t.localOwner.policy.expires_at_ms=Date.now()-1;},
    f=>{f.hostOptions.budget.agentId='other';}, f=>{f.t.binding={};},
  ]) { const f=localFixture(); mutate(f); assert.throws(()=>prepareNativeDeployment(f.save())); cases++; }
  {
    const f=localFixture(), p=prepareNativeDeployment(f.save());
    assert.equal('verifiedRecipientContext' in f.t.localOwner, false);
    const result=await p.start(), binding=(await result.owner.ready).binding;
    assert.notEqual(binding.verifiedRecipientContext,binding.verifiedOperatorContext);
    assert.notEqual(binding.verifiedRecipientContext, 'untrusted-correlation');
    assert.equal(binding.hostOptions,f.hostOptions);
    assert.deepEqual(binding.source,f.t.localOwner.policy.source);
    assert.throws(()=>JSON.stringify(binding.verifiedRecipientContext),/not_serializable/);
    assert.throws(()=>structuredClone(binding.verifiedRecipientContext));
    assert.throws(()=>JSON.stringify(binding.verifiedOperatorContext),/not_serializable/);
    assert.equal(Object.isFrozen(binding),true); p.check();
    f.t.localOwner.policy.source.message_id='changed'; assert.throws(()=>p.check());
    f.controller.abort(); await result.owner.completion; cases++;
  }
  {
    const f=localFixture(), p=prepareNativeDeployment(f.save());
    f.entry.receipt_confirmed=false; await assert.rejects(p.start()); cases++;
  }

  {
    // Actual HMAC-protected SQLite source; only the remote receipt is a fixture.
    const f=localFixture(), now=Date.now(), limits={envelope_bytes:32768,text_bytes:16000,data_bytes:16000,parts:8,json_depth:20,json_nodes:1000};
    const inbox=new SQLiteInbox(join(dir,'real-source.sqlite'),{agent_id:'fake-agent',fingerprint_key:new Uint8Array(32).fill(91),limits,
      max_records:10,max_body_bytes:100000,max_ack_records:20,ack_retry_ms:86400000,retry_base_ms:1,retry_cap_ms:10,max_attempts:3});
    try {
      inbox.migrate();f.hostOptions.inbox=inbox;
      const message={version:1,message_id:'fake-question',recipient_id:'fake-agent',kind:'question',body:{parts:[{type:'text',text:'External fixture question'}]},
        thread_id:'fake-thread',in_reply_to:null,first_sent_at:new Date(now-100).toISOString(),expires_at:new Date(now+3599900).toISOString()};
      inbox.save({message:{...message,sender_id:'fake-peer'},generation:1,lease_token:'a'.repeat(43),lease_until:new Date(now+30000).toISOString()});
      assert.throws(()=>prepareNativeDeployment(f.save())); // Durable storage alone is insufficient.
      const ack=inbox.claimAck();assert.ok(ack);
      inbox.confirmAck(ack,{recipient_id:'fake-agent',sender_id:'fake-peer',message_id:'fake-question',request_id:ack.request_id,
        receipt_id:'fixture-ack',acked_at:new Date().toISOString(),state:'acked'});
      const p=prepareNativeDeployment(f.save()), result=await p.start();
      assert.equal((await result.owner.ready).binding.hostOptions.inbox,inbox);
      await result.owner.stop();await result.owner.completion;cases++;
    } finally {inbox.close();}
  }
  console.log(`${cases} offline/fake deployment checks PASS; native route NOT executed`);
} finally { rmSync(dir,{recursive:true,force:true}); }
