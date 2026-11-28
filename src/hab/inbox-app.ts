/**
 * The inbox card for MCP Apps hosts (ADR-026): claude.ai, ChatGPT and the Gemini app draw
 * `hab_inbox` results with this page instead of leaving them to the model's wording. Hosts
 * without MCP Apps ignore it and use the text result as before.
 *
 * The page is one self-contained HTML document: no network, no storage, no markup from
 * messages. It speaks the MCP Apps postMessage protocol (`ui/initialize`, then
 * `ui/notifications/tool-result`), reads each message's `presentation` and `text` from the
 * result's structuredContent, and draws the sender's words with `textContent` only.
 *
 * Buttons change nothing in HAB: hab_inbox already marked the messages read. The accept
 * choice (返信する／会話に渡す) sends the user a prepared message into the conversation
 * (`ui/message`) so the model drafts the reply and shows it before sending; a host that
 * refuses ui/message gets it as model context (`ui/update-model-context`), and one that
 * refuses both gets the same request as text with a copy button. あとで and
 * 対応しない only fold the card on this screen.
 *
 * The look is ambient: the host's own fonts, colours and radii through the MCP Apps style
 * variables, no brand colour, so the card sits naturally in any agent that draws it.
 */

/**
 * Versioned like a cache key: hosts such as claude.ai and Claude Duet keep the page they
 * first read for a URI, so any change to the page gets a new URI. v2: the ambient look and
 * the copy fallback (PR #295) never reached hosts that had cached v1. v3: the
 * model-context fallback. test/hab-inbox-app.test.js pins the page's hash to the URI.
 */
export const HAB_INBOX_APP_URI = "ui://hab/inbox-v3";
/** Earlier URIs still answer with the current page, for a host holding an old tool list. */
export const HAB_INBOX_APP_LEGACY_URIS = Object.freeze([
  "ui://hab/inbox-v1",
  "ui://hab/inbox-v2",
]);
export const MCP_APP_MIME_TYPE = "text/html;profile=mcp-app";

/** `_meta` for hab_inbox: the standard key and ChatGPT's older alias. */
export const habInboxAppToolMeta = Object.freeze({
  ui: Object.freeze({ resourceUri: HAB_INBOX_APP_URI }),
  "openai/outputTemplate": HAB_INBOX_APP_URI,
});

/** `_meta` for the resource: no network at all, and the card draws its own border. */
export const habInboxAppResourceMeta = Object.freeze({
  ui: Object.freeze({
    csp: Object.freeze({ connectDomains: [], resourceDomains: [] }),
    prefersBorder: false,
  }),
});

const script = String.raw`
"use strict";
const root = document.getElementById("root");
let nextId = 1;
const pending = new Map();
function send(message) {
  window.parent.postMessage({ jsonrpc: "2.0", ...message }, "*");
}
function request(method, params) {
  const id = nextId++;
  send({ id, method, params });
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = String(text);
  return node;
}
function shortTime(value) {
  const time = Date.parse(String(value));
  return Number.isFinite(time)
    ? new Date(time).toLocaleString("ja-JP", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })
    : String(value);
}
// Inside a frame the root element is as tall as the frame, so measuring it as is reports the
// frame's own height and a host that sizes from it never grows past the first card. Measure
// the content at max-content height (as the MCP Apps SDK does), and again on the next frame
// once layout has settled.
let lastHeight = -1;
function measureAndSend() {
  const html = document.documentElement;
  const before = html.style.height;
  html.style.height = "max-content";
  const rect = html.getBoundingClientRect();
  html.style.height = before;
  const height = Math.ceil(Math.max(rect.height, document.body ? document.body.scrollHeight : 0));
  if (height === lastHeight) return;
  lastHeight = height;
  send({ method: "ui/notifications/size-changed", params: { width: Math.ceil(rect.width), height } });
}
function reportSize() {
  lastHeight = -1;
  measureAndSend();
  if (typeof requestAnimationFrame === "function") requestAnimationFrame(measureAndSend);
}
function prompt(message, p) {
  const who = p.sender.label;
  return p.is_reply
    ? "HAB で " + who + " から届いた返事（message_id \"" + message.message_id + "\"）を、この会話で扱ってください。"
    : "HAB で " + who + " から届いたメッセージ（message_id \"" + message.message_id + "\"）に返信したいです。返信の案を考えて、hab_reply で送る前に見せてください。";
}
function card(message) {
  const p = message.presentation;
  const article = el("article", "card");
  const header = el("header", "head");
  header.append(el("strong", "from", p ? p.heading : (message.from || "（削除された送信者）") + " からのメッセージです"), el("span", "via", "HAB"));
  article.append(header);
  if (p) {
    const facts = [p.kind_label, p.is_reply ? "あなたが送ったメッセージへの返事" : "返信期限 " + shortTime(p.reply_by)];
    article.append(el("div", "meta", facts.join("・")));
  }
  const body = el("div", "body", typeof message.text === "string" ? message.text : "");
  body.setAttribute("aria-label", "受信内容");
  article.append(body);
  if (p && p.hidden_data_parts > 0)
    article.append(el("div", "meta", "表示していない構造化データが " + p.hidden_data_parts + " 件あります"));
  const status = el("div", "status");
  status.setAttribute("role", "status");
  const handoff = el("div", "handoff");
  handoff.hidden = true;
  const actions = el("div", "actions");
  const choices = p ? p.choices : [];
  for (const item of choices) {
    const button = el("button", item.choice === "accept" ? "primary" : "", item.label);
    button.type = "button";
    button.addEventListener("click", async () => {
      for (const other of actions.querySelectorAll("button")) other.disabled = true;
      if (item.choice === "accept") {
        status.textContent = "会話に送っています…";
        try {
          const sent = await request("ui/message", { role: "user", content: [{ type: "text", text: prompt(message, p) }] });
          if (sent && sent.isError) throw new Error("rejected");
          status.textContent = "会話に送りました。返信は送る前に確認できます。";
        } catch {
          // Some hosts (Claude Duet) refuse ui/message but still take model context: the
          // request then waits in the conversation for the user's next word.
          try {
            const noted = await request("ui/update-model-context", { content: [{ type: "text", text: prompt(message, p) }] });
            if (noted && noted.isError) throw new Error("rejected");
            status.textContent = "会話に伝えました。チャットで「返信して」と送ると、返信の案が出ます。";
          } catch {
            status.textContent = "会話に送れませんでした。下の文をコピーして、チャットに貼ってください。";
            showHandoff(handoff, prompt(message, p));
          }
          for (const other of actions.querySelectorAll("button")) other.disabled = false;
        }
      } else {
        body.hidden = true;
        handoff.hidden = true;
        article.className = "card folded";
        status.textContent = item.choice === "later"
          ? "あとで対応します。7 日間は受信箱から読み直せます。"
          : "対応しません。";
      }
      reportSize();
    });
    actions.append(button);
  }
  if (choices.length) article.append(actions);
  article.append(status, handoff);
  return article;
}
// When the host will not take ui/message (Claude Duet, for one), hand the same request to
// the user as text they can copy into the chat, so the choice still leads somewhere.
function showHandoff(box, text) {
  box.replaceChildren();
  const line = el("p", "handoff-text", text);
  const copy = el("button", "", "文をコピー");
  copy.type = "button";
  copy.addEventListener("click", async () => {
    try {
      if (typeof navigator === "undefined" || !navigator.clipboard) throw new Error("no clipboard");
      await navigator.clipboard.writeText(text);
      copy.textContent = "コピーしました";
    } catch {
      copy.textContent = "文を選んでコピーしてください";
    }
  });
  box.append(line, copy);
  box.hidden = false;
}
function render(result) {
  const messages = result && result.structuredContent && Array.isArray(result.structuredContent.messages)
    ? result.structuredContent.messages
    : null;
  root.replaceChildren();
  if (!messages) root.append(el("p", "empty", "受信箱を読めませんでした。"));
  else if (!messages.length) root.append(el("p", "empty", "新しいメッセージはありません。"));
  else for (const message of messages) root.append(card(message));
  reportSize();
}
function applyContext(context) {
  if (!context) return;
  if (context.theme === "dark" || context.theme === "light") document.documentElement.dataset.theme = context.theme;
  const variables = context.styles && context.styles.variables;
  if (variables) for (const [key, value] of Object.entries(variables))
    if (typeof value === "string" && key.startsWith("--")) document.documentElement.style.setProperty(key, value);
}
window.addEventListener("message", (event) => {
  if (event.source !== window.parent) return;
  const data = event.data;
  if (!data || data.jsonrpc !== "2.0") return;
  if (data.id !== undefined && pending.has(data.id) && !data.method) {
    const waiter = pending.get(data.id);
    pending.delete(data.id);
    if (data.error) waiter.reject(data.error);
    else waiter.resolve(data.result);
    return;
  }
  if (data.method === "ui/notifications/tool-result") render(data.params);
  else if (data.method === "ui/notifications/host-context-changed") applyContext(data.params);
  else if (data.method === "ui/resource-teardown" && data.id !== undefined) send({ id: data.id, result: {} });
  else if (data.method === "ping" && data.id !== undefined) send({ id: data.id, result: {} });
});
// ChatGPT also hands the result to the page as window.openai.toolOutput (the
// structuredContent alone) and announces later values with openai:set_globals. Read it
// too, so the card still draws when that is the only way the result arrives.
function renderOpenAi(output) {
  if (output && typeof output === "object" && Array.isArray(output.messages)) render({ structuredContent: output });
}
window.addEventListener("openai:set_globals", (event) => {
  const globals = event && event.detail && event.detail.globals;
  if (globals) renderOpenAi(globals.toolOutput);
});
// Never start as an empty, zero-height frame: a host that sizes the frame from the page
// would otherwise keep it invisible until a result arrives.
root.replaceChildren(el("p", "empty", "受信箱を読み込んでいます…"));
reportSize();
renderOpenAi(window.openai && window.openai.toolOutput);
// The host sends nothing before initialized, so send it even if ui/initialize fails.
request("ui/initialize", {
  protocolVersion: "2026-01-26",
  appInfo: { name: "hab-inbox", version: "1" },
  appCapabilities: {},
}).then((result) => applyContext(result && result.hostContext), () => {})
  .then(() => send({ method: "ui/notifications/initialized", params: {} }));
if (typeof ResizeObserver === "function") {
  const observer = new ResizeObserver(measureAndSend);
  observer.observe(document.documentElement);
  observer.observe(root);
}
`;

const style = `
/* Ambient: the card borrows the host's own type, colours and radii (MCP Apps style
   variables) and adds no brand colour, so it reads as part of whichever agent draws it. */
:root {
  color-scheme: light dark;
  --ink: var(--color-text-primary, CanvasText);
  --ink-soft: var(--color-text-secondary, color-mix(in srgb, CanvasText 62%, transparent));
  --rule: var(--color-border-secondary, color-mix(in srgb, CanvasText 14%, transparent));
  --wash: var(--color-background-secondary, color-mix(in srgb, CanvasText 4%, transparent));
  --solid: var(--color-background-inverse, CanvasText);
  --solid-ink: var(--color-text-inverse, Canvas);
  --focus: var(--color-ring-primary, Highlight);
  --radius: var(--border-radius-md, 8px);
}
body { margin: 0; font-family: var(--font-sans, system-ui, sans-serif); font-size: var(--font-text-md-size, 15px); line-height: 1.55; color: var(--ink); background: transparent; }
main { padding: 0; }
/* Hosts may draw their own frame around the card (Claude Duet does), so keep clear of it on every side. */
.card { padding: 14px 16px; }
.card + .card { border-top: 1px solid var(--rule); }
.head { display: flex; align-items: baseline; gap: 8px; }
.from { font-weight: 600; }
.via { color: var(--ink-soft); font-size: 0.8125em; }
.meta { color: var(--ink-soft); font-size: 0.8125em; margin-top: 2px; }
/* The sender's own words: set off like a quotation, because they are data, not the host's voice. */
.body { white-space: pre-wrap; overflow-wrap: anywhere; margin: 10px 0 0; padding: 2px 0 2px 12px; border-left: 2px solid var(--rule); max-width: 68ch; }
.actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 12px; }
button { font: inherit; font-size: 0.875em; line-height: 1.4; padding: 5px 14px; border-radius: var(--radius); border: 1px solid var(--rule); background: transparent; color: inherit; cursor: pointer; }
button:hover:not(:disabled) { background: var(--wash); }
button.primary { background: var(--solid); border-color: var(--solid); color: var(--solid-ink); }
button.primary:hover:not(:disabled) { opacity: 0.88; background: var(--solid); }
button:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }
button:disabled { opacity: 0.45; cursor: default; }
.status { color: var(--ink-soft); font-size: 0.8125em; margin-top: 8px; }
.status:empty { display: none; }
.folded .actions { display: none; }
.folded .status { margin-top: 4px; }
.handoff { margin-top: 8px; padding: 10px 12px; background: var(--wash); border-radius: var(--radius); }
.handoff[hidden] { display: none; }
.handoff-text { margin: 0 0 8px; user-select: all; -webkit-user-select: all; overflow-wrap: anywhere; font-size: 0.875em; }
.empty { color: var(--ink-soft); margin: 0; padding: 14px 16px; }
@media (prefers-reduced-motion: no-preference) { button { transition: background-color 120ms ease, opacity 120ms ease; } }
`;

/** The whole page, as served by resources/read. */
export const HAB_INBOX_APP_HTML = `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>HAB 受信箱</title>
<style>${style}</style>
</head>
<body>
<main id="root" aria-live="polite"></main>
<script>${script}</script>
</body>
</html>
`;
