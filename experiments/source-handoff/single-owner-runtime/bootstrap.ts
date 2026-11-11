/** User-owned entry point. Default is a pure plan with zero native/store/network effects.
 * --run executes an independently approved local root factory, not JSON permission flags.
 */
import {readFileSync,lstatSync,realpathSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {isAbsolute} from 'node:path';
import {pathToFileURL} from 'node:url';
import {cutoverPlan} from './cutover.ts';
import {runOneSource,continueReceiving,type RuntimeOptions} from './runtime.ts';
async function main(){
 const args=process.argv.slice(2);
 if(args.length===0||(args.length===1&&args[0]==='--dry-run')){process.stdout.write(JSON.stringify(cutoverPlan(),null,2)+'\n');return;}
 if(args.length!==3||args[0]!=='--run')throw Error('usage_dry_run_or_approved_factory');
 const [,path,expected]=args;
 if(!isAbsolute(path)||realpathSync(path)!==path||!/^([a-f0-9]{64})$/.test(expected))throw Error('approved_factory_pin_required');
 const stat=lstatSync(path);if(!stat.isFile()||stat.mode&0o022||stat.uid!==process.getuid?.())throw Error('private_owned_factory_required');
 if(createHash('sha256').update(readFileSync(path)).digest('hex')!==expected)throw Error('factory_pin_mismatch');
 // This pin is not a sandbox. The owner must approve the root's entire dependency closure.
 const controller=new AbortController();for(const signal of ['SIGINT','SIGTERM'] as const)process.once(signal,()=>controller.abort());
 const module=await import(pathToFileURL(path).href);
 if(typeof module.createRuntimeOptions!=='function')throw Error('trusted_root_factory_required');
 const options:RuntimeOptions=await module.createRuntimeOptions(controller.signal);
 if(options.signal!==controller.signal)throw Error('root_scope_signal_mismatch');
 const result=await runOneSource(options);process.stdout.write(JSON.stringify(result)+'\n');
 if(!result.retained&&options.receiverContinuation&&!controller.signal.aborted){
  const receiver=await continueReceiving(options);process.stdout.write(JSON.stringify({receiver})+'\n');
  if(receiver.retained){process.exitCode=2;await new Promise<void>(()=>{setInterval(()=>{},60000);});}
 }
 if(result.retained){
   process.exitCode=2;
   // Keep the owner process alive rather than silently closing retained handles at main return.
   // Operator/watchdog may terminate it after owned children are independently settled.
   await new Promise<void>(()=>{setInterval(()=>{},60000);});
 }
 if(!['reply_receipt_saved','waiting_for_source'].includes(result.state))process.exitCode=2;
}
main().catch(()=>{process.stderr.write('single_owner_runtime_blocked\n');process.exitCode=2;});
