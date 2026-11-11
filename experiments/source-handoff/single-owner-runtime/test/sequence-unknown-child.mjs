/** Synthetic unknown native outcome. Deliberate owned root exit retains DB contents.
 * Not graceful native/host cleanup evidence and not a claim that a real model stopped.
 */
import {fixture} from './fixture.mjs';
import {runApprovedSources} from '../source_sequence.ts';
const f=fixture('unknown',process.argv[2]);let native,second=false;
const original=f.options.launch;f.options.launch=async input=>{native=await original(input);return native};
const result=await runApprovedSources({roots:[()=>f.options,()=>{second=true;return f.options}]});
await native.exited;f.close();
await new Promise(resolve=>process.send({state:result.state,first:result.results[0],second,nativeChildExitObserved:true},resolve));
process.exit(0);
