/** Pure structured plan. Never probes stores, reads secrets or changes a service. */
export function cutoverPlan(){return Object.freeze({
 format:1,executableMode:'SOURCE_OFFLINE_ONLY',readyForLive:false,
 syntheticReference:{identity:'worker@example.invalid',ownerDatabase:'same approved owner database; never replace lineage',requiresFreshApproval:true},
 prerequisites:[
  {id:'approval-native',status:'missing',requires:'Explicit profile selection, exact native revision/executable, all effective viewers and same-UID host operators, create/session/model actions, allowed native tools beyond six HAB methods, lifetime, cost and external message recipient/content scope.'},
  {id:'native-provenance',status:'missing',requires:'Fresh exact endpoint/control-path pins, authentic native deployment and local root policy, claim-bound fresh deployment.json, independent full composed source manifest and official authentication/ticket authorization.'},
  {id:'capability',status:'missing',requires:'Action-time approval for new dedicated launch-exclusive MCP credential creation and delivery; never copy relay OAuth bearer. This package creates none.'},
  {id:'oauth-hook',status:'pending-review-and-approved-install',requires:'Independent review and approved deployment of metadata_client_factory hook into an isolated supported Hermes runtime; unchanged installed Hermes cannot meet managed-transport contract.'},
  {id:'oauth-principal',status:'missing',requires:'Official OAuth-owned whoami and assignment validation for exact resource/address/agent. Registry entries alone are not native contexts.'},
  {id:'stores',status:'missing',requires:'Approved existing paths, actual key loading route (no key in argv/env/source), unchanged existing schemas/policies, shared control/inbox/budget/claims lineage and ONE identity-wide answer journal/action outbox with an exact-source capability view.'},
  {id:'service-cutover',status:'not-authorized',requires:'Approval to pause/unload old service, positively observe all owned receive work drained and process exit, preserve receive-only semantics in new same-process root, then reopen SAME owner.sqlite.'},
  {id:'capacity',status:'blocking-for-everyday-operation',requires:'Existing finite budget policy is HMAC-bound; outbox capacity is configured separately. Never silently widen or reset either. Any capacity change needs separate accepted design and authorization, preserving original lineage.'},
  {id:'operational',status:'missing',requires:'Current exact-head checks, bounded root watchdog, service registration/restart policy, source-rotation policy, remaining native/production E2E and operator acceptance.'}
 ],
 sequence:[
  'Review exact bytes and all affected formal design citations. Do not describe this private source snapshot as merged/CI/production ready.',
  'Approve and stage native hook, full composed source/dependency manifest, actual root factory, credential handling and one exact initial text-only question policy. No live action occurs during dry-run.',
  'Record pre-cutover service identity/release/config pointers and immutable store policies without exporting secrets. Preserve current receiver functionality and all pending original ACK/outbox records.',
  'Request approved receiver pause at exact current epoch, stop its supervisor, wait boundedly for running=false and draining=0, release owner through the old host, close handles and observe old process exit. Failed drain/exit stops cutover.',
  'With no concurrent host, take approved consistent business-store backup. Do not copy owner.sqlite as a new coordination identity or roll it back. Keep existing owner/control/inbox/budget paths; verify original source/answer/outbox ledger lineage.',
  'If broader capacity is needed, run ONLY a separately approved tested migration. Existing code has no safe generic budget expansion API. A new empty budget is never an acceptable migration.',
  'Start new root once, acquire SAME owner DB, reconstruct receiver with official OAuth-owned managed transport, preserve saved pause/epoch and all pending ACKs. Explicit root permission controls resume.',
  'Host receive saves original message + ACK request before ACK. Guarded host inbox metadata selects only exact approved source. Durable HMAC launch claim is committed before native create.',
  'Pause/drain/release/close receiver phase. Reopen SAME owner DB with shared stores and the same identity-wide answer outbox/journal, with claim restricted to the exact journal reply ID. Pinned native create verifies current discovery receipt, contexts and scope, then trusted local activation changes permission/resume at exact epoch.',
  'Send one canonical fixed IDs-only wake, never external body as owner instructions. Native MCP reads untrusted data and persists answer under current native policy. Native end_turn does not imply receipt or delivery.',
  'Known settled native cleanup closes owned channels and host, releases owner and closes stores. Reopen SAME owner DB for bounded journal/outbox reconciliation, preserving original reply IDs/expiry/leases until saved ACK.',
  'Next receiver run uses the same stores and restores receive functionality. Uncertain native outcome blocks relaunch. Finite rotation can follow only to an explicitly approved source after observed clean native completion and saved ACK. Existing-claim restart needs separate trusted native-settlement evidence; ACK alone cannot advance. No service restart, grant expansion or budget reset is implicit.'
 ],
 rollback:[
  'If staging/preconditions fail, leave old service untouched.',
  'After a quiesced cutover, stop/drain/release/close new root and confirm its owned process/children exited before restarting old receiver. If any outcome is unknown, keep paused and retain state for reconciliation.',
  'Restore only the approved code/service pointer to known old release. Do not restore stale business DB snapshots or erase claims to force retry. Old receiver must continue using same owner/control/inbox and original ACK records.',
  'After approved schema/capacity migration, old binary compatibility must be proven. Otherwise rollback is code-disabled/paused with data retained, not blind database downgrade.',
  'Reconcile remote commits through original IDs and official status. Viewer close or process exit is not evidence that native model work stopped.'
 ],
 recovery:{
  existingClaimNoAnswer:'Never recreate native session/prompt. Keep claim; independently investigate same native operation if permitted.',
  prepared:'Inspect durable intent, enqueue exactly saved reply through common persistent budget; no native call.',
  enqueued:'Send/status only same durable reply ID/content/deadline and normal lease/backoff; no model rerun.',
  unknown:'Fence/retain owner and stores while local work may exist. Process crash releases local locks only. On restart existing claim blocks another native create.',
  insufficientBudget:'Pause/deny and report capacity. Do not purge, reset, rotate budget or silently expand policy.',
  inboundAckLost:'Keep saved body and original ACK journal; bounded receiver recovery, never synthesize receipt-confirmed metadata.'
 },
 evidenceLimits:['Archive only: no current runtime or aggregate tests executed.', 'Synthetic fixtures do not prove native identity, model, approval or OAuth behavior.', 'Deployment prerequisites and current authorization remain unverified.']
});}
