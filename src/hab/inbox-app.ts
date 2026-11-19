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
 * (`ui/message`) so the model drafts the reply and shows it before sending; あとで and
 * 対応しない only fold the card on this screen.
 */

/** Versioned like a cache key: a breaking change to the page gets a new URI. */
export const HAB_INBOX_APP_URI = "ui://hab/inbox-v1";
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
function reportSize() {
  const rect = document.documentElement.getBoundingClientRect();
  send({ method: "ui/notifications/size-changed", params: { width: Math.ceil(rect.width), height: Math.ceil(rect.height) } });
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
  header.append(el("span", "badge", "HAB"), el("strong", "", p ? p.heading : (message.from || "（削除された送信者）") + " からのメッセージです"));
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
          status.textContent = "会話に送れませんでした。チャットで「" + message.message_id + " に返信」と伝えてください。";
          for (const other of actions.querySelectorAll("button")) other.disabled = false;
        }
      } else {
        body.hidden = true;
        status.textContent = item.choice === "later"
          ? "あとで対応します。7 日間は受信箱から読み直せます。"
          : "対応しません。";
      }
      reportSize();
    });
    actions.append(button);
  }
  if (choices.length) article.append(actions);
  article.append(status);
  return article;
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
request("ui/initialize", {
  protocolVersion: "2026-01-26",
  appInfo: { name: "hab-inbox", version: "1" },
  appCapabilities: {},
}).then((result) => {
  applyContext(result && result.hostContext);
  send({ method: "ui/notifications/initialized", params: {} });
}, () => {});
if (window.ResizeObserver) new ResizeObserver(reportSize).observe(document.documentElement);
`;

const style = `
:root { color-scheme: light dark; --hab-accent: #5b6cff; }
body { margin: 0; font-family: var(--font-sans, system-ui, sans-serif); color: var(--color-text-primary, CanvasText); background: transparent; }
.card { border: 1px solid rgba(127,127,127,0.45); border-left: 4px solid var(--hab-accent); border-radius: 8px; padding: 8px 12px; margin: 6px 0; }
.head { display: flex; align-items: center; gap: 6px; margin-bottom: 4px; }
.badge { background: var(--hab-accent); color: #fff; border-radius: 4px; padding: 0 6px; font-size: 0.75em; font-weight: 700; letter-spacing: 0.05em; }
.meta { font-size: 0.85em; opacity: 0.8; margin-bottom: 6px; }
.body { white-space: pre-wrap; overflow-wrap: anywhere; background: rgba(127,127,127,0.08); border-radius: 6px; padding: 6px 10px; margin: 4px 0; }
.actions { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 6px; }
button { font: inherit; padding: 4px 12px; border-radius: 6px; border: 1px solid rgba(127,127,127,0.5); background: transparent; color: inherit; cursor: pointer; }
button.primary { background: var(--hab-accent); border-color: var(--hab-accent); color: #fff; }
button:disabled { opacity: 0.5; cursor: default; }
.status { font-size: 0.85em; margin-top: 4px; }
.status:empty { display: none; }
.empty { opacity: 0.8; margin: 6px 0; }
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
