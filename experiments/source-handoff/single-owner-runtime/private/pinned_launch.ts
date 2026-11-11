/** Actual source adapter for the production one-source root. No fake context fallback. */
import {prepareNativeDeployment,type TrustedInputs} from './native_deployment.ts';
import type {RuntimeOptions} from '../runtime.ts';
/** Factory is owner-approved code. It must materialize a fresh pinned native deployment
 * whose wake_policy equals this already-committed claim and whose localOwner policy is
 * independently authorized. A JSON manifest alone is not authorization/provenance.
 */
export function pinnedNativeLauncher(materialize:(input:Parameters<RuntimeOptions['launch']>[0])=>Promise<{
  manifestPath:string;manifestSha256:string;
  trusted:Omit<TrustedInputs,'binding'|'localOwner'|'closeStores'|'fixedWake'> & {
    localPolicy:NonNullable<TrustedInputs['localOwner']>['policy'];
  };
}>):RuntimeOptions['launch'] {
  return async input=>{
    const prepared=await materialize(input);
    const {localPolicy,...trusted}=prepared.trusted;
    const native=prepareNativeDeployment({manifestPath:prepared.manifestPath,manifestSha256:prepared.manifestSha256,
      trusted:{...trusted,localOwner:{hostOptions:input.stores.hostOptions,policy:localPolicy},
        closeStores:()=>input.stores.closeAfterRelease(),fixedWake:{claim:input.claim,activate:input.activate}}});
    return native.start();
  };
}
