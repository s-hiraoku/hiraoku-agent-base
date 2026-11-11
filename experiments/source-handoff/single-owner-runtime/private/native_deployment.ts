/** Private deployment checks around the EXISTING ACP and external-owner APIs.
 * No token issuance, native identity issuer, grant, resume, or new wire protocol.
 * TrustedInputs is local composition input, never JSON/MCP/sessionId-derived evidence.
 * Its provenance/approval is a prerequisite, not something this verifier can invent.
 */
import { fixedWakePolicy, fixedWakeText, type FixedWakePolicy } from './fixed_wake_policy.ts';
import type { SourceLaunchRecord } from '../../../../src/owner-integrations/source-launch-journal.ts';
import type { ExternalOwnerControls } from '../../../../src/adapter-host/external-owner.ts';
import { createHash, randomUUID } from 'node:crypto';
import { constants, openSync, closeSync, readFileSync, fstatSync, statSync, lstatSync, realpathSync, type Stats } from 'node:fs';
import { isAbsolute, dirname, join, extname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createRequire, registerHooks } from 'node:module';
import type { ExternalOwnerDriver, OwnerLaunch, VerifiedOwnerBinding } from '../../../../src/adapter-host/external-owner.ts';

type Scope = Readonly<{
  domain_id: string; account_uid: number; audience: string; native_privilege: string;
  create_effects: readonly string[]; platform_trust: string; expires_at_ms: number;
}>;
type Manifest = {
  wake_policy: FixedWakePolicy;
  format: 1; interpreter: string; entry: string; lifetime_seconds: 60;
  parent_interpreter: string;
  files: Record<string, string>; parent_files: Record<string, string>;
  dynamic_links: Record<string, string>;
  absent_paths: string[];
  driver: string; owner: string;
  selection: null | { profile_home: string; session_cwd: string; request_id: string;
    endpoint: Record<string, unknown>; scope: Scope; control_paths: Record<string, Record<string, unknown>> };
  hab: null | { agent_id: string; actor_id: string; sender_id: string; message_id: string };
};

/** These must be supplied by the already-trusted operator/HAB composition.
 * The scope facts must be independently approved, including ALL effective viewers
 * and host operators, ticket privilege and server-side effects. The credential must
 * already be authorized and confined to this one launch/domain. No bearer is created
 * here and no synthetic context is accepted as evidence of a real native principal.
 * scopeSignal is that composition's revocation monitor, not a recipient assertion.
 */
export type TrustedInputs = Readonly<{
  profileHome: string; scope: Scope; scopeSignal: AbortSignal;
  binding?: VerifiedOwnerBinding;
  /** Alternative trusted-root composition; contexts are issued only after native verification. */
  localOwner?: LocalOwnerInput;
  bearerToken: string; serverName: string;
  closeStores(): void | Promise<void>;
  /** Root-owned NEW durable claim and local activation. Never read from native output. */
  fixedWake: Readonly<{claim:SourceLaunchRecord;activate(controls:ExternalOwnerControls):void}>;
}>;

/** Private root policy, never loaded from native output, a tool argument or Registry row.
 * The trusted bootstrap owns this approval and all store handles. JSON is policy data,
 * not proof of the bootstrap, native owner, or remote OAuth principal.
 */
export type LocalOwnerInput = Readonly<{
  hostOptions: VerifiedOwnerBinding['hostOptions'];
  policy: Readonly<{
    account_uid: number; agent_id: string; actor_id: string;
    source: Readonly<{ sender_id: string; message_id: string }>;
    audience: 'all-effective-selected-profile-viewers-and-host-operators';
    operations: readonly ['receive', 'send', 'inbox_read', 'answer_prepare', 'answer_inspect', 'answer_enqueue'];
    expires_at_ms: number;
  }>;
}>;

// Issuance is private to the existing native verification path below. There is no
// exported attest/verify API and no claim that the native product issues HAB objects.
const issuedContexts = new WeakMap<object, { launch: OwnerLaunch; policy: LocalOwnerInput['policy']; role: string }>();
function issueLocalBinding(local: LocalOwnerInput, launch: OwnerLaunch): VerifiedOwnerBinding {
  const policy = structuredClone(local.policy);
  const context = (role: string) => {
    const value = Object.create(null);
    Object.defineProperty(value, 'toJSON', { value() { throw Error('native_context_not_serializable'); } });
    Object.defineProperty(value, 'nonTransferable', { enumerable: true, value: Symbol(role) });
    Object.freeze(value);
    issuedContexts.set(value, { launch, policy, role });
    return value;
  };
  return Object.freeze({ hostOptions: local.hostOptions, actorId: policy.actor_id,
    source: Object.freeze({ ...policy.source }),
    verifiedRecipientContext: context('recipient'), verifiedOperatorContext: context('operator') });
}

function require(value: unknown): asserts value {
  if (!value) throw Error('native_deployment_rejected');
}
const digest = (data: Buffer) => createHash('sha256').update(data).digest('hex');
const stamp = (s: Stats) =>
  [s.dev, s.ino, s.size, s.mtimeMs, s.ctimeMs, s.mode, s.uid].join(':');
const equal = (a: unknown, b: unknown): boolean => {
  if (a === b) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
  const left = a as Record<string, unknown>, right = b as Record<string, unknown>;
  const ak = Object.keys(left), bk = Object.keys(right);
  return ak.length === bk.length && ak.every(k => bk.includes(k) && equal(left[k], right[k]));
};

/** Shape-only validation. The child compares these independent pins before every dial.
 * Never sample the machine to fill a missing pin or choose a different profile.
 */
function validateControlPins(s: NonNullable<Manifest['selection']>) {
  require(equal(Object.keys(s.endpoint).sort(), ['profile_id', 'instance_id', 'authority_epoch',
    'runtime_protocol', 'api_origin', 'control_home', 'code_sha'].sort()));
  const home = s.profile_home, control = s.endpoint.control_home;
  const absolute = (v: unknown): v is string => typeof v === 'string' && v.startsWith('/') &&
    !/[\x00-\x1f\x7f]/.test(v) && !v.split('/').some((p, i) => i > 0 && ['', '.', '..'].includes(p));
  require(absolute(home) && absolute(control));
  require(home === control || dirname(home) === join(control, 'profiles'));
  const paths = { profile_home: home, profile_lock: join(home, 'gateway.lock'),
    control_home: control, control_lock: join(control, 'gateway.lock'), control_socket: join(control, 'gateway.sock') };
  const pins = s.control_paths;
  require(pins && equal(Object.keys(pins).sort(), Object.keys(paths).sort()));
  for (const [key, path] of Object.entries(paths)) {
    const pin = pins[key];
    require(pin && equal(Object.keys(pin).sort(), ['path', 'dev', 'ino', 'uid', 'mode', 'nlink'].sort()));
    require(pin.path === path && ['dev', 'ino', 'uid', 'mode', 'nlink'].every(k =>
      typeof pin[k] === 'number' && Number.isSafeInteger(pin[k]) && (pin[k] as number) >= 0));
    require((pin.ino as number) > 0 && (pin.nlink as number) > 0 && pin.uid === s.scope.account_uid);
    require(key.endsWith('_home') ? pin.mode === 0o40700 : key.endsWith('_lock') ?
      pin.mode === 0o100600 && pin.nlink === 1 : pin.mode === 0o140600);
  }
  if (home === control) {
    require(equal(pins.profile_home, pins.control_home) && equal(pins.profile_lock, pins.control_lock));
  }
  require(s.endpoint.runtime_protocol === 1 && typeof s.endpoint.authority_epoch === 'number' &&
    Number.isSafeInteger(s.endpoint.authority_epoch) && s.endpoint.authority_epoch > 0);
  require(['profile_id', 'instance_id'].every(k => typeof s.endpoint[k] === 'string' &&
    (s.endpoint[k] as string).length > 0 && (s.endpoint[k] as string).length <= 512 &&
    !/[\x00-\x1f\x7f]/.test(s.endpoint[k] as string)));
  const origin = typeof s.endpoint.api_origin === 'string' && /^http:\/\/127\.0\.0\.1:([1-9][0-9]{0,4})$/.exec(s.endpoint.api_origin);
  require(origin && Number(origin[1]) <= 65535);
}

/** Exact bytes through a no-follow fd. No profile or credential files are read. */
export function readPinned(path: string, sha: string): Buffer {
  require(typeof path === 'string' && isAbsolute(path) && realpathSync(path) === path);
  require(typeof sha === 'string' && /^[a-f0-9]{64}$/.test(sha));
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = fstatSync(fd);
    require(before.isFile() && !(before.mode & 0o022) && before.size <= 256 * 1024 * 1024);
    require(before.uid === 0 || before.uid === process.getuid?.());
    const data = readFileSync(fd);
    require(stamp(before) === stamp(fstatSync(fd)) && digest(data) === sha);
    return data;
  } finally { closeSync(fd); }
}

/** One dedicated parent's fresh module graph, not a claim about arbitrary cached JS.
 * Reject pinned CJS modules already in cache. Resolve every new dependency through
 * the inventory, and use a unique ESM identity so stale ESM evaluations aren't reused.
 * Hooks stay active for the finite owner lifetime, including late dynamic imports.
 */
function pinOwnerImports(pins: Record<string, string>) {
  const cache = createRequire(process.execPath).cache;
  require(!Object.keys(cache).some(path => path in pins));
  const generation = randomUUID();
  const pinnedPath = (url: string) => {
    const value = new URL(url);
    require(value.protocol === 'file:' && !value.hash);
    const path = fileURLToPath(value);
    require(path in pins);
    return path;
  };
  const formatFor = (path: string) => {
    const extension = extname(path);
    if (extension === '.mjs') return 'module';
    if (extension === '.cjs') return 'commonjs';
    if (extension === '.json') return 'json';
    require(extension === '.js' || extension === '.ts');
    let directory = dirname(path);
    for (;;) {
      const scope = join(directory, 'package.json');
      if (lstatSync(scope, { throwIfNoEntry: false })) {
        require(scope in pins);
        const kind = JSON.parse(readPinned(scope, pins[scope]).toString('utf8')).type;
        require(kind === undefined || kind === 'commonjs' || kind === 'module');
        const base = kind === 'module' ? 'module' : 'commonjs';
        return extension === '.ts' ? `${base}-typescript` : base;
      }
      require(dirname(directory) !== directory); // No implicit unreviewed package scope.
      directory = dirname(directory);
    }
  };
  return registerHooks({
    resolve(specifier, context, nextResolve) {
      const result = nextResolve(specifier, context);
      if (result.url.startsWith('node:')) return result;
      const path = pinnedPath(result.url);
      readPinned(path, pins[path]);
      const url = pathToFileURL(path);
      url.searchParams.set('hab_private_owner', generation);
      return { ...result, url: url.href };
    },
    load(url, context, nextLoad) {
      if (url.startsWith('node:')) return nextLoad(url, context);
      const path = pinnedPath(url), source = readPinned(path, pins[path]);
      // Execute verified bytes with the pinned package scope, never nextLoad's
      // raced source/format. Sync CJS hooks may otherwise report no format.
      return { format: formatFor(path), source, shortCircuit: true };
    },
  });
}

/** Prepare only: no native import, child spawn, listener, token or stores created.
 * The caller pins the manifest hash independently, rather than reading a hash beside
 * an untrusted file and calling that verification. Missing trusted inputs fail here.
 */
export function prepareNativeDeployment(options: {
  manifestPath: string; manifestSha256: string; trusted: TrustedInputs;
}) {
  const raw = readPinned(options.manifestPath, options.manifestSha256);
  const m: Manifest = JSON.parse(raw.toString('utf8'));
  require(realpathSync(process.execPath) === m.parent_interpreter && process.versions.node === '26.13.0');
  require(process.execArgv.length === 0 && !process.env.NODE_OPTIONS && !process.env.NODE_PATH);
  const t = options.trusted, s = m.selection, h = m.hab;
  require(t?.fixedWake && typeof t.fixedWake.activate === 'function');
  const fixed = t.fixedWake, wakePolicy = fixedWakePolicy(fixed.claim);
  require(equal(m.wake_policy, wakePolicy));
  require(m.format === 1 && m.lifetime_seconds === 60 && s && h && t);
  require(s.profile_home === t.profileHome && equal(s.scope, t.scope));
  require(s.scope.account_uid === process.getuid?.() && s.scope.expires_at_ms >= Date.now() + 60000);
  require(s.scope.audience === 'all-effective-selected-profile-viewers-and-host-operators');
  require(s.scope.native_privilege === 'interactive-profile-operator');
  require(s.scope.platform_trust === 'same-user-host-operators-and-macos-system-runtime');
  require(equal(s.scope.create_effects, ['durable-session', 'profile-config-and-secrets',
    'eager-mcp-discovery', 'native-hooks-and-inventory', 'possible-background-update-check']));
  require(t.scopeSignal && !t.scopeSignal.aborted && typeof t.closeStores === 'function');
  require(/^[A-Za-z0-9_-]{32,256}$/.test(t.bearerToken) && /^[A-Za-z0-9_-]{1,96}$/.test(t.serverName));
  require(m.entry === join(dirname(options.manifestPath), 'native_entry.py'));
  require(isAbsolute(m.interpreter) && isAbsolute(s.session_cwd));
  require(s.endpoint.code_sha === '6705c8c634d83a2f2918aa5ec45e7f8f20c20dc7');
  validateControlPins(s);
  require(Boolean(t.binding) !== Boolean(t.localOwner));
  let binding = t.binding;
  const local = t.localOwner;
  const localPolicy = local ? structuredClone(local.policy) : undefined;
  const hostOptions = binding?.hostOptions ?? local!.hostOptions;
  const expectedSource = Object.freeze({ sender_id: h.sender_id, message_id: h.message_id });
  require(equal(expectedSource,wakePolicy.source));
  const checkLocal = () => {
    if (!local || !localPolicy) return;
    require(t.localOwner === local && !t.binding && local.hostOptions === hostOptions && equal(local.policy, localPolicy));
    require(localPolicy.account_uid === process.getuid?.() && localPolicy.account_uid === s.scope.account_uid);
    require(localPolicy.agent_id === h.agent_id && localPolicy.actor_id === h.actor_id);
    require(equal(localPolicy.source, expectedSource) && localPolicy.audience === s.scope.audience);
    require(equal(localPolicy.operations, ['receive', 'send', 'inbox_read', 'answer_prepare', 'answer_inspect', 'answer_enqueue']));
    require(Number.isSafeInteger(localPolicy.expires_at_ms) && localPolicy.expires_at_ms > Date.now() &&
      localPolicy.expires_at_ms <= s.scope.expires_at_ms);
    require([hostOptions.owner, hostOptions.control, hostOptions.inbox, hostOptions.outbox,
      hostOptions.budget, hostOptions.answer_intents].every(store => store?.agentId === h.agent_id));
    // Authenticity/integrity and receipt confirmation come from the root-owned
    // durable inbox, not event projections or caller-supplied message envelopes.
    hostOptions.inbox.withEntry(h.sender_id, h.message_id, entry => {
      require(entry.receipt_confirmed === true && entry.sender_id === h.sender_id &&
        entry.message.message_id === h.message_id && entry.message.recipient_id === h.agent_id &&
        entry.message.kind === 'question' && entry.message.in_reply_to === null &&
        entry.message.body.parts.every(part => part.type === 'text'));
    });
  };
  checkLocal();
  if (binding) {
    require(binding.verifiedRecipientContext && binding.verifiedOperatorContext &&
      binding.verifiedRecipientContext !== binding.verifiedOperatorContext);
    require(binding.actorId === h.actor_id && equal(binding.source, expectedSource));
  }
  require(hostOptions.control.agentId === h.agent_id && hostOptions.owner.agentId === h.agent_id &&
    hostOptions.control.snapshot().paused);
  const pins = { ...m.files, ...m.parent_files, [options.manifestPath]: options.manifestSha256 };
  require(m.interpreter in pins && m.parent_interpreter in pins && m.entry in pins && m.driver in pins && m.owner in pins);
  const recorded = new Map<string, string>();
  const checkFiles = (full: boolean) => {
    for (const path of m.absent_paths) require(isAbsolute(path) && !lstatSync(path, {throwIfNoEntry: false}));
    for (const [path, sha] of Object.entries(pins)) {
      if (full) readPinned(path, sha);
      require(realpathSync(path) === path);
      const now = stamp(statSync(path));
      if (recorded.has(path)) require(recorded.get(path) === now); else recorded.set(path, now);
    }
    for (const [alias, target] of Object.entries(m.dynamic_links)) require(realpathSync(alias) === target);
  };
  checkFiles(true);
  // Copy references/values now. Later caller mutation cannot swap accepted inputs.
  const token = t.bearerToken, name = t.serverName, signal = t.scopeSignal, closeStores = t.closeStores;
  const initialBinding = binding;
  const initialContexts = binding ? [binding.verifiedRecipientContext, binding.verifiedOperatorContext] : undefined;
  const stores = [hostOptions, hostOptions.owner, hostOptions.control, hostOptions.inbox,
    hostOptions.outbox, hostOptions.budget, hostOptions.answer_intents, hostOptions.transport, hostOptions.managedTransport, hostOptions.network];
  const trustedScope = structuredClone(s.scope);
  const controller = new AbortController();
  let activatedPhase = false;
  let wakeResult: Readonly<{stopReason:string}> | null = null;
  let consumed = false, currentLaunch: OwnerLaunch | undefined;
  let verifierUsed = false, timer: ReturnType<typeof setInterval> | undefined;
  let importHooks: ReturnType<typeof registerHooks> | undefined;
  const check = (full = false) => {
    require(!controller.signal.aborted && !signal.aborted && Date.now() < trustedScope.expires_at_ms);
    require(equal(t.scope, trustedScope) && t.profileHome === s.profile_home && t.binding === initialBinding);
    checkLocal();
    require([hostOptions, hostOptions.owner, hostOptions.control, hostOptions.inbox,
      hostOptions.outbox, hostOptions.budget, hostOptions.answer_intents, hostOptions.transport, hostOptions.managedTransport, hostOptions.network].every((v, i) => v === stores[i]));
    if (binding) {
      require(equal(binding.source, expectedSource) && binding.actorId === h.actor_id && binding.hostOptions === hostOptions);
      if (initialContexts) require(binding.verifiedRecipientContext === initialContexts[0] && binding.verifiedOperatorContext === initialContexts[1]);
      else {
        for (const [context, role] of [[binding.verifiedRecipientContext, 'recipient'], [binding.verifiedOperatorContext, 'operator']] as const) {
          const issued = issuedContexts.get(context);
          require(issued && issued.launch === currentLaunch && issued.role === role && equal(issued.policy, localPolicy));
        }
      }
    }
    // Paused is mandatory until the verified receipt binding invokes our local callback.
    // After that transition, the existing host epoch/permission controls own activation.
    require(t.fixedWake === fixed && equal(fixedWakePolicy(fixed.claim),wakePolicy));
    if (!activatedPhase) require(hostOptions.control.snapshot().paused);
    checkFiles(full);
  };
  const stopMonitoring = () => {
    if (timer) clearInterval(timer);
    signal.removeEventListener('abort', lost);
  };
  const dispose = () => { stopMonitoring(); importHooks?.deregister(); importHooks = undefined; };
  const lost = () => { controller.abort(); stopMonitoring(); };
  const verifyDeployment = async ({ sessionId, launch }: { sessionId: string; launch: OwnerLaunch }) => {
    check(true);
    require(!verifierUsed && currentLaunch === launch && !launch.signal.aborted);
    require(launch.mcp.name === name && launch.mcp.headers.Authorization === `Bearer ${token}`);
    require(typeof sessionId === 'string' && sessionId.length > 0); // Correlation only.
    verifierUsed = true;
    // Trust comes from pinned entry + exact owned driver pipes + native same-client
    // checks, AND external scope/provenance. Never derive identity from sessionId.
    // The existing verifier has now checked the actual pinned process/deployment,
    // owned launch pipes, same-client native create and explicit local scope policy.
    // Remote OAuth assignment remains a separate native-transport check.
    if (!binding) { require(local); binding = issueLocalBinding(local, launch); }
    check();
    return binding;
  };
  return Object.freeze({
    /** This is the only LIVE operation, deliberately not called by offline tests. */
    async start() {
      require(!consumed); consumed = true; check(true);
      signal.addEventListener('abort', lost, { once: true });
      timer = setInterval(() => { try { check(); } catch { lost(); } }, 250);
      let driver: ExternalOwnerDriver | undefined;
      try {
        importHooks = pinOwnerImports(pins);
        const { createAcpOwnerDriver } = await import(pathToFileURL(m.driver).href);
        const { startExternalOwner } = await import(pathToFileURL(m.owner).href);
        check(true);
        const acp = createAcpOwnerDriver({ executable: m.interpreter,
          args: ['-I', '-S', '-B', m.entry], cwd: dirname(m.entry), sessionCwd: s.session_cwd,
          requestTimeoutMs: 10000, shutdownTimeoutMs: 1500, lifetimeMs: 60000,
          scopeSignal: controller.signal, verifyDeployment,
          fixedWake: {text:fixedWakeText(wakePolicy),timeoutMs:40000} });
        driver = Object.freeze({ ...acp, create(launch: OwnerLaunch) {
          check(true); require(!currentLaunch); currentLaunch = launch;
          require(launch.mcp.name === name && launch.mcp.headers.Authorization === `Bearer ${token}`);
          return acp.create(launch);
        } });
        const owner = await startExternalOwner({ driver, bearerToken: token, serverName: name,
          lifetimeMs: 60000, shutdownTimeoutMs: 5000, ownerSignal: controller.signal,
          closeStores, onBound: async (controls: ExternalOwnerControls) => {
            check(true);require(!activatedPhase && !controls.signal.aborted);
            activatedPhase=true;
            fixed.activate(controls);
            const state=controls.status();
            require(!state.paused && state.owner==='held' && !state.running && !state.draining);
            check();wakeResult=await acp.wake();
          } });
        // Retain the import guard on uncertain cleanup, like the owned stores.
        void owner.completion.then(dispose, stopMonitoring);
        return Object.freeze({ owner, exited: acp.exited, wakeResult: () => wakeResult });
      } catch {
        lost();
        if (!driver) dispose();
        else await driver.close().then(dispose, stopMonitoring);
        throw Error('native_deployment_start_failed');
      }
    },
    // Pure/local verification for deployment diagnostics. Does not launch or bind.
    check: () => check(true),
  });
}
