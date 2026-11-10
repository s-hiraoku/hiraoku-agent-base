/** A composition example, not an approved deployment. The actual owner module obtains
 * the exact typed inputs via its authorized custody/policy paths; never by scanning profiles.
 */
import {createProductionRoot,type ProductionRootInputs} from './production_root.ts';
/** Concrete construction once the owner supplies validated inputs. This has no fake fallback. */
export function createApprovedRuntime(inputs:ProductionRootInputs){return createProductionRoot(inputs);}
/** The CLI must not infer missing live selection, authorization, credential or store values. */
export async function createRuntimeOptions(_signal:AbortSignal):Promise<never>{
 throw Error('provide_owner_approved_ProductionRootInputs_to_createApprovedRuntime');
}
