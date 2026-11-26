import assert from "node:assert/strict";
import { test } from "node:test";
import { HAB_INBOX_APP_HTML } from "../src/hab/inbox-app.ts";
import { incomingPresentation } from "../src/messaging/incoming-notice.ts";

// ADR-026: the MCP Apps inbox card, driven through the postMessage protocol with a
// minimal stand-in for the iframe's DOM. Checks the shapes the MCP Apps spec defines
// (ext-apps src/spec.types.ts) and that message text is only ever set as text.

class Node {
  constructor(tag) {
    this.tag = tag;
    this.children = [];
    this.attributes = {};
    this.listeners = {};
    this.style = { setProperty() {} };
    this.dataset = {};
    this.hidden = false;
    this.disabled = false;
    this.className = "";
    this._text = "";
  }
  set textContent(value) {
    this._text = String(value);
    this.children = [];
  }
  get textContent() {
    return this._text + this.children.map((c) => c.textContent).join("");
  }
  set innerHTML(_) {
    throw new Error("the card must not parse markup");
  }
  append(...nodes) {
    this.children.push(...nodes);
  }
  replaceChildren(...nodes) {
    this.children = nodes;
  }
  setAttribute(name, value) {
    this.attributes[name] = String(value);
  }
  addEventListener(type, fn) {
    (this.listeners[type] ??= []).push(fn);
  }
  querySelectorAll(tag) {
    return this.all().filter((n) => n.tag === tag);
  }
  all() {
    return this.children.flatMap((c) => [c, ...c.all()]);
  }
  getBoundingClientRect() {
    return { width: 400, height: 200 };
  }
}

function boot({ openai } = {}) {
  const root = new Node("main");
  const sent = [];
  const listeners = [];
  const globalsListeners = [];
  const parent = {
    postMessage(message) {
      sent.push(structuredClone(message));
    },
  };
  const window = {
    parent,
    openai,
    addEventListener: (type, fn) =>
      type === "message"
        ? listeners.push(fn)
        : type === "openai:set_globals" && globalsListeners.push(fn),
  };
  const document = {
    getElementById: () => root,
    createElement: (tag) => new Node(tag),
    documentElement: new Node("html"),
  };
  const script = /<script>([\s\S]*)<\/script>/.exec(HAB_INBOX_APP_HTML)[1];
  new Function("window", "document", script)(window, document);
  const deliver = (data) =>
    listeners.forEach((fn) => fn({ source: parent, data }));
  const setGlobals = (globals) =>
    globalsListeners.forEach((fn) => fn({ detail: { globals } }));
  return { root, sent, deliver, setGlobals, document };
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

const message = (id, text, patch = {}) => {
  const fields = {
    message_id: id,
    from: "stallone@dot.hab",
    kind: "notice",
    text,
    reply_by: "2026-11-25T21:39:41.447Z",
    ...patch,
  };
  return {
    message_id: id,
    from: fields.from,
    text,
    presentation: incomingPresentation(fields),
  };
};

test("the inbox card speaks the MCP Apps handshake, draws text only and sends ui/message as content blocks", async () => {
  const { root, sent, deliver } = boot();
  const init = sent.find((m) => m.method === "ui/initialize");
  assert.equal(init.jsonrpc, "2.0");
  assert.equal(init.params.protocolVersion, "2026-01-26");
  assert.deepEqual(init.params.appInfo, { name: "hab-inbox", version: "1" });
  assert.deepEqual(init.params.appCapabilities, {});
  deliver({ jsonrpc: "2.0", id: init.id, result: { hostContext: {} } });
  await tick();
  assert.ok(sent.some((m) => m.method === "ui/notifications/initialized"));

  deliver({
    jsonrpc: "2.0",
    method: "ui/notifications/tool-result",
    params: {
      content: [{ type: "text", text: "{}" }],
      structuredContent: {
        messages: [
          message("m1", "<img src=x onerror=alert(1)>"),
          message("m2", "ok", { kind: "answer", in_reply_to: "m0" }),
        ],
      },
    },
  });
  const cards = root.children;
  assert.equal(cards.length, 2);
  assert.match(cards[0].textContent, /stallone@dot\.hab からのメッセージです/);
  assert.match(cards[0].textContent, /<img src=x onerror=alert\(1\)>/);
  assert.deepEqual(
    cards[1].querySelectorAll("button").map((b) => b.textContent),
    ["会話に渡す", "あとで"],
  );
  const size = sent.filter((m) => m.method === "ui/notifications/size-changed");
  assert.ok(size.length > 0);
  assert.equal(typeof size.at(-1).params.height, "number");

  const [accept] = cards[0].querySelectorAll("button");
  accept.listeners.click[0]();
  const ask = sent.find((m) => m.method === "ui/message");
  assert.equal(ask.params.role, "user");
  assert.ok(Array.isArray(ask.params.content));
  assert.equal(ask.params.content.length, 1);
  assert.equal(ask.params.content[0].type, "text");
  assert.match(ask.params.content[0].text, /message_id "m1"/);
  // The sender's words never go into the request; the model already has them.
  assert.doesNotMatch(ask.params.content[0].text, /img/);
  deliver({ jsonrpc: "2.0", id: ask.id, result: {} });
  await tick();
  assert.match(cards[0].textContent, /会話に送りました/);
});

test("a host that refuses ui/message leaves the buttons usable and says how to ask in chat", async () => {
  const { root, sent, deliver } = boot();
  const init = sent.find((m) => m.method === "ui/initialize");
  deliver({ jsonrpc: "2.0", id: init.id, result: {} });
  await tick();
  deliver({
    jsonrpc: "2.0",
    method: "ui/notifications/tool-result",
    params: { structuredContent: { messages: [message("m1", "hi")] } },
  });
  for (const answer of [
    { result: { isError: true } },
    { error: { code: -32000, message: "denied" } },
  ]) {
    const [accept] = root.children[0].querySelectorAll("button");
    accept.listeners.click[0]();
    const ask = sent.filter((m) => m.method === "ui/message").at(-1);
    deliver({ jsonrpc: "2.0", id: ask.id, ...answer });
    await tick();
    assert.match(root.children[0].textContent, /会話に送れませんでした/);
    assert.ok(
      root.children[0].querySelectorAll("button").every((b) => !b.disabled),
    );
    // The same request is shown as text to copy into the chat, never the sender's words.
    const handoff = root.children[0]
      .all()
      .find((n) => n.className === "handoff");
    assert.equal(handoff.hidden, false);
    assert.match(handoff.textContent, /message_id "m1"/);
    assert.ok(
      handoff
        .querySelectorAll("button")
        .some((b) => b.textContent === "文をコピー"),
    );
  }
  // Without a clipboard the copy button says to select the text instead.
  const handoff = root.children[0].all().find((n) => n.className === "handoff");
  const copy = handoff.querySelectorAll("button")[0];
  await copy.listeners.click[0]();
  assert.equal(copy.textContent, "文を選んでコピーしてください");
});

test("the card carries no brand colour and takes the host's style variables", () => {
  const style = /<style>([\s\S]*)<\/style>/.exec(HAB_INBOX_APP_HTML)[1];
  assert.doesNotMatch(style, /#[0-9a-fA-F]{3,6}\b/);
  for (const variable of [
    "--color-text-primary",
    "--color-border-secondary",
    "--font-sans",
    "--border-radius-md",
  ])
    assert.ok(style.includes(variable), variable);
  assert.match(style, /focus-visible/);
  assert.match(style, /prefers-reduced-motion/);
});

test("later folds the card to its status line", async () => {
  const { root, deliver } = boot();
  deliver({
    jsonrpc: "2.0",
    method: "ui/notifications/tool-result",
    params: { structuredContent: { messages: [message("m1", "hi")] } },
  });
  const later = root.children[0]
    .querySelectorAll("button")
    .find((b) => b.textContent === "あとで");
  await later.listeners.click[0]();
  assert.match(root.children[0].className, /folded/);
  assert.match(root.children[0].textContent, /あとで対応します/);
});

test("an empty inbox and a result without messages say so", async () => {
  const { root, deliver } = boot();
  deliver({
    jsonrpc: "2.0",
    method: "ui/notifications/tool-result",
    params: { structuredContent: { messages: [] } },
  });
  assert.equal(root.textContent, "新しいメッセージはありません。");
  deliver({
    jsonrpc: "2.0",
    method: "ui/notifications/tool-result",
    params: { isError: true },
  });
  assert.equal(root.textContent, "受信箱を読めませんでした。");
});

test("the card is never an empty frame before the result, and sends initialized even if ui/initialize fails", async () => {
  const { root, sent, deliver } = boot();
  assert.match(root.textContent, /読み込んでいます/);
  assert.ok(sent.some((m) => m.method === "ui/notifications/size-changed"));
  const init = sent.find((m) => m.method === "ui/initialize");
  deliver({
    jsonrpc: "2.0",
    id: init.id,
    error: { code: -32602, message: "no" },
  });
  await tick();
  await tick();
  assert.ok(sent.some((m) => m.method === "ui/notifications/initialized"));
});

test("ChatGPT's window.openai.toolOutput and openai:set_globals draw the card too", async () => {
  const first = boot({
    openai: { toolOutput: { messages: [message("m1", "hi")] } },
  });
  assert.equal(first.root.children.length, 1);
  assert.match(
    first.root.textContent,
    /stallone@dot\.hab からのメッセージです/,
  );

  const later = boot({ openai: { toolOutput: null } });
  assert.match(later.root.textContent, /読み込んでいます/);
  later.setGlobals({ theme: "dark" });
  assert.match(later.root.textContent, /読み込んでいます/);
  later.setGlobals({ toolOutput: { messages: [message("m2", "hello")] } });
  assert.match(later.root.textContent, /hello/);
  // The standard notification still wins when it comes after.
  later.deliver({
    jsonrpc: "2.0",
    method: "ui/notifications/tool-result",
    params: { structuredContent: { messages: [] } },
  });
  assert.match(later.root.textContent, /新しいメッセージはありません/);
});

test("the reported height is the content at max-content, not the frame's own height", () => {
  const { sent, deliver, document } = boot();
  const html = document.documentElement;
  html.style.height = "";
  // A frame 150px tall whose content needs 640px: only a max-content measure sees the content.
  html.getBoundingClientRect = () => ({
    width: 400,
    height: html.style.height === "max-content" ? 640 : 150,
  });
  deliver({
    jsonrpc: "2.0",
    method: "ui/notifications/tool-result",
    params: {
      structuredContent: {
        messages: [message("m1", "one"), message("m2", "two")],
      },
    },
  });
  const size = sent.filter((m) => m.method === "ui/notifications/size-changed");
  assert.equal(size.at(-1).params.height, 640);
  assert.equal(html.style.height, "");
});
