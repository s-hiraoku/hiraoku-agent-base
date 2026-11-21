const $ = (id) => document.getElementById(id);
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

const fragment = location.hash.slice(1);
if (fragment)
  history.replaceState(null, "", location.pathname + location.search);
const token = /^[A-Za-z0-9_-]{43}$/.test(fragment) ? fragment : null;
const signInMessage = "閲覧には、起動時に案内されたファイルを開いてください。";

function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}

function stateBadge(state) {
  return element("span", stateLabels[state], "badge " + state);
}

async function loadJson(path, signal) {
  const response = await fetch(path, {
    headers: { Authorization: "Bearer " + token },
    cache: "no-store",
    credentials: "omit",
    redirect: "error",
    signal,
  });
  if (!response.ok) {
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
      request.signal,
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
