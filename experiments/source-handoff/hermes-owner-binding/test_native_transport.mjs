/** Pure fake port + actual HAB contract parsers. No child, OAuth or network. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { NativeHabMcpClient } from './native_mcp_client.ts';
import { limits } from '../../../test/adapter-host-fixtures.js';
const message={version:1,message_id:'fake-answer',recipient_id:'fake-peer',kind:'answer',
  body:{parts:[{type:'text',text:'fixture only'}]},thread_id:'fake-thread',
  in_reply_to:{sender_id:'fake-peer',message_id:'fake-source'},first_sent_at:'2026-11-10T00:00:00.000Z',expires_at:'2026-11-10T01:00:00.000Z'};
const receipt={sender_id:'fake-agent',message_id:message.message_id,recipient_id:message.recipient_id,
  receipt_id:'fake-receipt',accepted_at:'2026-11-10T00:00:01.000Z',expires_at:message.expires_at,state:'acked'};
const encode=value=>JSON.stringify({content:[{type:'text',text:JSON.stringify(value)}],structuredContent:value});
function fixture() {
  const signal=new AbortController(), state={calls:[], checks:0, active:0, alive:true, result:receipt, work:undefined};
  const port={version:1,resource_url:'https://hab.example/mcp',get activeRequests(){return state.active},
    async callTool(name,args,control){state.calls.push({name,args,control});state.active++;
      try {control.check();if(state.work) await state.work;control.check();return encode(state.result)} finally {state.active--}}};
  const options={as_address:'worker@demo.hab',limits,policy:{resource_url:port.resource_url,agent_id:'fake-agent',
    max_request_bytes:65536,max_response_bytes:131072,timeout_ms:30,max_active_requests:1,max_sse_events:16,max_sse_lines:1000,max_json_depth:32,max_json_nodes:10000}};
  const client=new NativeHabMcpClient(port,options,{signal:signal.signal,check(){state.checks++;if(!state.alive)throw Error('revoked')}});
  return {client,port,options,state,signal};
}
test('native sender reuses exact HAB routing and receipt validators',async()=>{
  const f=fixture();assert.deepEqual(await f.client.submit(message),receipt);assert.deepEqual(await f.client.status(message.message_id),receipt);
  assert.equal(f.state.calls.length,2);assert.deepEqual(f.state.calls[0].args,{...message,as_address:'worker@demo.hab',expected_agent_id:'fake-agent'});
  assert.equal(f.state.calls[1].name,'hab_status');assert.equal(f.client.activeRequests,0);assert.ok(f.state.checks>=5);
});
test('forged sender and changed receipt refuse, no arbitrary resolve',async()=>{
  const f=fixture();f.state.result={...receipt,sender_id:'other'};await assert.rejects(f.client.submit(message),/forbidden/);
  f.state.result={...receipt,recipient_id:'other'};await assert.rejects(f.client.submit(message),/transport_failed/);
  await assert.rejects(f.client.resolve('other@demo.hab'),/forbidden/);assert.equal(f.state.calls.length,2);
});
test('timeout retains actual work admission until cleanup, no replay',async()=>{
  const f=fixture();let release;f.state.work=new Promise(r=>{release=r});await assert.rejects(f.client.submit(message),/transport_failed/);
  assert.equal(f.client.activeRequests,1);await assert.rejects(f.client.status(message.message_id),/busy/);
  release();await new Promise(r=>setImmediate(r));assert.equal(f.client.activeRequests,0);assert.equal(f.state.calls.length,1);
});
test('revocation after credential wait prevents native dispatch',async()=>{
  const f=fixture();let release;f.state.work=new Promise(r=>{release=r});const request=f.client.submit(message);
  await new Promise(r=>setImmediate(r));f.state.alive=false;release();await assert.rejects(request,/transport_failed/);assert.equal(f.client.activeRequests,0);
});
test('parent abort rejects immediately but retains pending work',async()=>{
  const f=fixture();let release;f.state.work=new Promise(r=>{release=r});const request=f.client.submit(message);
  await new Promise(r=>setImmediate(r));f.signal.abort();await assert.rejects(request,/transport_failed/);assert.equal(f.client.activeRequests,1);
  release();await new Promise(r=>setImmediate(r));assert.equal(f.client.activeRequests,0);
});
test('resource drift and malformed dual MCP content refuse',async()=>{
  const f=fixture();f.port.resource_url='https://other.example/mcp';await assert.rejects(f.client.submit(message));assert.equal(f.state.calls.length,0);
  const g=fixture();g.port.callTool=async()=>JSON.stringify({content:[{type:'text',text:'{}'}],structuredContent:receipt});
  await assert.rejects(g.client.submit(message),/transport_failed/);
});
test('native business error is sanitized and preserves durable sender status reconciliation',async()=>{
  const f=fixture();f.port.callTool=async()=>JSON.stringify({isError:true,content:[{type:'text',text:'{"error":"not_found"}'}],structuredContent:{error:'not_found'}});
  await assert.rejects(f.client.status(message.message_id),/not_found/);
});
test('real owned Node/Python IPC composes native-manager fixture through standard sender contract',async(t)=>{
  const {NativeHabStdioPort}=await import('./native_stdio.ts');
  const {fileURLToPath}=await import('node:url');
  const port=NativeHabStdioPort.start({command:'/usr/bin/python3',args:['-B',fileURLToPath(new URL('./fake_outbound_entry.py',import.meta.url))],
    cwd:fileURLToPath(new URL('.',import.meta.url)),env:{},resource_url:'https://hab.example/mcp',max_frame_bytes:65536,shutdown_timeout_ms:200});
  t.after(()=>port.close());
  const f=fixture();const client=new NativeHabMcpClient(port,{...f.options,policy:{...f.options.policy,timeout_ms:5000}},
    {signal:f.signal.signal,check(){assert.equal(f.state.alive,true)}});
  assert.deepEqual(await client.submit(message),receipt);
  assert.deepEqual(await client.status(message.message_id),receipt);
  assert.equal(client.activeRequests,0);
});
