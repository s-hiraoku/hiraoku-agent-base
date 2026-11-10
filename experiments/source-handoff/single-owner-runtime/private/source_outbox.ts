/** Exact-source capability view over ONE identity-wide production outbox.
 * No second DB, producer, store implementation, schema, or state copy.
 */
import {sourceKey} from '../../../../src/adapter-policy/contract.ts';
import type {SQLiteOutbox} from '../../../../src/agent-sdk/sqlite-outbox.ts';
import type {SQLiteAnswerJournal} from '../../../../src/answer-intents/sqlite-journal.ts';
export function sourceBoundOutbox(outbox:SQLiteOutbox,answers:SQLiteAnswerJournal,input:{sender_id:string;message_id:string},check:()=>void):SQLiteOutbox{
 const source=Object.freeze(sourceKey.parse(input));
 if(outbox.agentId!==answers.agentId||typeof check!=='function')throw Error('source_outbox_invalid');
 const methods=new Map<PropertyKey,unknown>();
 const claim=(requested?:string)=>{
  check();const intent=answers.get(source,check);
  if(!intent){if(requested!==undefined)throw Error('source_outbox_reply_unavailable');return null;}
  if(requested!==undefined&&requested!==intent.reply_id)throw Error('source_outbox_wrong_reply');
  check();return outbox.claim(intent.reply_id);
 };
 return new Proxy(outbox,{
  get(target,key){
   if(key==='claim')return claim;
   // Use the real target as receiver, preserving getters and JS private-field brands.
   const value=Reflect.get(target,key,target);
   if(typeof value!=='function')return value;
   if(!methods.has(key))methods.set(key,value.bind(target));
   return methods.get(key);
  },
  set(){throw Error('source_outbox_readonly_view');},
  defineProperty(){throw Error('source_outbox_readonly_view');},
  deleteProperty(){throw Error('source_outbox_readonly_view');}
 });
}
