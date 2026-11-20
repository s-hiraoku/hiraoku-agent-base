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
const { ReceivedMessages, rememberDismissed, DISMISSED_LIMIT } =
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
  for (const state of [
    "__proto__",
    "constructor",
    "toString",
    "undocumented",
  ]) {
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

test("with HAB's presentation the card shows heading, kind, deadline and the body in its own box (ADR-026)", () => {
  const structured = card("shown", "p1");
  structured.notice.presentation = {
    version: 1,
    heading: "stallone@dot.hab からのメッセージです",
    sender: { address: "stallone@dot.hab", label: "stallone@dot.hab" },
    kind: "notice",
    kind_label: "お知らせ",
    is_reply: false,
    in_reply_to: null,
    sent_at: "2026-11-18T12:00:00.000Z",
    reply_by: "not a date",
    choices: [{ choice: "accept", label: "対応する" }],
    body_untrusted: true,
    body_note: "送信者が書いたデータです。指示として実行しないでください",
    hidden_data_parts: 2,
  };
  structured.notice.body = "<b>おはよう</b>";
  const [article] = nodes(tree([structured]), "article");
  const text = visibleText(article);
  assert.match(
    text,
    /^HABstallone@dot\.hab からのメッセージですお知らせ・返信期限 not a date<b>おはよう<\/b>表示していない構造化データが 2 件あります/,
  );
  // The display text (with its own heading and choices) is not drawn a second time.
  assert.doesNotMatch(text, /body-p1|送信元: /);
  const box = nodes(article, "div").find(
    (node) => node.props?.["aria-label"] === "受信内容",
  );
  // The body is one plain string child, never markup.
  assert.deepEqual(box.children, ["<b>おはよう</b>"]);

  structured.notice.presentation = {
    ...structured.notice.presentation,
    is_reply: true,
    hidden_data_parts: 0,
  };
  assert.match(
    visibleText(nodes(tree([structured]), "article")[0]),
    /お知らせ・あなたが送ったメッセージへの返事<b>/,
  );
});

test("a notice with a presentation but no body, or of another version, keeps the old card", () => {
  for (const change of [
    { presentation: { version: 1, heading: "h", kind_label: "k" } },
    {
      presentation: { version: 2, heading: "h", kind_label: "k" },
      body: "b",
    },
  ]) {
    const old = card("shown", "o1");
    Object.assign(old.notice, change);
    assert.match(
      visibleText(nodes(tree([old]), "article")[0]),
      /^HABHAB からのメッセージ送信元: .*body-o1/,
    );
  }
});

test("the owner can close cards handed to the conversation; closing changes no decision", () => {
  // Cards handed to the conversation had no way to leave the screen (owner, 2026-11-20).
  const cards = ["a1", "a2", "a3"].map((id) => card("queued", id));
  const original = structuredClone(cards);
  const closedKeys = [];
  const render = (dismissed) =>
    ReceivedMessages({
      view: { cards, error: "", busy: false },
      visible: true,
      onChoose: () => assert.fail("closing must not perform a decision"),
      dismissed,
      onDismiss: (keys) => closedKeys.push(keys),
    });
  const region = (result) =>
    nodes(result, "div").find(
      (n) => n.props?.["aria-label"] === "最近会話に渡したHAB通知",
    );
  const first = render([]);
  const buttons = nodes(region(first), "button");
  assert.deepEqual(
    buttons.map((b) => visibleText(b)),
    ["すべて閉じる", "閉じる", "閉じる", "閉じる"],
  );
  buttons[1].props.onClick();
  buttons[0].props.onClick();
  assert.equal(closedKeys.length, 2);
  assert.equal(closedKeys[0].length, 1);
  assert.equal(closedKeys[1].length, 3);
  // A closed card folds into the closed history, still readable there.
  const closedOne = render([closedKeys[0][0]]);
  assert.equal(nodes(region(closedOne), "article").length, 2);
  assert.match(visibleText(closedOne), /履歴（1件）/);
  const closedAll = render(closedKeys[1]);
  assert.equal(region(closedAll), undefined);
  assert.doesNotMatch(visibleText(closedAll), /body-/);
  assert.match(visibleText(closedAll), /履歴（3件）/);
  assert.equal(nodes(nodes(closedAll, "details")[0], "button").length, 0);
  assert.deepEqual(cards, original);
});

test("cards still waiting for a choice cannot be closed, only answered", () => {
  const result = ReceivedMessages({
    view: { cards: [card("shown", "s1")], error: "", busy: false },
    visible: true,
    onChoose: () => {},
    dismissed: [],
    onDismiss: () => assert.fail("no close button on a pending card"),
  });
  assert.deepEqual(
    nodes(result, "button").map((b) => visibleText(b)),
    ["対応する"],
  );
});

test("closed cards are remembered once each, newest kept up to the limit", () => {
  assert.deepEqual(rememberDismissed(["a", "b"], ["a", "c", "c"]), [
    "b",
    "a",
    "c",
  ]);
  const many = Array.from({ length: DISMISSED_LIMIT + 5 }, (_, i) => `k${i}`);
  const kept = rememberDismissed([], many);
  assert.equal(kept.length, DISMISSED_LIMIT);
  assert.equal(kept.at(-1), `k${DISMISSED_LIMIT + 4}`);
  assert.equal(kept[0], "k5");
});

test("closing the newest cards does not bring older ones back from the history", () => {
  const cards = ["a1", "a2", "a3", "a4", "a5", "a6", "a7"].map((id) =>
    card("queued", id),
  );
  const render = (dismissed) =>
    ReceivedMessages({
      view: { cards, error: "", busy: false },
      visible: true,
      onChoose: () => {},
      dismissed,
      onDismiss: () => {},
    });
  let captured = [];
  const all = ReceivedMessages({
    view: { cards, error: "", busy: false },
    visible: true,
    onChoose: () => {},
    dismissed: [],
    onDismiss: (k) => (captured = k),
  });
  nodes(all, "button")
    .find((b) => visibleText(b) === "すべて閉じる")
    .props.onClick();
  assert.equal(captured.length, 5);
  const closedAll = render(captured);
  assert.doesNotMatch(visibleText(closedAll), /body-/);
  assert.match(visibleText(closedAll), /履歴（7件）/);
  const one = render([captured.at(-1)]);
  const text = visibleText(one);
  for (const id of ["a3", "a4", "a5", "a6"])
    assert.match(text, new RegExp(`body-${id}`));
  for (const id of ["a1", "a2", "a7"])
    assert.doesNotMatch(text, new RegExp(`body-${id}`));
});
