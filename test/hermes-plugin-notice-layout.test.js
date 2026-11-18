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

test("declined/expired bodies leave the composer, preserved under closed history", () => {
  const cards = ["declined", "expired"].map((s) => card(s));
  const original = structuredClone(cards);
  const result = tree(cards);
  assert.doesNotMatch(visibleText(result), /body-/);
  assert.match(visibleText(result), /履歴（2件）/);
  const history = nodes(result, "details")[0];
  assert.equal(history.props.open, undefined);
  assert.equal(nodes(history, "article").length, 2);
  assert.equal(nodes(history, "button").length, 0);
  assert.deepEqual(cards, original);
});

test("messages handed to the conversation stay readable, newest first, up to five", () => {
  // An automatic accept is queued seconds after it arrives; the owner still wants to see
  // that it came and what it said (2026-11-18).
  const accepted = ["a1", "a2", "a3", "a4", "a5", "a6", "a7"].map((id, i) =>
    card(i % 2 ? "started" : "queued", id),
  );
  const cards = [card("declined", "d1"), ...accepted];
  const original = structuredClone(cards);
  const result = tree(cards);
  const text = visibleText(result);
  for (const id of ["a3", "a4", "a5", "a6", "a7"])
    assert.match(text, new RegExp(`body-${id}`));
  for (const id of ["a1", "a2", "d1"])
    assert.doesNotMatch(text, new RegExp(`body-${id}`));
  assert.match(text, /会話に渡したメッセージ/);
  assert.match(text, /実行・返信完了ではありません/);
  const region = nodes(result, "div").find(
    (n) => n.props?.["aria-label"] === "最近会話に渡したHAB通知",
  );
  assert.deepEqual(
    nodes(region, "article").map((n) => visibleText(n).match(/body-(a\d)/)[1]),
    ["a7", "a6", "a5", "a4", "a3"],
  );
  assert.equal(nodes(region, "button").length, 0);
  assert.match(text, /履歴（3件）/);
  assert.equal(nodes(nodes(result, "details")[0], "article").length, 3);
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
    const result = tree([card("declined"), card(state)]);
    assert.match(visibleText(result), new RegExp(`body-${state}`));
    assert.doesNotMatch(visibleText(result), /body-declined/);
    assert.equal(
      nodes(result, "button").length,
      ["shown", "later"].includes(state) ? 1 : 0,
    );
  }
});

test("undocumented decision states cannot expose inherited object values as labels", () => {
  for (const state of ["__proto__", "constructor", "toString", "undocumented"]) {
    const result = tree([card(state)]);
    assert.match(visibleText(result), /状態確認待ち（操作できません）/);
    assert.match(visibleText(result), new RegExp(`body-${state}`));
    assert.equal(nodes(result, "button").length, 0);
  }
});

test("authoritative decision then polling and remount do not restore handled body; errors stay visible", () => {
  assert.match(visibleText(tree([card("shown", "one")])), /body-one/);
  const handled = card("declined", "one");
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

test("every message renders as a card labelled as HAB mail", () => {
  const result = tree([card("shown", "s1"), card("queued", "q1")]);
  const articles = nodes(result, "article");
  assert.equal(articles.length, 2);
  for (const article of articles) {
    assert.equal(article.props["aria-label"], "HAB からのメッセージ");
    assert.match(article.props.style.borderLeft, /solid/);
    assert.match(visibleText(article), /^HABHAB からのメッセージ送信元: /);
  }
});
