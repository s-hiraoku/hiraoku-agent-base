import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

const hook = registerHooks({
  resolve(specifier, context, next) {
    const source =
      specifier === "@hermes/plugin-sdk"
        ? 'export const Button="button";'
        : specifier === "react"
          ? "export const createElement=(type,props,...children)=>({type,props,children});export const useEffect=()=>{};export const useRef=()=>{};export const useState=()=>{};"
          : null;
    return source === null
      ? next(specifier, context)
      : {
          url: `data:text/javascript,${source}`,
          shortCircuit: true,
        };
  },
});
const { ReceivedMessages } =
  await import("../experiments/hermes-desktop-adapter/desktop/plugin.js");
hook.deregister();

function card(state, id = state) {
  return {
    notice: {
      binding_id: "binding",
      sender_id: "sender",
      message_id: id,
      text: `body-${id}`,
    },
    decision: {
      state,
      revision: 1,
      choices: [{ choice: "accept", label: "対応する" }],
    },
    unavailable: false,
  };
}
function tree(cards, options = {}) {
  return ReceivedMessages({
    view: { cards, error: "", busy: false, ...options },
    visible: true,
    onChoose: () => assert.fail("render must not perform a decision"),
  });
}
function visibleText(node) {
  if (node == null || node === false) return "";
  if (typeof node !== "object") return String(node);
  const children =
    node.type === "details" && !node.props?.open
      ? node.children.filter((child) => child?.type === "summary")
      : node.children;
  return children.map(visibleText).join("");
}
function nodes(node, type) {
  if (!node || typeof node !== "object") return [];
  return [
    ...(node.type === type ? [node] : []),
    ...node.children.flatMap((child) => nodes(child, type)),
  ];
}

test("queued/started/declined/expired bodies leave the composer, preserved under closed history", () => {
  const cards = ["queued", "started", "declined", "expired"].map((s) =>
    card(s),
  );
  const original = structuredClone(cards);
  const result = tree(cards);
  assert.doesNotMatch(visibleText(result), /body-/);
  assert.match(visibleText(result), /履歴（4件）/);
  const history = nodes(result, "details")[0];
  assert.equal(history.props.open, undefined);
  assert.equal(nodes(history, "article").length, 4);
  assert.equal(nodes(history, "button").length, 0);
  assert.match(
    visibleText({ ...history, props: { open: true } }),
    /実行・返信完了ではありません/,
  );
  assert.deepEqual(cards, original);
});

test("new notifications and deferred or uncertain states stay visible ahead of collapsed history", () => {
  for (const state of [
    "shown",
    "later",
    "showing",
    "accepting",
    "accept_waiting",
    "declining",
    "unknown",
    "unavailable",
    "unsupported",
  ]) {
    const result = tree([card("queued"), card(state)]);
    assert.match(visibleText(result), new RegExp(`body-${state}`));
    assert.doesNotMatch(visibleText(result), /body-queued/);
    assert.equal(
      nodes(result, "button").length,
      ["shown", "later"].includes(state) ? 1 : 0,
    );
  }
});

test("authoritative decision then polling and remount do not restore handled body; errors stay visible", () => {
  assert.match(visibleText(tree([card("shown", "one")])), /body-one/);
  const handled = card("queued", "one");
  for (let i = 0; i < 3; i++)
    assert.doesNotMatch(visibleText(tree([handled])), /body-one/);
  const failed = tree([{ ...handled, unavailable: true }], {
    error: "offline",
  });
  assert.match(visibleText(failed), /操作は停止/);
  assert.doesNotMatch(visibleText(failed), /body-one/);
  assert.match(
    visibleText(tree([{ ...handled, unavailable: true }])),
    /履歴の一部は状態確認待ち/,
  );
  const unknown = tree([card("unknown", "one")]);
  assert.match(visibleText(unknown), /結果不明/);
  assert.match(visibleText(unknown), /body-one/);
  assert.equal(tree([]), null);
  assert.equal(
    ReceivedMessages({ view: { cards: [handled] }, visible: false }),
    null,
  );
});

test("new arrivals expose navigation outside the scroller without moving the reader on polling", () => {
  const original = [card("shown", "first"), card("shown", "new")];
  for (let refresh = 0; refresh < 3; refresh++) {
    const result = tree(original);
    const list = nodes(result, "div").find(
      (n) => n.props?.["aria-label"] === "要確認のHAB通知",
    );
    const scroll = { scrollTop: 45, scrollHeight: 900 };
    list.props.ref(scroll);
    assert.equal(scroll.scrollTop, 45, "render/polling must not change scroll");
    assert.equal(list.props.tabIndex, 0);
    const jump = nodes(result, "button").find(
      (n) => visibleText(n) === "末尾の受信通知を表示",
    );
    assert.ok(jump);
    assert.equal(
      nodes(list, "button").includes(jump),
      false,
      "navigation is outside scroll viewport",
    );
    jump.props.onClick();
    assert.equal(scroll.scrollTop, 900);
    list.props.ref(null);
    assert.doesNotThrow(() => jump.props.onClick());
  }
  assert.deepEqual(
    original.map((c) => c.notice.message_id),
    ["first", "new"],
  );
  assert.equal(
    nodes(tree([card("shown")]), "button").length,
    1,
    "one card needs no navigation",
  );
});
