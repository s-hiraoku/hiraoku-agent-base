/** Owned fixture parent SIGKILL only after its own ACP child exit is observed. */
import {fixture} from './fixture.mjs';
const mode=process.argv[2],dir=process.argv[3];const f=fixture(mode,dir);
const launch=f.options.launch;
f.options.launch=async input=>{
 const native=await launch(input);
 const ready=native.owner.ready.then(async value=>{
   await native.owner.stop();await native.owner.completion;await native.exited;
   await new Promise(resolve=>process.send({checkpoint:'native-exited-stores-closed',mode},resolve));
   process.kill(process.pid,'SIGKILL');return value;
 },async()=>{
   await native.owner.stop().catch(()=>{});await native.owner.completion.catch(()=>{});await native.exited;
   await new Promise(resolve=>process.send({checkpoint:'native-exited-unknown-stores-retained',mode},resolve));
   process.kill(process.pid,'SIGKILL');throw Error('unreachable');
 });
 return {...native,owner:{...native.owner,ready}};
};
await f.run();process.exit(9);
