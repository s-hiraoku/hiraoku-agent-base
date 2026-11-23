const $ = (id) => document.getElementById(id);
const sessionMeta = document.querySelector('meta[name="hab-session"]');
const roleMeta = document.querySelector('meta[name="hab-role"]');
const session = sessionMeta?.content;
const token = /^[A-Za-z0-9_-]{43}$/.test(session ?? "") ? session : null;
const operator = token !== null && roleMeta?.content === "operator";
sessionMeta?.remove();
roleMeta?.remove();
if (sessionMeta || location.hash) history.replaceState(null, "", "/");

const checkLabels = {
  registration: "登録の診断",
  receive: "受け取り方",
  reading: "受信箱",
  session: "会話",
};
const stateLabels = { ok: "確認済み", problem: "要対応", unknown: "未確認" };
const registryLabels = {
  waiting_connection: "接続待ち",
  active: "有効",
  stopped: "停止",
  retired: "廃止",
};
const reasonLabels = {
  registered: "登録と接続の承認を確認しました。",
  address_inactive: "アドレスが有効ではありません。",
  address_unbound: "アドレスに接続が紐づいていません。",
  operations_missing: "接続に必要な操作権限が不足しています。",
  approval_revoked: "接続の承認は取り消されています。",
  approval_expired: "接続の承認が期限切れです。",
  approval_expiring: "接続の承認期限が近づいています。",
  pending_approval: "承認待ちのサインインがあります。",
  connection_unlisted: "台帳に接続が見つかりません。",
  receive_unset: "受け取り方が設定されていません。",
  events_off: "呼び鈴に必要なイベントが無効です。",
  doorbell_missing: "呼び鈴の宛先がありません。",
  doorbell_lapsed: "呼び鈴の購読が切れています。",
  doorbell_failing: "呼び鈴が受け取られていません。",
  doorbell_live: "呼び鈴は有効です。",
  poll_overdue: "予定タスクの読み取りが遅れています。",
  poll_never_read: "受信箱の読み取りがまだ記録されていません。",
  poll_reading: "予定タスクによる読み取りを確認しました。",
  reads_untracked: "受信箱の読み取りは記録されていません。",
  on_request: "製品で依頼されたときに受信箱を読みます。",
  no_unread: "未読メールはありません。",
  unread_recent: "新しい未読メールがあります。",
  waiting_for_request: "製品で受信箱を開くのを待っています。",
  rang_not_read: "呼び鈴の受信後に受信箱が読まれていません。",
  unread_waiting: "30 分以上読まれていないメールがあります。",
  recipient_absent: "製品が会話の終了を報告しました。",
  session_not_reported: "製品から会話の報告がありません。",
};
const evidenceLabels = {
  active_bindings: "有効な接続数",
  operations: "許可された操作数",
  pending_connections: "ホスト全体の承認待ち件数",
  approved_until: "承認期限",
  mode: "受信方式",
  interval_ms: "確認間隔",
  last_inbox_read_at: "最終読み取り",
  last_rang_at: "最終呼び鈴",
  last_status: "呼び鈴の HTTP 状態",
  unread: "未読数",
  oldest_unread_at: "最も古い未読",
  last_accepted_ring_at: "呼び鈴の最終受付",
  absent_since: "会話が終了したと報告された時刻",
};
const receiveModes = { hook: "呼び鈴", poll: "予定タスク", on_request: "手動" };

const PRODUCTS = [
  [
    "Dots（ChatGPT）",
    "dotschatgptを設定する",
    "ChatGPT で HAB コネクタをつなぎ、Work または Dots の会話で見張りを設定します。",
  ],
  [
    "Grok Bot",
    "grok-bot-を設定する",
    "Grok Bot で routine を用意し、HAB に呼び鈴の宛先を登録します。",
  ],
  [
    "Muse",
    "muse-を設定する",
    "Muse で HAB コネクタをつなぎ、受信箱を確認する予定タスクを設定します。",
  ],
  [
    "Hermes Desktop",
    "hermes-desktop-を設定する",
    "Mac に受信通知とプラグインを設定し、Hermes Desktop の会話につなぎます。",
  ],
  [
    "claude.ai",
    "claudeai-を設定する",
    "Connectors で HAB を追加し、会話から受信箱を開きます。",
  ],
];
const setupGuide =
  "https://github.com/s-hiraoku/hiraoku-agent-base/blob/main/docs/connections/agent-setup.md";
const formatTime = new Intl.DateTimeFormat("ja-JP", {
  dateStyle: "short",
  timeStyle: "medium",
});
let addresses = [];
let detailRequest;
const signInMessage =
  "起動時に案内されたファイルからダッシュボードを開き直してください。";

function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}

function stateBadge(state) {
  return element("span", stateLabels[state], "badge " + state);
}

async function loadJson(path, { signal, body } = {}) {
  const headers = { Authorization: "Bearer " + token };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const response = await fetch(path, {
    headers,
    method: body === undefined ? "GET" : "POST",
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: "no-store",
    credentials: "omit",
    redirect: "error",
    signal,
  });
  if (!response.ok) {
    if (path.startsWith("/api/mail") && response.status !== 401) {
      const problem = await response.json().catch(() => ({}));
      throw new Error(mailProblem(problem.error));
    }
    const message = {
      401: signInMessage,
      404: "アドレスが見つかりません。登録一覧を更新してください。",
    }[response.status];
    throw new Error(
      message ??
        "診断を取得できませんでした。HAB の設定を確かめてから更新してください。",
    );
  }
  return response.json();
}

function errorMessage(error) {
  return error instanceof TypeError
    ? "ダッシュボードに接続できませんでした。起動状態を確かめてください。"
    : error.message;
}

async function copyAddress(address) {
  try {
    await navigator.clipboard.writeText(address);
    $("copy-status").textContent = address + " をコピーしました。";
  } catch {
    $("copy-status").textContent =
      "コピーできませんでした。アドレスを選択してコピーしてください。";
  }
}

function addressRow(entry) {
  const row = element("tr");
  const name = element("th");
  name.scope = "row";
  const actions = element("div", undefined, "address-actions");
  const detail = element("button", entry.address, "address");
  detail.type = "button";
  detail.addEventListener("click", () => showDiagnosis(entry.address));
  const copy = element("button", "コピー", "button small");
  copy.type = "button";
  copy.setAttribute("aria-label", entry.address + " をコピー");
  copy.addEventListener("click", () => copyAddress(entry.address));
  actions.append(detail, copy);
  name.append(actions);
  row.append(name);

  row.append(element("td", registryLabels[entry.registry_state]));
  for (const key of Object.keys(checkLabels)) {
    const cell = element("td");
    cell.append(stateBadge(entry[key]));
    row.append(cell);
  }
  const [check, reason] = entry.first_problem?.split(":") ?? [];
  const problem = reason
    ? checkLabels[check] + "　" + (reasonLabels[reason] ?? reason)
    : "なし";
  row.append(element("td", problem, "first-problem"));
  return row;
}

function renderAddresses() {
  const query = $("search").value.trim().toLowerCase();
  const filter = $("registration-filter").value;
  const matches = addresses.filter(
    (entry) =>
      entry.address.includes(query) &&
      (!filter || entry.registry_state === filter),
  );
  const rows = document.createDocumentFragment();
  for (const entry of matches) rows.append(addressRow(entry));
  $("address-rows").replaceChildren(rows);
  $("table-wrap").hidden = matches.length === 0;
  $("list-status").textContent = matches.length
    ? matches.length + " 件"
    : addresses.length
      ? "条件に一致するアドレスはありません。"
      : "登録されたアドレスはありません。";
}

async function refreshAddresses() {
  const refresh = $("refresh");
  const updated = $("last-updated");
  refresh.disabled = true;
  $("list-status").textContent = "診断を読み込んでいます。";
  try {
    ({ addresses } = await loadJson("/api/diagnostics"));
    renderAddresses();
    const now = new Date();
    updated.dateTime = now.toISOString();
    updated.textContent = "最終更新 " + formatTime.format(now);
    updated.hidden = false;
  } catch (error) {
    addresses = [];
    $("address-rows").replaceChildren();
    $("table-wrap").hidden = true;
    updated.hidden = true;
    $("list-status").textContent = errorMessage(error);
  } finally {
    refresh.disabled = false;
    if (operator) renderRecipients();
  }
}

function evidenceValue(key, value) {
  if (key === "mode") return receiveModes[value];
  if (key === "interval_ms") return value / 1000 + " 秒";
  if (typeof value === "string") return formatTime.format(new Date(value));
  return String(value);
}

function diagnosisCheck(key, check) {
  const section = element("section", undefined, "check");
  const header = element("div", undefined, "check-header");
  header.append(element("h3", checkLabels[key]), stateBadge(check.state));
  section.append(
    header,
    element("p", reasonLabels[check.reason] ?? check.reason),
  );

  const evidence = element("dl");
  for (const [field, value] of Object.entries(check.evidence)) {
    evidence.append(
      element("dt", evidenceLabels[field]),
      element("dd", evidenceValue(field, value)),
    );
  }
  if (evidence.childElementCount) section.append(evidence);
  if (check.next_action) {
    const next = element("div", undefined, "next-action");
    next.append(element("h4", "次の操作"), element("p", check.next_action));
    section.append(next);
  }
  return section;
}

async function showDiagnosis(address) {
  detailRequest?.abort();
  const request = new AbortController();
  detailRequest = request;
  const status = $("diagnosis-status");
  const checks = $("diagnosis-checks");
  $("diagnosis-title").textContent = address + " の診断";
  status.textContent = "診断を読み込んでいます。";
  checks.replaceChildren();
  $("diagnosis").showModal();

  try {
    const result = await loadJson(
      "/api/diagnosis?" + new URLSearchParams({ address }),
      { signal: request.signal },
    );
    if (request.signal.aborted) return;
    status.textContent = "";
    checks.replaceChildren(
      ...Object.keys(checkLabels).map((key) =>
        diagnosisCheck(key, result.checks[key]),
      ),
    );
  } catch (error) {
    if (!request.signal.aborted) status.textContent = errorMessage(error);
  }
}

const mailProblems = {
  invalid_request: "入力を見直してください。",
  invalid_address: "有効な宛先を選んでください。",
  invalid_reference:
    "相手の登録または返信先が変わりました。現在の状態を確認してください。",
  unknown_address: "宛先を確認できません。登録一覧を更新してください。",
  recipient_absent: "相手の会話が終了しているか、一時的に不在です。",
  reply_target_expired: "返信先のメッセージは期限切れです。",
  text_too_long: "本文が長すぎます。短くしてから新しい送信を作成してください。",
  idempotency_conflict: "前回の操作の宛先や本文と一致しません。",
  operation_conflict: "前回の操作の宛先や本文と一致しません。",
  operation_not_found:
    "操作が見つかりません。同じ宛先と本文で再試行してください。",
  not_found: "対象が見つかりません。履歴や受信箱を更新してください。",
  forbidden:
    "この操作は許可されていません。登録と接続の承認を確認してください。",
  transport_failed:
    "HAB に接続できません。起動状態を確認してから、同じ操作を確認してください。",
  authentication_required: "HAB の接続認証を確認してください。",
  authentication_failed: "HAB の接続認証を確認してください。",
  reauthentication_required:
    "HAB に再認証してから、同じ操作の状況を確認してください。",
  unauthorized: "HAB の接続認証を確認してください。",
};
const deliveryLabels = {
  unknown: ["結果未確認", "unknown"],
  pending: ["受付済み", "ok"],
  leased: ["配送中", "ok"],
  acked: ["相手側の保存を確認", "ok"],
  expired: ["期限切れ", "problem"],
  quarantined: ["配送を停止", "problem"],
};
const operationNames = {
  send: "メッセージ",
  reply: "返信",
  ping: "試験メッセージ",
};
const evidenceNames = {
  accepted_at: "HAB の受付",
  doorbell_at: "呼び鈴の受理",
  acked_at: "相手側の保存",
  read_at: "受信箱の既読",
  reply_at: "返信の受付",
};
let mail = null;
let mailBusy = false;
let replyTo = null;
let pingTo = "";
const attempts = new Map();
const replyDrafts = new Map();
const openedMessages = new Map();
let olderCursor = "start";
const replyKey = (message) => "reply:" + message?.message_id;
const pingKey = (to) => "ping:" + to;

function mailProblem(code) {
  return (
    mailProblems[code] ??
    "結果を確認できませんでした。HAB の起動状態を確認してください。"
  );
}

function mailButton(text, callback) {
  const button = element("button", text, "button small");
  button.type = "button";
  button.disabled = mailBusy;
  button.addEventListener("click", callback);
  return button;
}

function renderRecipients() {
  const select = $("mail-to");
  if (!attempts.has("send")) {
    const selected = select.value;
    const prompt = element("option", "宛先を選択");
    prompt.value = "";
    const contacts = addresses
      .filter(
        (entry) =>
          entry.registry_state === "active" &&
          entry.address !== (mail?.address ?? mail?.ping_address),
      )
      .map((entry) => {
        const option = element("option", entry.address);
        option.value = entry.address;
        return option;
      });
    select.replaceChildren(prompt, ...contacts);
    select.value = contacts.some((option) => option.value === selected)
      ? selected
      : "";
  }
  updateMailControls();
}

function updateMailControls() {
  const unavailable = !mail || mailBusy;
  const pingOnly = mail?.address === null;
  const sendPending = attempts.has("send");
  const replyPending = attempts.has(replyKey(replyTo));
  const pingPending = attempts.has(pingKey(pingTo));
  const to = $("mail-to").value;
  $("mail-to").disabled = unavailable || sendPending;
  $("mail-text").readOnly = unavailable || sendPending;
  $("compose-body").hidden = pingOnly;
  $("mail-inbox").hidden = pingOnly;
  $("send-title").textContent = pingOnly ? "試験送信" : "メッセージを送る";
  $("send-message").hidden = pingOnly;
  $("send-message").disabled = unavailable || pingOnly || !to;
  $("send-message").textContent = sendPending ? "同じ送信を再試行" : "送信";
  $("new-message").hidden = !sendPending;
  $("open-ping").hidden = !mail?.ping_enabled;
  $("open-ping").disabled = unavailable || !to || to === mail?.ping_address;
  $("reply-text").readOnly = unavailable || replyPending;
  $("send-reply").disabled = unavailable || !replyTo;
  $("send-reply").textContent = replyPending
    ? "同じ返信を再試行"
    : "返信を送信";
  $("new-reply").hidden = !replyPending;
  $("send-ping").disabled = unavailable || !pingTo;
  $("send-ping").textContent = pingPending ? "同じ試験を再試行" : "試験送信";
  $("new-ping").hidden = !pingPending;
  $("read-inbox").disabled = unavailable || pingOnly;
  $("read-older").disabled = unavailable || pingOnly || !olderCursor;
  $("refresh-deliveries").disabled = mailBusy;
  for (const id of [
    "new-message",
    "new-reply",
    "new-ping",
    "close-reply",
    "close-ping",
  ]) {
    $(id).disabled = mailBusy;
  }
  for (const button of $("delivery-items").querySelectorAll("button"))
    button.disabled = unavailable;
  for (const button of $("inbox-items").querySelectorAll("button"))
    button.disabled = unavailable;
}

async function mailRequest(status, work) {
  if (mailBusy) return;
  mailBusy = true;
  updateMailControls();
  status.textContent = "確認しています。";
  try {
    await work();
  } catch (error) {
    status.textContent = errorMessage(error);
  } finally {
    mailBusy = false;
    updateMailControls();
  }
}

function observedTime(value, fallback = "未確認") {
  const date = new Date(value);
  if (!value || !Number.isFinite(date.getTime()))
    return element("span", fallback);
  const time = element("time", formatTime.format(date));
  time.dateTime = date.toISOString();
  return time;
}

function deliveryItem(operation) {
  const item = element("li", undefined, "mail-item");
  const title =
    operationNames[operation.action] + "　" + (operation.to ?? "宛先未確認");
  const [state, style] =
    deliveryLabels[operation.state] ?? deliveryLabels.unknown;
  const heading = element("div", undefined, "mail-heading");
  heading.append(
    element("h4", title),
    element("span", state, "badge " + style),
  );
  const evidence = element("dl", undefined, "mail-evidence");
  for (const [field, label] of Object.entries(evidenceNames)) {
    const detail = element("dd");
    const saved = field === "acked_at" && operation.state === "acked";
    detail.append(
      observedTime(operation[field], saved ? "保存済み（時刻不明）" : "未確認"),
    );
    evidence.append(element("dt", label), detail);
  }
  const controls = element("div", undefined, "mail-actions");
  controls.append(
    mailButton("状況を確認", () => observeOperation(operation, false)),
  );
  controls.lastChild.setAttribute("aria-label", title + "の状況を確認");
  if (operation.state === "unknown" && !operation.accepted_at) {
    const retry = mailButton("同じ操作を再試行", () =>
      observeOperation(operation, true),
    );
    retry.setAttribute("aria-label", title + "で同じ操作を再試行");
    controls.append(retry);
  }
  item.append(heading, evidence);
  if (operation.problem)
    item.append(element("p", mailProblem(operation.problem), "mail-status"));
  item.append(controls);
  return item;
}

function renderDeliveryHistory() {
  $("delivery-items").replaceChildren(...mail.operations.map(deliveryItem));
  $("delivery-status").textContent = mail.operations.length
    ? ""
    : "送信履歴はありません。";
}

function settleOperation(operation) {
  if (!operation.accepted_at) return;
  for (const [key, attempt] of attempts) {
    if (
      attempt.body.operation_id !== operation.operation_id ||
      attempt.action !== operation.action
    )
      continue;
    attempts.delete(key);
    if (attempt.action === "send") $("mail-text").value = "";
    if (attempt.action === "reply") {
      replyDrafts.delete(attempt.body.message_id);
      if (key === replyKey(replyTo)) $("reply-text").value = "";
    }
  }
}

function rememberOperation(operation) {
  mail.operations = [
    operation,
    ...mail.operations.filter(
      (item) =>
        item.operation_id !== operation.operation_id ||
        item.action !== operation.action,
    ),
  ];
  settleOperation(operation);
  renderRecipients();
  renderDeliveryHistory();
}

function refreshMail() {
  return mailRequest($("delivery-status"), async () => {
    mail = await loadJson("/api/mail");
    $("mail-sender").textContent =
      "送信名義　" + (mail.address ?? mail.ping_address);
    for (const operation of mail.operations) settleOperation(operation);
    renderRecipients();
    renderDeliveryHistory();
  });
}

function observeOperation(operation, retry) {
  return mailRequest($("delivery-status"), async () => {
    const input = {
      operation_id: operation.operation_id,
      action: operation.action,
    };
    const result = retry
      ? await loadJson("/api/mail/retry", { body: input })
      : await loadJson("/api/mail/status?" + new URLSearchParams(input));
    rememberOperation(result);
    $("delivery-status").textContent = result.problem
      ? mailProblem(result.problem)
      : "配送状況を更新しました。";
  });
}

function submitMail(action, key, input, status, dialog) {
  if (!mail || mailBusy || (action !== "ping" && !mail.address)) return;
  if (input.text !== undefined && !input.text.trim()) {
    status.textContent = "本文を入力してください。";
    return;
  }
  let attempt = attempts.get(key);
  if (!attempt) {
    const operation_id =
      "rm1." + Date.now() + "." + crypto.randomUUID().replaceAll("-", "");
    attempt = { action, body: { ...input, operation_id } };
    attempts.set(key, attempt);
  }
  return mailRequest(status, async () => {
    const operation = await loadJson("/api/mail/" + action, {
      body: attempt.body,
    });
    rememberOperation(operation);
    if (operation.accepted_at) {
      const note = operationNames[action] + "を HAB が受け付けました。";
      if (dialog) {
        dialog.close();
        $("mail-status").textContent = note;
      } else status.textContent = note;
    } else {
      status.textContent = operation.problem
        ? mailProblem(operation.problem)
        : "送信結果が未確認です。同じ操作を再試行できます。";
    }
  });
}

function newAttempt(key, input, status) {
  attempts.delete(key);
  status.textContent = "";
  renderRecipients();
  input.focus();
}

function openReply(message) {
  replyTo = message;
  $("reply-recipient").textContent =
    "宛先　" + (message.from ?? "元のメッセージの送信者");
  $("reply-text").value = replyDrafts.get(message.message_id) ?? "";
  $("reply-status").textContent = "";
  updateMailControls();
  $("reply-dialog").showModal();
  $("reply-text").focus();
}

function inboxItem(message) {
  const item = element("li", undefined, "mail-item");
  const heading = element("div", undefined, "mail-heading");
  heading.append(
    element("h4", message.from ?? "送信者不明"),
    observedTime(message.sent_at),
  );
  item.append(
    heading,
    element(
      "p",
      message.text ?? "表示できるテキストがありません。",
      "message-body",
    ),
    mailButton("返信", () => openReply(message)),
  );
  return item;
}

function readInbox(readHistory) {
  return mailRequest($("inbox-status"), async () => {
    const { messages, next_cursor } = await loadJson("/api/mail/inbox", {
      body: readHistory ? { read_history: readHistory } : {},
    });
    if (readHistory) olderCursor = next_cursor;
    const items = messages.map((message) => [
      JSON.stringify([message.from, message.message_id]),
      message,
    ]);
    for (const [key, message] of items) openedMessages.set(key, message);
    const visible = [...openedMessages.values()];
    $("inbox-items").replaceChildren(...visible.map(inboxItem));
    $("inbox-status").textContent = visible.length
      ? visible.length + " 件を表示しています。"
      : "受信箱に表示するメッセージはありません。";
    $("read-older").hidden = !olderCursor;
  });
}

if (operator) {
  $("mail-workspace").hidden = false;
  $("mail-to").addEventListener("change", updateMailControls);
  $("refresh-deliveries").addEventListener("click", refreshMail);
  $("read-inbox").addEventListener("click", () => readInbox());
  $("read-older").addEventListener("click", () => readInbox(olderCursor));
  $("send-form").addEventListener("submit", (event) => {
    event.preventDefault();
    submitMail(
      "send",
      "send",
      { to: $("mail-to").value, text: $("mail-text").value },
      $("send-status"),
    );
  });
  $("new-message").addEventListener("click", () =>
    newAttempt("send", $("mail-text"), $("send-status")),
  );
  $("reply-form").addEventListener("submit", (event) => {
    event.preventDefault();
    if (!replyTo) return;
    submitMail(
      "reply",
      replyKey(replyTo),
      { message_id: replyTo.message_id, text: $("reply-text").value },
      $("reply-status"),
      $("reply-dialog"),
    );
  });
  $("new-reply").addEventListener("click", () =>
    newAttempt(replyKey(replyTo), $("reply-text"), $("reply-status")),
  );
  $("reply-text").addEventListener("input", () => {
    if (!replyTo) return;
    const text = $("reply-text").value;
    if (text) replyDrafts.set(replyTo.message_id, text);
    else replyDrafts.delete(replyTo.message_id);
  });
  $("open-ping").addEventListener("click", () => {
    pingTo = $("mail-to").value;
    $("ping-sender").textContent = "送信名義　" + mail.ping_address;
    $("ping-recipient").textContent = "宛先　" + pingTo;
    $("ping-status").textContent = "";
    updateMailControls();
    $("ping-dialog").showModal();
  });
  $("ping-form").addEventListener("submit", (event) => {
    event.preventDefault();
    submitMail(
      "ping",
      pingKey(pingTo),
      { to: pingTo },
      $("ping-status"),
      $("ping-dialog"),
    );
  });
  $("new-ping").addEventListener("click", () =>
    newAttempt(pingKey(pingTo), $("send-ping"), $("ping-status")),
  );
  for (const name of ["reply", "ping"]) {
    const dialog = $(name + "-dialog");
    $("close-" + name).addEventListener("click", () => dialog.close());
    dialog.addEventListener("cancel", (event) => {
      if (mailBusy) event.preventDefault();
    });
  }
  refreshMail();
}

for (const [name, anchor] of PRODUCTS) {
  const option = element("option", name);
  option.value = anchor;
  $("product").append(option);
}
$("common-guide").href = setupGuide + "#共通の準備をする";
$("product").addEventListener("change", () => {
  const value = $("product").value;
  const product = PRODUCTS.find(([, anchor]) => anchor === value);
  $("setup-guide").hidden = !product;
  if (product) {
    const [, anchor, instructions] = product;
    $("product-instructions").textContent = instructions;
    $("product-guide").href = setupGuide + "#" + anchor;
  }
});
$("connect").addEventListener("click", () => $("setup").showModal());
$("close-setup").addEventListener("click", () => $("setup").close());
$("close-diagnosis").addEventListener("click", () => $("diagnosis").close());
$("diagnosis").addEventListener("close", () => {
  if (!$("diagnosis").open) detailRequest?.abort();
});
$("refresh").addEventListener("click", refreshAddresses);
$("search").addEventListener("input", () => {
  if (addresses.length) renderAddresses();
});
$("registration-filter").addEventListener("change", () => {
  if (addresses.length) renderAddresses();
});

if (token) refreshAddresses();
else $("list-status").textContent = signInMessage;
