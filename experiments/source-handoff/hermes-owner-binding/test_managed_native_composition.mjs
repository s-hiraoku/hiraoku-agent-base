/** Actual managed host + private transport + SQLite. Native port is explicitly fake. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {syntheticStores} from '../../../test/external-owner-fixture.js';
import {AdapterHostCycle} from '../../../src/adapter-host/cycle.ts';
import {NativeHabMcpClient} from './native_mcp_client.ts';
const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r});return {promise,resolve}};
function setup(t){
  const dir=mkdtempSync(join(tmpdir(),'hab-managed-native-fixture-')),stores=syntheticStores(dir),context={};
  t.after(()=>{stores.close();rmSync(dir,{recursive:true,force:true})});
  const {transport,...base}=stores.binding.hostOptions;
  const state={requests:0,wait:null,active:0};
  const port={version:1,resource_url:'https://relay.example/mcp',get activeRequests(){return state.active},
    async callTool(name,args,control){state.active++;
      try{control.check();if(state.wait)await state.wait.promise;control.check();state.requests++;
        assert.equal(name,'relay_submit');assert.equal(args.expected_agent_id,base.control.agentId);assert.equal(args.as_address,'worker@demo.hab');
        const value={sender_id:base.control.agentId,message_id:args.message_id,recipient_id:args.recipient_id,receipt_id:'fixture-receipt',
          accepted_at:new Date().toISOString(),expires_at:args.expires_at,state:'pending'};
        control.check();return JSON.stringify({content:[{type:'text',text:JSON.stringify(value)}],structuredContent:value});
      }finally{state.active--}}};
  const host=new AdapterHostCycle({...base,authorization:ctx=>ctx===context?{agent_id:base.control.agentId,actor_id:'fixture-operator'}:undefined,
    managedTransport:operation=>new NativeHabMcpClient(port,{as_address:'worker@demo.hab',limits:base.limits,policy:{resource_url:port.resource_url,
      agent_id:base.control.agentId,max_request_bytes:65536,max_response_bytes:131072,timeout_ms:5000,max_active_requests:1,max_sse_events:16,
      max_sse_lines:1000,max_json_depth:32,max_json_nodes:10000}},operation)});
  const now=Date.now()-100,message={version:1,message_id:'fixture-message',recipient_id:'fixture-peer',kind:'question',body:{parts:[{type:'text',text:'fixture only'}]},
    thread_id:'fixture-thread',in_reply_to:null,first_sent_at:new Date(now).toISOString(),expires_at:new Date(now+3600000).toISOString()};
  base.outbox.enqueue(message);host.setPaused(context,false,host.status(context).epoch);
  return {host,context,base,state,message};
}
test('actual generic host uses private native transport without copying bearer or calling fetch',async(t)=>{
  const f=setup(t);const result=await f.host.stepOnce(f.context,{op:'send'});assert.equal(result.state,'done');assert.equal(f.state.requests,1);
  assert.equal(f.base.outbox.get(f.message.message_id).state,'accepted');
});
test('actual private native transport consumes host epoch guard after auth wait and retains unsettled owner',async(t)=>{
  const f=setup(t);f.state.wait=deferred();const pending=f.host.stepOnce(f.context,{op:'send'});await new Promise(r=>setImmediate(r));
  f.host.setPaused(f.context,true,f.host.status(f.context).epoch);assert.equal((await pending).state,'incomplete');
  assert.equal(f.host.status(f.context).draining,1);assert.throws(()=>f.host.releaseOwner(f.context),/host_busy/);
  f.state.wait.resolve();await new Promise(r=>setImmediate(r));assert.equal(f.state.requests,0);assert.equal(f.host.status(f.context).draining,0);
  assert.equal(f.base.outbox.get(f.message.message_id).state,'sending');f.host.releaseOwner(f.context);
});
