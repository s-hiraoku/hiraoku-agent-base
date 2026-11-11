import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtempSync,rmSync,readFileSync,statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {fixture} from './fixture.mjs';
for(const mode of ['prepared','enqueued','unknown'])test(`owned SIGKILL restart ${mode} survives inbound outage without native recreate`,async t=>{
 const dir=mkdtempSync(join(tmpdir(),'hab-single-owner-crash-'));let child,confirmed=false;
 try{
  child=spawn(process.execPath,[fileURLToPath(new URL('./crash-child.mjs',import.meta.url)),mode,dir],{stdio:['ignore','ignore','pipe','ipc'],env:{CLOUDFLARE_CF_FETCH_ENABLED:'false',WRANGLER_SEND_METRICS:'false',DO_NOT_TRACK:'1',TMPDIR:dir}});
  let checkpoint;child.on('message',m=>checkpoint=m);
  let stderr='';child.stderr.on('data',v=>stderr+=v);
  const timer=setTimeout(()=>child.kill('SIGKILL'),12000);
  const exit=await new Promise(resolve=>child.once('exit',(code,signal)=>resolve({code,signal})));clearTimeout(timer);confirmed=true;
  assert.deepEqual(exit,{code:null,signal:'SIGKILL'},stderr);assert.equal(checkpoint?.mode,mode);
  const expected=mode==='unknown'?'native-exited-unknown-stores-retained':'native-exited-stores-closed';assert.equal(checkpoint.checkpoint,expected);
  const ino=statSync(join(dir,'owner.sqlite')).ino;
  const f=fixture('normal',dir);f.state.failPoll=true;
  try{
   const result=await f.run();assert.equal(result.nativeStarted,false);assert.equal(f.state.creates,0);assert.equal(f.state.polls,0);assert.equal(result.retained,false);
   assert.equal(result.state,mode==='unknown'?'claimed_without_answer_blocked':'reply_receipt_saved');
   assert.equal(statSync(join(dir,'owner.sqlite')).ino,ino);
   const trace=f.readTrace();assert.equal(trace.filter(x=>x.method==='session/new').length,1);assert.equal(trace.filter(x=>x.method==='session/prompt').length,1);
   if(mode!=='unknown')assert.equal(result.replyId,trace.find(x=>x.replyId).replyId);
  }finally{f.close();}
 }finally{
  if(!confirmed&&child){child.kill('SIGKILL');await new Promise(resolve=>child.once('exit',resolve));confirmed=true;}
  if(confirmed)rmSync(dir,{recursive:true,force:true});
 }
});
