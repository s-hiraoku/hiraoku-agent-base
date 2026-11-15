import process from "node:process";
import assert from "node:assert/strict";
import test from "node:test";
import {
  createDisplayController,
  bindingMatches,
} from "../experiments/hermes-desktop-adapter/desktop/controller.ts";
import {
  displayKey,
  projectDisplaySnapshot,
} from "../src/agent-notify/display-projection.ts";
const owner = {
  storedSessionId: "saved",
  connectionId: "connection",
  profile: "work",
  visible: true,
};
const binding = {
  binding_id: "binding",
  stored_session_id: "saved",
  connection_id: "connection",
  profile: "work",
  backend_namespace: "backend",
  profile_scope: "p",
  receiver_id: "receiver",
};
const key = { binding_id: "binding", sender_id: "sender", message_id: "msg" };
const notice = {
  ...key,
  text: "<script>untrusted</script>",
  stored_session_id: "saved",
  backend_namespace: "backend",
  profile_scope: "p",
  receiver_id: "receiver",
};
const state = {
  ...key,
  state: "shown",
  revision: 1,
  choices: [
    { choice: "accept", label: "Handle" },
    { choice: "later", label: "Later" },
  ],
};
const page = (states = [state], events = [notice]) => ({
  binding_id: "binding",
  events,
  next_cursor: "cursor",
  has_more: false,
  decision_states: states,
  decision_checked_keys: [key],
  decision_error_keys: [],
});
test("projection retains unrequested state, marks missing unavailable, recovers same revision and rejects rollback conflict", () => {
  const first = projectDisplaySnapshot([], page(), "binding");
  const missing = projectDisplaySnapshot(first, page([], []), "binding");
  assert.equal(missing[0].unavailable, true);
  const recovered = projectDisplaySnapshot(
    missing,
    page([state], []),
    "binding",
  );
  assert.equal(recovered[0].unavailable, false);
  assert.equal(
    projectDisplaySnapshot(
      first,
      { ...page([], []), decision_checked_keys: [] },
      "binding",
    )[0],
    first[0],
  );
  assert.throws(
    () =>
      projectDisplaySnapshot(
        first,
        page([{ ...state, state: "started" }], []),
        "binding",
      ),
    /revision/,
  );
  const newest = projectDisplaySnapshot(
    first,
    page([{ ...state, revision: 3, state: "started", choices: [] }], []),
    "binding",
  );
  assert.equal(
    projectDisplaySnapshot(newest, page([state], []), "binding")[0].decision
      .revision,
    3,
  );
  assert.throws(
    () =>
      projectDisplaySnapshot(
        first,
        page([], [{ ...notice, text: "changed" }]),
        "binding",
      ),
    /Immutable/,
  );
  assert.throws(
    () =>
      projectDisplaySnapshot(
        first,
        page([{ ...state, binding_id: "foreign" }]),
        "binding",
      ),
    /identity/,
  );
});
test("projection rejects contradictory or unrequested scopes and invalid choices atomically", () => {
  assert.throws(
    () =>
      projectDisplaySnapshot(
        [],
        { ...page(), decision_error_keys: [key] },
        "binding",
      ),
    /scope/,
  );
  assert.throws(
    () =>
      projectDisplaySnapshot(
        [],
        { ...page(), decision_checked_keys: [] },
        "binding",
      ),
    /state/,
  );
  assert.throws(
    () =>
      projectDisplaySnapshot(
        [],
        page([{ ...state, choices: [{ choice: "execute", label: "Run" }] }]),
        "binding",
      ),
    /state/,
  );
});
test("controller explicitly routes every call and records only a selected allowed choice", async () => {
  const calls = [],
    views = [];
  const controller = createDisplayController(
    async (path, opts) => {
      calls.push({ path, opts });
      return path === "/binding" ? binding : page();
    },
    owner,
    (view) => views.push(view),
  );
  assert.equal(await controller.decide(displayKey(key), "accept"), false);
  await controller.refresh();
  assert.equal(await controller.decide(displayKey(key), "execute"), false);
  assert.equal(await controller.decide(displayKey(key), "accept"), true);
  assert.equal(calls.filter((c) => c.path.endsWith("/decision")).length, 1);
  for (const call of calls)
    assert.deepEqual(call.opts.owner, {
      connectionId: "connection",
      profile: "work",
    });
  assert.deepEqual(calls.find((c) => c.path.endsWith("/decision")).opts.body, {
    binding_id: "binding",
    stored_session_id: "saved",
    connection_id: "connection",
    profile: "work",
    sender_id: "sender",
    message_id: "msg",
    choice: "accept",
  });
  assert.equal(views.at(-1).cards.length, 1);
  controller.dispose();
  assert.equal(await controller.decide(displayKey(key), "accept"), false);
});
test("wrong binding or hidden composer never performs query/action; disposed replies cannot publish", async () => {
  assert.equal(
    bindingMatches(binding, { ...owner, connectionId: "elsewhere" }),
    false,
  );
  const calls = [],
    views = [];
  const bad = createDisplayController(
    async (path) => {
      calls.push(path);
      return { ...binding, connection_id: "wrong" };
    },
    owner,
    (v) => views.push(v),
  );
  await bad.refresh();
  assert.deepEqual(calls, ["/binding"]);
  assert.equal(views.at(-1).cards.length, 0);
  let release;
  const pending = createDisplayController(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
    owner,
    (v) => views.push(v),
  );
  const work = pending.refresh();
  const n = views.length;
  pending.dispose();
  release(binding);
  await work;
  assert.equal(views.length, n);
  const hidden = createDisplayController(
    async () => {
      throw new Error("must not call");
    },
    { ...owner, visible: false },
    () => assert.fail(),
  );
  await hidden.refresh();
});

test("generated runtime plugin is deterministic and old SDK fails closed without API work", async () => {
  const { execFileSync } = await import("node:child_process");
  const { registerHooks } = await import("node:module");
  execFileSync(process.execPath, [
    "experiments/hermes-desktop-adapter/desktop/build.mjs",
    "--check",
  ]);
  const hook = registerHooks({
    resolve(specifier, context, next) {
      if (specifier === "@hermes/plugin-sdk")
        return {
          url: 'data:text/javascript,export const COMPOSER_AREAS={top:"composer.top"}',
          shortCircuit: true,
        };
      if (specifier === "react")
        return {
          url: "data:text/javascript,export const createElement=(type,props,...children)=>({type,props,children});export const useEffect=()=>{};export const useRef=()=>{};export const useState=()=>{};",
          shortCircuit: true,
        };
      return next(specifier, context);
    },
  });
  try {
    const { default: plugin } =
      await import("../experiments/hermes-desktop-adapter/desktop/plugin.js");
    const registrations = [];
    plugin.register({
      register: (c) => registrations.push(c),
      rest: () => assert.fail("unsupported SDK made API call"),
    });
    assert.equal(plugin.defaultEnabled, false);
    assert.equal(registrations[0].id, "unsupported");
    assert.match(registrations[0].render().children[0], /未対応/);
  } finally {
    hook.deregister();
  }
});

test("republished notices keep one card and terminal decisions never offer choices", async () => {
  const { canChoose } =
    await import("../experiments/hermes-desktop-adapter/desktop/controller.ts");
  const first = projectDisplaySnapshot(
    [],
    page([], [{ ...notice, event_id: "event1", received_at: "date1" }]),
    "binding",
  );
  const repeated = projectDisplaySnapshot(
    first,
    page([state], [{ ...notice, event_id: "event2", received_at: "date2" }]),
    "binding",
  );
  assert.equal(repeated.length, 1);
  assert.equal(repeated[0].notice.event_id, "event1");
  assert.equal(canChoose(repeated[0]), true);
  assert.equal(
    canChoose({ ...repeated[0], decision: { ...state, state: "queued" } }),
    false,
  );
});
test("retained requests fit compact UTF8 budget and oversized keys never starve later cards", async () => {
  const { selectRetainedKeys } =
    await import("../experiments/hermes-desktop-adapter/desktop/controller.ts");
  const cards = Array.from({ length: 50 }, (_, i) => ({
    notice: { ...notice, message_id: "\u0001".repeat(500) + i },
    unavailable: false,
  }));
  cards.unshift({
    notice: { ...notice, message_id: "x".repeat(513) },
    unavailable: false,
  });
  const seen = new Set();
  let offset = 0;
  for (let i = 0; i < 60; i++) {
    const result = selectRetainedKeys(cards, offset);
    offset = result.offset;
    assert.ok(Buffer.byteLength(JSON.stringify(result.keys)) <= 12000);
    for (const key of result.keys) seen.add(key.message_id);
  }
  assert.equal(seen.size, 50);
});

test("bounded display window keeps fresh requests and reports eviction instead of cursor deadlock", () => {
  const old = Array.from({ length: 1001 }, (_, i) => ({
    notice: { ...notice, message_id: `old${i}` },
    decision: { ...state, message_id: `old${i}`, state: "queued" },
    unavailable: false,
  }));
  let limited = false;
  const result = projectDisplaySnapshot(old, page(), "binding", () => {
    limited = true;
  });
  assert.equal(result.length, 1000);
  assert.equal(limited, true);
  assert.equal(result.at(-1).notice.message_id, "msg");
  const huge = Array.from({ length: 64 }, (_, i) => ({
    ...notice,
    message_id: `large${i}`,
    text: "x".repeat(131072),
  }));
  const bounded = projectDisplaySnapshot(
    [],
    { ...page([], huge), decision_checked_keys: [] },
    "binding",
    () => {},
  );
  assert.ok(Buffer.byteLength(JSON.stringify(bounded)) <= 8 * 1024 * 1024);
  assert.equal(bounded.at(-1).notice.message_id, "large63");
});
test("controller roundtrip matches real Python adapter fixture exactly", async () => {
  const { readFileSync } = await import("node:fs");
  const fixture = JSON.parse(
    readFileSync(
      new URL(
        "../experiments/hermes-desktop-adapter/tests/fixtures/roundtrip.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  let index = 0;
  const views = [];
  const controller = createDisplayController(
    async (path, opts) => {
      assert.deepEqual(opts.owner, {
        connectionId: fixture.owner.connectionId,
        profile: fixture.owner.profile,
      });
      if (path === "/binding") return fixture.binding;
      const operation = fixture.operations[index++];
      assert.equal(path, operation.path);
      assert.deepEqual(opts.body, operation.request);
      if (path.endsWith("/decision")) assert.equal(opts.timeoutMs, 60000);
      return operation.response;
    },
    { ...fixture.owner, visible: true },
    (v) => views.push(v),
  );
  await controller.refresh();
  await controller.refresh();
  const card = views.at(-1).cards[0];
  assert.equal(
    await controller.decide(displayKey(card.notice), "accept"),
    true,
  );
  assert.equal(index, 4);
  assert.equal(views.at(-1).cards[0].decision.state, "queued");
  controller.dispose();
});
