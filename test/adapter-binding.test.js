import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bindingIdentity } from "../src/agent-notify/binding.ts";
import {
  HermesDesktopScreen,
  hermesDesktopTarget,
} from "../src/agent-notify/hermes-desktop.ts";
import { JsonlScreen } from "../src/agent-notify/jsonl-screen.ts";
import { SQLiteNotices } from "../src/agent-notify/sqlite-notices.ts";

test("all connection, recipient, profile and session boundaries affect identity", () => {
  const binding = {
    product: "sample",
    connection_id: "backend",
    recipient_id: "recipient",
    session_id: "session",
    profile: "profile",
  };
  for (const key of Object.keys(binding))
    assert.notEqual(
      bindingIdentity(binding),
      bindingIdentity({ ...binding, [key]: "other" }),
    );
  assert.equal(bindingIdentity(binding), bindingIdentity({ ...binding }));
  assert.throws(
    () => bindingIdentity({ ...binding, recipient_id: "" }),
    /invalid_agent_binding/,
  );
  assert.notEqual(
    bindingIdentity({ ...binding, product: "a:b", connection_id: "c" }),
    bindingIdentity({ ...binding, product: "a", connection_id: "b:c" }),
  );
});

test("Hermes stores cannot be reused after a backend or recipient rebind", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "hab-binding-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const binding = {
    session_id: "s",
    profile: "p",
    backend_namespace: "b",
    profile_scope: "scope",
    receiver_id: "r",
  };
  const path = join(dir, "notices.sqlite");
  const store = new SQLiteNotices(path, hermesDesktopTarget(binding));
  store.close();
  for (const key of Object.keys(binding))
    assert.throws(
      () =>
        new SQLiteNotices(
          path,
          hermesDesktopTarget({ ...binding, [key]: "different" }),
        ),
      /notices_target_mismatch/,
    );
});

test("file adapters report publication, not render or model admission", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "hab-publication-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const message = {
    message_id: "m",
    sender_id: "sender",
    from: null,
    kind: "question",
    thread_id: "t",
    in_reply_to: null,
    sent_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 60000).toISOString(),
    display: "notice",
    handoff_prompt: "prompt",
  };
  const screens = [
    new JsonlScreen(join(dir, "generic.jsonl"), "sample"),
    new HermesDesktopScreen(join(dir, "hermes.jsonl"), {
      session_id: "s",
      profile: "p",
      backend_namespace: "b",
      profile_scope: "scope",
      receiver_id: "r",
    }),
  ];
  for (const screen of screens) {
    assert.equal(await screen.show(message), "published");
    assert.equal(screen.capabilities.display_acknowledgement, false);
    assert.equal(screen.capabilities.handoff, "unsupported");
    assert.equal(await screen.handoff(message), "unsupported");
  }
});

// Synthetic product drivers only: these are not real Hermes/Gemini integrations.
for (const product of [
  "hermes-contract-fixture",
  "gemini-contract-fixture",
  "future-contract-fixture",
]) {
  test(`${product}: thin driver shares receipt/choice logic without model work on arrival`, async (t) => {
    const { ProductScreen } =
      await import("../src/agent-notify/product-screen.ts");
    const { ReceiptNotifier } = await import("../src/agent-notify/notifier.ts");
    const dir = mkdtempSync(join(tmpdir(), "hab-conformance-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const binding = {
      product,
      connection_id: "fixture",
      recipient_id: "recipient",
      session_id: "existing",
    };
    const target = bindingIdentity(binding);
    let currentSession = binding.session_id;
    let admitted = 0;
    let markedRead = 0;
    const message = {
      message_id: "m",
      sender_id: "sender",
      from: null,
      kind: "question",
      thread_id: "t",
      in_reply_to: null,
      sent_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 60000).toISOString(),
      display: "notice",
      handoff_prompt: "prompt",
    };
    const screen = new ProductScreen({
      path: join(dir, "events.jsonl"),
      target,
      handoff_capability: "bound-session",
      handoff: async (received) => {
        assert.equal(received.handoff_prompt, "prompt");
        if (currentSession !== binding.session_id) return "unsupported";
        admitted++;
        return "queued";
      },
    });
    const store = new SQLiteNotices(":memory:", target);
    t.after(() => store.close());
    const notifier = new ReceiptNotifier({
      screen,
      store,
      hab: {
        peek: async () => ({ messages: [message], next_cursor: null }),
        markRead: async () => {
          markedRead++;
          return true;
        },
      },
    });
    await notifier.check();
    await notifier.check();
    assert.equal(admitted, 0);
    assert.equal(markedRead, 0);
    assert.equal(store.all().length, 1);
    assert.equal((await notifier.decide("m", "accept")).state, "queued");
    assert.equal((await notifier.decide("m", "accept")).changed, false);
    assert.equal(admitted, 1);
    assert.equal(markedRead, 1);
    currentSession = "another-conversation";
    const another = { ...message, message_id: "m2" };
    store.insertShowing(another, Date.now());
    store.transition(another, ["showing"], "shown", Date.now());
    assert.equal((await notifier.decide("m2", "accept")).state, "unsupported");
    assert.equal(admitted, 1);
  });
}
