# 受信通知アダプタ：届いたメッセージを受信側の画面に出す

[ADR-021](../hab-decisions.md) · [エージェントごとの受信表示（ADR-026）](per-agent-display.md) · [共通 MCP 接続](../common-mcp-connection.md) · [受信後の引渡し](recipient-messages.md) · [受入条件（利用者指定）](receipt-confirmation.md)

HAB にメッセージが届いたら、受信側の利用者が使っているエージェントの画面に、次の形で知らせます。

```text
verify-a@grok-bot.hab からのメッセージです。
（質問、返信期限 2026-11-21T07:00:00.000Z）

受信内容
ビルドを確認できますか？

どうしますか？
1. 対応する
2. あとで
3. 対応しない
```

届いただけではモデルを動かしません。「対応する」を選んだときだけ、そのエージェントの同じセッションに依頼を渡します（利用者が許可した送信元だけ代わりに選ぶ設定もできます。[許可した送信元の自動受付](#許可した送信元の自動受付adr-023)）。返信はそのセッション自身が `hab_reply` で行います。

自分が送ったメッセージへの返事（`in_reply_to` があるもの）は、自分が頼んだことへの答えなので、軽い確認にします（利用者の判断、2026-11-15）。

```text
verify-b@dot.hab から返事が届きました。
（回答、あなたが送ったメッセージ "rm1.…" への返事）

受信内容
ビルドは緑です。

どうしますか？
1. 会話に渡す
2. あとで
```

「会話に渡す」は「対応する」と同じ処理で、既読にしてから同じセッションに 1 回だけ渡します。渡す文面（`handoff_prompt`）は「利用者が、HAB で届いた次の返事を会話に渡しました。」で始まり、元のメッセージの ID と、返事への返信は不要なことを伝えます。返事のカードに「対応しない」はなく、`decide … decline` は `invalid_request`（`allowed: ["accept","later"]`）で断ります。`hab_peek` は各メッセージに `choices`（`{choice, label}` の並び）を付け、各画面アダプタはそのとおりに出します。`choices` のない古い host からのメッセージは 3 つです。

受信通知は、質問をどの会話から送ったかを知りません。返事は、受信通知が結び付いた会話のカードに出ます。

## HAB が持つ部分と、各エージェントが用意する部分

| 役割 | 置き場所 |
| --- | --- |
| 既読にせずに新着を見つける | host の `hab_peek`（`/mcp/delivery`、操作 `poll`）。`next_cursor` を `after` に渡して続きを読む |
| 利用者に見せる文面（`display`）と、同じセッションへ渡す文面（`handoff_prompt`） | host（`src/messaging/incoming-notice.ts`） |
| 定期的な確認、表示済みの記録、選択の記録、二重実行の防止、期限切れ | `src/agent-notify/`（`ReceiptNotifier`、`SQLiteNotices`） |
| 選択後に既読にする | アダプタが受信者の credential で `hab_mark_read`（`/mcp/delivery`、`sender_id` と `message_id` を指定）を呼ぶ |
| 読む・返す | 受信側のセッション自身（`/mcp` の 4 ツール） |
| 画面に出す（`show`）と、同じセッションへ渡す（`handoff`） | 各エージェントの `AgentScreen` |

新しいエージェントをつなぐときに用意するのは `AgentScreen` の 2 つの操作だけです。`show` は `display` をモデルを動かさず発行します。`published` は発行のみ、`displayed` は製品の描画確認がある場合だけです。`handoff` は利用者が選んだ後に `handoff_prompt` をそのセッションへ入力し、`started`（受け付けた）・`queued`（入力に入れたが開始は未確認）・`unsupported`（正式な入口がない）のどれかを返します。正式な入口がなければ `unsupported` を返し、別のセッションや同じアドレスの CLI で代用しません。

製品に依存しない `JsonlScreen` も同梱しています。`notice`・`state` の各イベントを 1 行ずつ JSON で書きます。製品側の連携（表示専用の外部メッセージ欄など）がそのファイルを読み、選択を `hab-notify decide` で返します。ファイル書込みは実表示や入力受付の証拠ではないため、JSONL 単体の `handoff` は `unsupported` です。

## 動かし方

```json
{
  "hab_url": "https://<host>/hab/mcp",
  "agent_id": "<受信者の agent_id>",
  "as_address": "hermes-hab@hermes.hab",
  "token": { "file": "~/.hermes/profiles/<profile>/mcp-tokens/hab.json", "field": "access_token", "expires_at_field": "expires_at" },
  "store": "~/.hab-notify/hermes-desktop.sqlite",
  "screen": { "type": "jsonl", "path": "~/.hab-notify/hermes-desktop.jsonl", "target": "hermes-desktop:<session id>" },
  "interval_ms": 15000
}
```

```sh
npm run hab:notify -- --config notify.json run        # 常駐して確認を続ける
npm run hab:notify -- --config notify.json list       # 選択待ちの一覧
npm run hab:notify -- --config notify.json decide <message_id> accept|later|decline [sender_id]
npm run hab:notify -- --config notify.json show-again <message_id> [sender_id]
```

`run` は `interval_ms`（既定 15 秒、1 秒〜1 時間）ごとに `hab_peek` で受信箱を確かめます。HAB は時間で鳴らさないので（[ADR-032](../hab-decisions.md)、ADR-031 は置き換え済み）、決まった間隔で見るのはこの notifier の側です。間隔は利用者がこの設定で決めます。

`wake` を書くと、HAB の呼び鈴で起きます（ADR-032）。`run` は `127.0.0.1:<port>` で待ち受け、HAB の運用者登録の呼び鈴（[MCP イベント](../connections/mcp-events.md#運用者が登録する呼び鈴adr-029)の `url` に `http://127.0.0.1:<port>/wake`）が鳴るとすぐに 1 回確かめます。`interval_ms` は取りこぼしの保険として残します（おすすめは 5 分）。

```json
"wake": { "port": 8795, "secret_file": "~/.hab-notify/local-lab/wake.secret" }
```

鍵は `whsec_` で始まる 1 行で、所有者だけが読めるファイル（`chmod 600`）に置き、HAB の呼び鈴の `secret_file` と同じものにします。受け口は Standard Webhooks の署名と 5 分以内の時刻を確かめ、合わない要求は 401 で断ります。通常の呼び鈴は本文を使わず HAB の受信箱を確かめます。`session_probe` を設定すると、本文のアドレスとセッションも照合します。

token は呼ぶたびにファイルか環境変数から読みます（エージェント側が更新する token をそのまま使えます）。アダプタは token も本文も表示しません。`token.file` の形式はエージェントごとに確認してください。

`token.file` と `token.env` では、token の更新はエージェント側の仕事で、アダプタは更新しません。エージェントを使っていない間も通知を出し続けたいときは、次の [notifier 専用のログイン（`token.oauth`）](#notifier-専用のログインtokenoauth) を使います。Hermes は `expires_at`（期限の UNIX 秒）を書き、期限が切れたあと、自分の次の接続（約 3 分ごと）で更新します。`expires_at_field` を指定すると、期限を過ぎた token は HAB に送らず、`{"error":"token_expired"}` を返します。token の欄が空なら `token_unavailable` です。どちらも `transport_failed`（HAB に届かない、応答がおかしい）とは分けて出ます。`run` は期限切れの間もそのまま待ち、エージェントが更新した次の確認から自然に戻ります。

- `expires_at_field` がなくても、token が JWT なら `exp` を読みます。過ぎているか 5 秒以内に切れる token は、同じく HAB に送らず `token_expired` です。期限は署名を確かめずに読むだけで、判断するのは HAB です。中身の読めない token と `exp` のない JWT は、そのまま HAB に送ります。
- `run` は、同じ失敗が続くあいだ、始まりに `{"error":"token_expired"}` を 1 回、直ったときに `{"resumed":"token_expired"}` を 1 回だけ書きます。確認のたびには書きません。ほかの失敗（`transport_failed` など）も同じ扱いです。
- 待っているあいだにボタンを押しても、選択は失われません。「対応する」は `accept_waiting`、「対応しない」は `declining` として残り、token が更新された後の確認で既読にして続きを進めます（[選択と状態](#選択と状態)）。「あとで」は HAB を呼ばないので、そのまま `later` になります。

### notifier 専用のログイン（`token.oauth`）

`token.oauth` にすると、notifier が自分の OAuth の許可（grant）を持ち、期限の前に自分で更新します。エージェントが止まっていても新着を拾えます。

```json
"token": {
  "oauth": {
    "file": "~/.hab-notify/<profile>/token.json",
    "token_endpoint": "https://<tenant>/oauth/token",
    "authorization_endpoint": "https://<tenant>/authorize",
    "client_id": "<エージェントと同じ public client>",
    "redirect_uri": "http://127.0.0.1:<port>/callback",
    "resource": "https://<host>/hab/mcp"
  }
}
```

```sh
npm run hab:notify -- --config notify.json login   # 最初に 1 回だけ。表示された URL をブラウザで開く
```

- エージェントの token ファイル（Hermes の `mcp-tokens/hab.json` など）は読みも書きもしません。同じ refresh token を両方が使うと、回転（rotation）した古い refresh token をもう一方が使った時点で「再利用」とみなされ、Auth0 は家族ごと失効させます（エージェント側も切れます）。notifier 専用のファイルなら、取り合いも書き込みの競合も起きません。
- `client_id` はエージェントと同じ public client で構いません。HAB は主体と client で接続を照合するので、同じアドレスとして受け付けます。`redirect_uri` はその client に登録済みの loopback URL を使います（Hermes の固定 `redirect_port` と同じでよい。Hermes が自分のログイン中でなければ空いています）。
- `login` は認可コード＋PKCE（S256）です。`state` の合わない応答は受け付けません。scope の既定は HAB の 5 scope と `offline_access` で、`scope` で変えられます。Auth0 で `resource` を対応付けていないテナントなら `audience` も指定します。表示するのは開く URL と `{"logged_in":true,"has_refresh_token":…}` だけで、token は出しません。
- token ファイルは 0600 で、書き換えは同じフォルダの一時ファイルから rename で置き換えます。グループや他人が読めるファイルは `insecure_token_file` で断ります。
- 期限の `refresh_before_s`（既定 60 秒）前になったら、次の確認で更新します。`run` と、画面から呼ばれる `action`・`decide` が同時に更新しようとしても、`<file>.lock` を持った 1 つだけが更新し、ほかはその結果を読みます。60 秒より古いロックは、死んだプロセスの残りとして消します。
- 失敗の名前: ファイルがない、または refresh token がなく期限切れ → `token_login_required`。issuer が `invalid_grant` で断った（失効・期限切れ・再利用）→ `token_login_required`（`login` をやり直す）。通信の失敗や 5xx → `token_refresh_failed`（次の確認でやり直す）。ロック待ちが長すぎる → `token_refresh_busy`。どれも `run` では始まりと終わりに 1 回だけ記録します。

### 常駐させる（macOS の launchd）

`run` は、手で起動しただけでは再起動やログアウトで止まります。macOS では、利用者の LaunchAgent として登録します。作り方と確認は [HAB host の LaunchAgent](../operations/host-launchagent.md) と同じです。マージ済みのコミットから作ったリリースを内蔵ディスクに置き、既存のジョブと名前が重ならないことを確かめ、`~/Library/LaunchAgents/` に 0600 で新しく作ります。次はひな形で、そのままでは読み込めません。

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>local.hab.notify.PROFILE</string>
  <key>ProgramArguments</key><array>
    <string>/ABSOLUTE/RELEASE/runtime/bin/node</string>
    <string>/ABSOLUTE/RELEASE/source/scripts/hab-notify.ts</string>
    <string>--config</string>
    <string>/ABSOLUTE/HOME/.hab-notify/PROFILE/notify.json</string>
    <string>run</string>
  </array>
  <key>WorkingDirectory</key><string>/ABSOLUTE/RELEASE/source</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>ProcessType</key><string>Background</string>
  <key>Umask</key><integer>63</integer>
  <key>StandardOutPath</key><string>/ABSOLUTE/HOME/.hab-notify/PROFILE/run.log</string>
  <key>StandardErrorPath</key><string>/ABSOLUTE/HOME/.hab-notify/PROFILE/run.err.log</string>
</dict></plist>
```

- `run` が書くのは、表示した ID、失敗の名前、`resumed` だけです。token も本文も書かないので、ログは所有者だけが読めるファイル（`Umask` 63 で 0600）に残せます。同じ失敗は始まりと終わりの 1 行ずつなので、ログはほとんど増えません。
- `SIGTERM` を受けると、その回の確認を終えてから終了コード 0 で止まります（長くても `interval_ms` 待ちます）。`KeepAlive` が true なので、どんな終わり方でも 30 秒おいて起動し直します（[ADR-024](../hab-decisions.md)。黙って止まると新着に誰も気づかないため）。意図して止めるのは、下の `bootout` だけです。
- `bootout` で止めるのは、このジョブだけです。止めている間に届いたメッセージは未読のまま HAB に残り、次に起動したときにカードになります。選択の記録（`store`）は消しません。
- ログインしている間だけ動くジョブです。ログアウト中は、エージェント（Hermes Desktop）も動いていないので、カードを出す先もありません。

```sh
launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/local.hab.notify.PROFILE.plist"
launchctl print "gui/$(id -u)/local.hab.notify.PROFILE" | grep -E 'state|pid'
launchctl bootout "gui/$(id -u)/local.hab.notify.PROFILE"
```

同じ `store` を使う `run` は 1 つだけにします。手で起動した `run` があれば、先に止めてから読み込みます。

## Hermes Desktop

Hermes Desktop には、保存済みの会話に「外部メッセージ」を表示専用で出す欄があります。対象は Mac mini のローカル版 Hermes で、`hermes_cli/web_routers/external_messages.py` と `website/docs/developer-guide/external-message-display.md` にあります。カードは会話とモデル文脈の外に出るので、表示してもモデルは動きません。Desktop は、プロファイル設定 `external_messages.readers` に書いた読み取りコマンドを実行し、`stored_session_id` が一致する会話にだけカードを出します。

`screen.type` を `hermes-desktop` にすると、`HermesDesktopScreen` が通知を JSON Lines のファイルに書きます。`hab-notify events` がその読み取りコマンドです。Hermes が付ける `--limit 100 --after <cursor>` を受け取り、Hermes が求める形のページ（`paging: cursor-v1`）を 1 行の JSON で返します。`events` は画面ファイルを読むだけで、token・選択の記録・HAB には触れません。各通知には書いたときの結び付け（会話・プロファイル・reader・受信者）を記録し、設定が変わった後は古い通知を新しい会話の通知として返しません。

```json
"screen": {
  "type": "hermes-desktop",
  "path": "~/.hab-notify/hermes-desktop.jsonl",
  "session_id": "<Desktop の会話 ID>",
  "profile": "local-lab",
  "backend_namespace": "<reader の backend_namespace>",
  "profile_scope": "<reader の profile_scope>",
  "handoff": {
    "command": ["/absolute/path/to/hermes-venv/bin/python", "-B", "-m", "hermes_bridge.desktop_handoff"],
    "cwd": "/absolute/path/to/hiraoku-agent-base/experiments/source-handoff/hermes-owner-binding",
    "env": { "HERMES_HOME": "~/.hermes/profiles/local-lab の絶対パス", "HERMES_SOURCE": "~/.hermes/hermes-agent の絶対パス" }
  }
}
```

```yaml
external_messages:
  readers:
    - paging: cursor-v1
      backend_namespace: <上と同じ>
      profile_scope: <上と同じ>
      cwd: /absolute/path/to/hiraoku-agent-base
      command: [/absolute/path/to/node, scripts/hab-notify.ts, --config, /absolute/path/to/notify.json, events]
      actions_command: [/absolute/path/to/node, scripts/hab-notify.ts, --config, /absolute/path/to/notify.json, action]
```

Hermes の欄は、本文が 128 KiB を超えるカードを受け付けません（1 枚でも超えるとページ全体が出なくなります）。そのため、長い文面は先頭から 128 KiB 以内で切り、「途中までを表示しています」と添えます。「対応する」で会話に渡すのは全文です。

画面ファイルには 1 行を丸ごと書くか、まったく書かないかのどちらかです。書き込みの途中で落ちて切れ端が残った場合は、次の書き込みの前に改行を入れて区切ります。読み取り側は、読めない行と改行で終わっていない最後の行を飛ばします。

Hermes の欄は `handoff_state: pending` のカードしか受け付けません。そのため、選んだ後もカードの本文は表示したときのまま残ります。

カードの `choices` に応じたボタン（通常は「対応する」「あとで」「対応しない」、返信は「会話に渡す」「あとで」）は、Mac mini のローカル版 Hermes（ブランチ `hab-external-message-actions`）に足したものです。reader に `actions_command` があるときだけ出ます。押すと Desktop の `POST /api/sessions/{id}/external-messages/decision` が、そのカードの `{action: "decide", binding_id, backend_namespace, profile_scope, receiver_id, sender_id, message_id, stored_session_id, choice}` を `hab-notify action` の標準入力に 1 回渡します。Desktop 自身はモデルを動かしません。`hab-notify action` は次のどれかが自分の設定と違えば `binding_mismatch` で断り、記録にも HAB にも触れません。

- `binding_id`（接続先・受信者・会話を含む完全な結び付け）
- `stored_session_id`（会話）
- `backend_namespace`
- `profile_scope`
- `receiver_id`（受信者）

設定と合っていれば `decide` と同じ処理をして `{changed, state, revision}` を返します。カードにはその状態（「この会話に渡しました。」など）を出します。ボタンのない Hermes では、これまでどおり `hab-notify decide` で選びます。

会話を開き直したときや Desktop を再起動したときは、Desktop が同じコマンドに `{action: "states", binding_id, backend_namespace, profile_scope, receiver_id, stored_session_id}` を渡し、その会話のカードがそれぞれどうなったかを `{states: [{sender_id, message_id, state, revision, choices}]}` で受け取ります。結び付けの確かめ方は `decide` と同じで、HAB は呼びません。Desktop は、選択待ち（`shown`）のカードだけにボタンを出します。「あとで」（`later`）のカードは、選んだ状態を示したまま、そのカードの `choices` に含まれる他の選択肢を使えます。返信カードは「会話に渡す」「あとで」の 2 択で、通常の依頼は 3 択です。決まったカードには状態だけを出し、ボタンは出しません。

「対応する」を選ぶと、`handoff.command` を 1 回だけ実行します。標準入力には `{session_id, text, submission_id}` を渡します。このコマンドは `hermes_bridge.desktop_handoff` で、Hermes の実行環境で動きます。動きは次の 3 段です。

1. Hermes 自身の gateway クライアント（`tui_gateway.owner_forward` の `discover_owner` と `connect_owner`）で、そのプロファイルの gateway を探します。gateway は起動しません。
2. `session.resume` で保存済みの会話に接続します。
3. `prompt.submit` で、その会話の FIFO に依頼を入れます。

Desktop が表示している同じ会話で動くので、別の CLI セッションは作りません。HAB は呼ばず、返信もしません。返信はその会話自身が `hab_reply` で行います。

コマンドの答えは次のように扱います。

| 答え | 記録 |
| --- | --- |
| `queued` | `queued` |
| `refused`（gateway がない、会話が開けない、書き込み前に拒否された） | `unsupported` |
| `unknown`、または失敗 | `unknown`。自動では再送しません |

`handoff` を設定しなければ `unsupported` です。

### 会話が終わったことを HAB に知らせる（`session_probe`、ADR-032）

`screen.session_probe` を書くと、notifier は結び付けた会話がまだあるかを Hermes に確かめます。

```json
"session_probe": {
  "command": ["/absolute/path/to/hermes-venv/bin/python", "-B", "-m", "hermes_bridge.desktop_session"],
  "cwd": "/absolute/path/to/hiraoku-agent-base/experiments/source-handoff/hermes-owner-binding",
  "env": { "HERMES_HOME": "~/.hermes/profiles/local-lab の絶対パス", "HERMES_SOURCE": "~/.hermes/hermes-agent の絶対パス" }
}
```

`hermes_bridge.desktop_session` は標準入力の `{session_id}` を受け取り、プロファイルの `state.db` を Hermes 自身の `SessionDB` で読み取り専用で開いて、1 行で答えます。書き込みも Hermes の起動も HAB の呼び出しもしません。Desktop の HAB プラグインと同じく、カードを表示できる現在のセッション ID を確認します。

| 答え | いつ |
| --- | --- |
| `present` | その ID の会話にカードを表示できる |
| `gone` | その ID の会話がない、アーカイブ済み、または圧縮後に新しい ID へ移った |
| `unknown` | `state.db` がない、開けない、読めない |

notifier は呼び鈴を受けたとき（署名を確かめた後）と、毎回の確認の前（1 回だけの `check` も同じ。`gone` または `unknown` なら `shown: []` と `session` に判定結果を返します）に、このコマンドを実行します。1 回の答えは 5 秒間使い回し、3 秒で打ち切ります。

- 署名済みイベントの `data.to` が `as_address` に、`data.session` が `screen.session_id` に一致し、判定が `gone` のときだけ `410` と `{"reason":"session_gone"}` で答えます。`as_address` を設定し、`hab:admin session` で同じ Hermes のセッション ID を登録してください。判定が `gone` または `unknown` の間は受信箱を確認せず、未読は HAB に残ります。HAB は続けて 3 回のこの答えで、そのアドレスを「相手がいない」（`recipient_absent`）にします（[MCP イベント](../connections/mcp-events.md#相手のセッションが終わったときadr-032)）。
- 一致した呼び鈴に `present` で答える場合は `200` で受け取り、すぐに受信箱を確かめます。`unknown`（実行失敗や時間切れを含む）や宛先・セッションの照合ができない場合は `200` と `{"reason":"session_unconfirmed"}` を返します。この応答で HAB の「相手がいない」判定は変わりません。
- `run` のログには、最初の答えと、答えが変わるたびに `{"at":…,"session":"present"|"gone"|"unknown"}` を 1 行出します。ずっと `unknown` なら、コマンドの設定か Hermes の読み込みを見直してください。

会話を戻すには、アーカイブを解除するか、[結び付けの移行](#safe-migration-and-verification-limits)に沿って notifier と HAB 台帳を新しいセッション ID に合わせます。notifier が `present` を確認して `hab_peek` を呼ぶと、HAB は「相手がいない」を外します（本人が自分の受信箱を見たことになるため。`hab_inbox` でも同じ）。「相手がいない」の間は HAB が新しい送信を断るので呼び鈴は鳴りませんが、notifier の定期確認（`interval_ms`）で戻ります。

`session_probe` を書かなければ、これまでどおり確かめずに `200` で答えます。

## Codex・Claude Code・ChatGPT コネクタ（Dots）

Hermes 以外の 3 製品にも画面アダプタを用意しました。実機にはまだつないでいません。設定ファイルの `screen` を書き換えれば、後からそのまま接続できます。3 つとも通知は同じ形の JSON Lines ファイル（`JsonlScreen` と同じ `notice`・`state` 行、`handoff` 行は書かない）に残します。`display_command` を設定すると、通知ごと・状態が変わるごとに、そのコマンドを 1 回実行します。標準入力には `{type: "notice" | "state", target, message_id, sender_id, …, display}` を 1 つの JSON で渡すので、デスクトップ通知などに使えます。コマンドは設定ファイルに書いた絶対パスだけで、メッセージから組み立てることはありません。コマンドが失敗した通知は `showing` のまま残り、次の確認で出し直します。

### 各製品の公開の仕組みと、できること・できないこと

| 項目 | Codex | Claude Code | ChatGPT コネクタ（Dots） |
| --- | --- | --- | --- |
| 自動新着検知 | 対応（`hab:notify run`） | 対応（`hab:notify run`） | 対応（`hab:notify run`） |
| 製品の画面への受信通知・対応確認 | **非対応**。app-server には表示専用の通知がない。`thread/inject_items` はモデルが読む履歴に入るので使わない。通知はファイルと `display_command` で出す | 対応：status line（`hab-notify statusline`）。モデルには渡らない | **非対応**。ChatGPT に外から表示を出す公開の仕組みがない。通知はファイルと `display_command` で出す |
| 既存セッションへの正式な引渡し | 実装済み・**実機未確認**：起動中の app-server に WebSocket で接続し、`thread/resume` → `turn/start` | **非対応**：同梱 channel は現在の会話を原子的に照合できないため `unsupported` | **非対応**（`unsupported`）。利用者が会話を開き、`hab_inbox {"include_read": true}` で読むよう頼む |
| 利用者判断の保持とメッセージとの結び付け | 対応（共通の選択記録） | 対応（共通の選択記録） | 対応（共通の選択記録） |
| 同一セッションからの処理・返信 | 未確認（そのスレッドが HAB MCP の `hab_reply` を使える設定が必要） | 未確認（そのセッションに HAB MCP が必要） | 手動（会話の中で `hab_inbox {"include_read": true}`・`hab_reply`） |
| 開始の確認 | `turn/start` の結果に turn があれば `started` | 同梱 channel は `unsupported`。起動時の session ID だけでは引き渡さない | — |

### Codex

Codex には、他のプログラムから使う公開の口として app-server（`codex app-server`、JSON-RPC 2.0、`jsonrpc` 欄は省く）があります。

```json
"screen": {
  "type": "codex",
  "path": "~/.hab-notify/codex.jsonl",
  "thread_id": "<Codex のスレッド ID（thread/list で分かる）>",
  "app_server": { "url": "ws://127.0.0.1:4500", "token_file": "~/.hab-notify/codex-ws-token" },
  "display_command": { "command": ["/usr/bin/osascript", "/absolute/path/to/notify.applescript"], "cwd": "/absolute/path" }
}
```

「対応する」を選ぶと、そのスレッドを開いている app-server の WebSocket（`--listen ws://127.0.0.1:PORT`、`--ws-auth capability-token --ws-token-file …`）に接続し、`initialize` → `initialized` → `thread/resume {threadId}` → `turn/start {threadId, input: [{type: "text", text: handoff_prompt}]}` を送ります。`timeout_ms`（既定 30 秒）は接続の確立から `turn/start` の答えまでの全体にかかります。token は接続時に `Authorization: Bearer` で渡し、表示しません。自分で app-server や `codex exec` を起動することはありません（利用者が見ていないところで動くため）。

| 答え | 記録 |
| --- | --- |
| `turn/start` の結果に turn がある | `started` |
| `app_server` の設定がない、接続できない、`initialize`・`thread/resume`・`turn/start` がエラーを返した（作業中で受け付けないときを含む）、`turn/start` を送る前に時間切れ（接続や WebSocket のハンドシェイクが終わらないときを含む） | `unsupported` |
| `turn/start` を送った後に切れた・時間切れ | `unknown`。自動では再送しない |

未確認の点：Codex の画面（デスクトップアプリや VS Code 拡張）が使っている app-server に、外から WebSocket で入れるか。別の接続で始めたターンが、利用者の画面にそのまま流れるか。接続を閉じた後もターンが続くか。

ChatGPT アプリの Codex の会話は、アプリが stdio で動かす app-server の上にあり、WebSocket の待ち受けがありません（2026-11-21 Mac mini で確認）。
この会話には `app_server` の代わりに `queue` を設定します。両方を書くと設定エラーです。

```json
"screen": {
  "type": "codex",
  "path": "~/.hab-notify/codex.jsonl",
  "thread_id": "<Codex の会話の UUID>",
  "queue": {
    "codex_bin": "/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex",
    "daemon_socket": "/Users/<user>/.codex/app-server-control/app-server-control.sock"
  }
}
```

「対応する」か ADR-023 の自動受付の後だけ、既読にしてから `codex queue --thread <thread_id> --message <handoff_prompt> --remote unix://<daemon_socket>` を引数の配列で実行します。シェルは通しません。20 秒で打ち切ります。
新着を出す・出し直す・あとで、では `codex` を実行せず、未読のままです。
`codex queue` が依頼を積む先は、運用者が `codex app-server daemon start` で起動しておく daemon です。notifier は daemon を起動しません。
2026-11-21 の試しでは、積んだ依頼をアプリの待機中の会話が 7 秒後に自分で始めました。

| 答え | 記録 |
| --- | --- |
| 終了コード 0 | `queued`（会話の入力に積まれた。始まったかは別に見る） |
| `No active session found matching`、`does not support thread/queue/add`、`cannot queue through an embedded app server` を出して終わった（何も積まれていない） | `unsupported` |
| それ以外の終了、daemon に届かない、20 秒の時間切れ、`codex` が見つからない | `unknown`。自動では再送しない |

通知の記録は、ソケットのパスと会話ごとに分かれます。WebSocket の設定や表示だけの設定から切り替えると、前の記録は使いません。切り替える前に `list` で未処理の通知がないことを確かめ、戻すときは元の設定に戻せば元の記録をそのまま使えます。

### Claude Code

Claude Code では表示に status line を使います。channel の配送部はありますが、同梱 CLI は現在の会話を検証できないため引渡しを拒否します。

```json
"screen": {
  "type": "claude-code",
  "path": "~/.hab-notify/claude.jsonl",
  "session_id": "<Claude Code のセッション ID>",
  "channel_socket": "~/.hab-notify/claude/claude.sock"
}
```

表示：Claude Code の設定 `statusLine` に `{"type": "command", "command": "node /abs/scripts/hab-notify.ts --config /abs/notify.json statusline", "refreshInterval": 15}` を書きます。Claude Code はセッションの JSON（`session_id` を含む）を標準入力に渡し、出力を画面下に表示します。モデルには渡りません。`statusline` は `session_id` が設定と一致するときだけ、選択待ち（`shown`）の最も古い通知の `display` 全文と、選び方（`<node> <scripts/hab-notify.ts> --config <この設定> decide <id> accept|later|decline <sender_id>`。そのまま実行できるよう、動いている node・スクリプト・設定ファイルの絶対パスを入れ、同じ message_id の送信者が 2 人いても選べるよう sender_id も付ける）、残りの件数を出します。14 行を超える通知は途中で切り、`hab-notify show <id> <sender_id>` で全文を読めることを示します（`show` はローカルの選択記録から `display` 全文を出すだけです）。「あとで」にした通知は出しません。読むのはローカルの選択記録だけで、HAB には触れず、失敗しても何も出さないだけです。

引渡し：同梱 `scripts/hab-claude-channel.ts` は起動時の `--session-id` しか知りません。同一プロセスの `/clear` や別会話の再開を検知できないため、依頼を受けても `refused`（→ `unsupported`）を返し、channel event を送りません。起動時の ID を合わせるだけでは有効にできません。

製品側が「現在の会話の一致確認と、その同じ会話への入力受付」を原子的に保証できる場合に限り、`startChannelListener` の `deliverToSession(sessionId, content, meta)` を実装できます。別途 ID を読んでから無指定で送る方式は、途中の会話切替があるため不可です。このコールバックのモック試験はありますが、実 Claude Code で利用できる公式の保証付き API の実装はありません。

| 答え | 記録 |
| --- | --- |
| 同じ会話への受付を保証する製品アダプターが `queued` を返した | `queued`（モデル開始の証拠ではない） |
| 検証付き入口がない（同梱 CLI）、別会話、接続不可、`refused` | `unsupported` |
| 配送中の失敗・時間切れ | `unknown`。自動再送しない。重複要求も成功扱いに変えない |

### ChatGPT コネクタ（Dots）

Dots は ChatGPT のコネクタ（MCP クライアント）として HAB を使います。ChatGPT がツールを呼ぶのはモデルが決めたときだけで、widget もそのツール呼び出しの結果としてしか出ません。外から会話に表示を出したり、作業を始めさせたりする公開の仕組みはありません。そのため `handoff` は常に `unsupported` です。通知はファイルと `display_command` で ChatGPT の外に出します。「対応する」を選ぶと既読になるので、その後は利用者が Dots の会話で `hab_inbox {"include_read": true}`（既読も含めて 7 日間読み直せる）を使い、その message_id に対応するよう頼みます。別のセッションや CLI で代わりに処理することはしません。

```json
"screen": { "type": "chatgpt-connector", "path": "~/.hab-notify/dots.jsonl", "conversation": "dots" }
```

Dots の会話が実は Codex のスレッドとして app-server から見えるなら、`codex` の画面を使えば引渡しまでできます。これは未確認です。

## 選択と状態

| 状態 | 意味 | HAB 上 |
| --- | --- | --- |
| `showing` | 画面に出す途中。終わらなかったら次の確認で出し直す | 未読 |
| `shown` | 旧名称。通知を発行済み、選択待ち。実表示の証拠ではない | 未読 |
| `later` | 「あとで」。`show-again` で同じメッセージを出し直せる | 未読 |
| `declining` | 「対応しない」を受けて既読にしている最中。HAB に伝えられなかったとき、または途中で止まったときは、1 分たった後の確認で既読にし直して `declined` にする | 未読または既読 |
| `declined` | 「対応しない」。何も始めない | 既読 |
| `accepting` | 「対応する」を受けて渡している最中。通知アダプタが途中で止まり 15 分たっても残っていれば、次の確認で `unknown` にする（再送しない） | 既読 |
| `accept_waiting` | 「対応する」を受けたが、HAB に既読を伝えられなかった（token の更新待ちなど）。何も渡していない。確認のたびに既読にし直し、できたら渡す。返信期限を過ぎたら `expired` | 未読 |
| `started` / `queued` | セッションが受け付けた／入力に入れた | 既読 |
| `unsupported` | そのセッションへの正式な入口がない | 既読 |
| `unknown` | 渡せたか分からない。自動では再送しない | 既読 |
| `unavailable` | 選んだ時点で HAB がもう渡さない（期限切れ、読み直し期間後、送信者の権限取消し）。何も渡さない | — |
| `expired` | 選ぶ前に返信期限を過ぎた | 期限切れ |

- メッセージは `sender_id` と `message_id` の組で区別します。2 人の送信者が同じ `message_id` を使ったときだけ、`decide` に `sender_id` を付けます。
- 1 回の確認で、`hab_peek` のページを最後まで読みます。「あとで」の未読が多くても、新着は表示されます。
- 選択の記録は 1 つのセッション（`screen.target`）に結び付きます。別の `target` で同じ記録を開くと `notices_target_mismatch` で止まり、そのセッションへは渡しません。
- 表示できなかった新着や、表示の途中で止まった新着は `showing` のまま残り、次の確認で出し直します。
- 選択の記録と画面ファイル（`screen.path`）は本文を含むので、所有者だけが読める権限（0600）で作ります。他人が読める既存のファイルは書き込む前に拒否します（記録は `insecure_notices_file`、画面ファイルは `insecure_screen_file`）。
- 選択は行単位の条件付き更新で 1 回だけ通ります。二重クリック、再起動、並行の選択でも `handoff` は 1 回までです。
- HAB に既読を伝えられなかったときは何も渡しません。それでも選択は残し、選び直しは求めません。「対応する」は `accept_waiting`、「対応しない」は `declining` のまま、後の確認で続きを進めます。待っている間に押し直しても、記録は変わりません。
- 本文に「承認済み」などと書かれていても、選択の代わりにはなりません。届いたメッセージから `handoff` が呼ばれることはありません。

## 許可した送信元の自動受付（ADR-023）

既定では、どのメッセージも利用者が選ぶまで待ちます。`notify.json` に `auto_accept` を書くと、規則に合うメッセージだけ、カードを出した直後に受信通知が「対応する」を代わりに選びます。その後は手で選んだときと同じく、既読にしてから同じセッションへ 1 回だけ渡し、返信はそのセッション自身が `hab_reply` で行います。

```json
"auto_accept": {
  "rules": [
    {
      "name": "dots",
      "from": ["stallone@dot.hab"],
      "kinds": ["question", "notice", "answer"],
      "replies": true,
      "new_messages": true,
      "max_text_bytes": 16384
    }
  ],
  "max_per_sender_per_hour": 10,
  "max_per_thread": 6,
  "audit": "~/.hab-notify/local-lab/audit.jsonl"
}
```

| 項目 | 意味 |
| --- | --- |
| `rules[].name` | 記録に残す規則の名前（英小文字・数字・`_`・`-`） |
| `rules[].from` | 許可する送信元アドレス。HAB が認証した `from` と完全一致 |
| `rules[].sender_ids` | 任意。送信者の不変 ID も一致を求める（アドレスが別の送信者に付け替えられた場合に備える） |
| `rules[].kinds` | 許可する種類（`question`・`notice`・`answer` など） |
| `rules[].replies` / `new_messages` | 自分が送ったメッセージへの返事／新しいメッセージを対象にするか（既定はどちらも `true`） |
| `rules[].max_text_bytes` | 渡す文面（`handoff_prompt`）がこれを超えたら手動に戻す（既定 16 KiB） |
| `max_per_sender_per_hour` | 送信元ごとに直近 1 時間で自動で渡す上限（既定 10） |
| `max_per_thread` | 同じ thread で自動で渡す上限（既定 6）。自動同士の返し合いを止める |
| `audit` | notifier 専用の記録ファイル（0600、本文なし、1 MiB で `.1` に回す） |

- 本文のキーワードでは判定しません。送信者が簡単に合わせられるためです。
- 自動で渡す文面は、HAB の `handoff_prompt` の 1 行目を「規則『<name>』により自動で受け付けました。利用者はこのメッセージを見ておらず、選んでもいません」と、行ってよいのは読むことと `hab_reply` での返信だけで、ファイル変更・コマンド実行・返信以外の外部送信・設定や認証情報の操作は行わない、という指示に差し替えたものです。利用者はいないので、承認や確認を求めず、承認を待たずに `hab_reply` まで終えるよう書いています。承認なしで答えられる部分は答え、残りは利用者の確認待ちであることとその理由を返します（2026-11-18、初回試験で Hermes がコマンド実行の承認待ちで止まったため）。計算・要約・一般知識のようにツールで確かめなくても答えられることは、検証できないことを理由に控えず答えるよう書いています（同日、2 回目の試験で「18+27」に答えなかったため）。受信内容の枠はそのままです。1 行目が想定と違うときは書き換えず、手動に戻します（`auto_skip` の `unexpected_prompt`）。
- この指示は文面によるものです。実際に止められるのは、エージェント製品側の承認設定がかかる操作だけです。Hermes では導入前に、どの操作に承認がかかるかを確かめてください。
- 記録（`audit`）の 1 行は `{time, event, rule, sender_id, from, message_id, thread_id, kind, reply, result}` です。`event` は `auto_accept`（受け付ける前、`result: "accepting"`）・`auto_handoff`（結果の状態）・`auto_skip`（`too_long`・`sender_rate_limited`・`thread_limited`・`unexpected_prompt`）。`auto_accept` を書けないときは自動では選びません。どの規則にも合わないメッセージは記録しません。
- 上限の件数は選択の記録（SQLite の `auto_accepts`）から数えるので、再起動しても続きから数えます。上限で手動に戻したメッセージは、カードから普通に選べます。
- 自動で選ばれたカードも画面に出ます。Hermes Desktop のプラグインでは、会話に渡した（`queued`・`started`）カードのうち新しい 5 件を、入力欄の上に新しい順で出したままにします。自動受付は届いて数秒で会話に渡るので、届いたことと内容を見逃さないためです（2026-11-18、owner の要望）。読み終えたカードは、各カードの「閉じる」か、まとめて「すべて閉じる」で閉じた履歴に移せます（2026-11-20、owner の要望）。閉じるのはこの画面の表示だけで、HAB の判断・既読・cursor・会話には何も起きません。閉じたカードはその Desktop の localStorage に会話ごとに最大 200 件覚え、使えないときは画面を開き直すまで閉じたままにします。まだ選んでいない（`shown`・`later` など）カードには「閉じる」を付けず、選択肢で答えてもらいます。それより古いものと `declined`・`expired` は閉じた履歴に移ります。どのメッセージも、枠と「HAB」の印、「HAB からのメッセージ」という見出しの付いたカードで出し、HAB で届いたものだと分かるようにしています（同日、owner の要望）。

## 限界と未完了

- HAB の既読は、人が内容を見た・同意した・作業を終えたことを意味しません。
- ADR-017 の SDK 受信（保存してから ACK）と同じ受信者で並べて使わないでください。ACK された本文は `hab_peek` にも `hab_inbox` にも出ません。
- Hermes Desktop では、表示（外部メッセージ欄）、カードのボタン、同じ会話への引渡し（`prompt.submit`）を実装しました。ボタンはローカル版 Hermes のブランチにあり、Hermes 本体には入っていません。2026-11-15 に Mac mini の既存 Desktop セッションで、Dots から届いた 3 通について「あとで」と「対応する」から `hab_reply` までを確かめました。CLI だけの往復は Desktop の合格に数えません。
- Codex・Claude Code・ChatGPT コネクタ（Dots）の画面アダプタは、代わりの部品（偽の app-server、テスト用の MCP クライアント）でしか確かめていません。各製品の実機での表示・引渡し・返信は未確認です。

## Product-neutral adapter contract and synchronization

HAB owns delivery authentication, receipt lookup, decision persistence, expiry and the
at-most-once handoff guard. A product adapter owns only display, user-choice collection,
and admission into the explicitly bound existing conversation. Gemini CLI, Gemini App
and a Gemini API application are different products: this contract does **not** claim a
working native Gemini or Antigravity integration. Adding either later should require only
the product-owned adapter, not a second delivery or decision engine. No native integration
for either product is part of this change. The synthetic adapter contract tests demonstrate the
extension point, not a real Gemini session.

The local CLI provides a shared bridge for every configured screen:

- `binding` returns `binding_id`. Pin this at explicit integration setup, not on every
  click. The ID fences HAB endpoint, recipient, product and its configured session (and
  configured product connection). It is not a credential or a permission grant.
- `states` takes `{"binding_id":"...","keys":[{"sender_id":"...","message_id":"..."}]}`
  on stdin. The response includes `scope:"requested"`, the exact requested `keys`, and
  versioned `states` only for those retained rows. An absent row means authority is missing
  for that requested key, not for any other card. Poll retained cards even when the notice
  cursor is caught up. The Hermes legacy `action` with `action:"states"` accepts the same
  optional `keys` alongside its existing binding fields and returns choices with each state.
- `adapter-action` takes the same binding plus `sender_id`, `message_id` and `choice`
  (`accept`, `later`, `decline`). Its bounded reply contains the decision, `revision`, and
  a one-key snapshot with `scope:"requested"` and `keys:[the acted-on key]`, never the whole
  database. Do not treat other cards absent from this reply as missing. Only invoke it for
  the user's actual choice; receipt alone is not approval.

Requested-key batches allow at most 50 unique keys, with each ID at most 512 UTF-8 bytes.
An empty key list succeeds with an empty requested scope. Duplicate keys, oversized IDs
or input over 64 KiB are rejected before a decision. State query replies including newline
are limited to 60 KiB, below the Hermes command reader's 64 KiB ceiling. Oversized queries
return only `state_response_too_large`, never a truncated success. A single pathological
record may therefore remain unavailable; clients must not silently drop it. Keys omitted
retain the legacy whole-store response shape, but large stores explicitly fail that byte
limit. New integrations must request current card keys rather than repeatedly fetching all
history. On a failed batch, mark only those keys unavailable; validate echoed keys/scope and
preserve successful unrelated batches. A missing requested row is not permission to act.
The adapter-action response is small by construction (one bounded key, fixed binding hash,
state and revision, no body/choices), avoiding a post-decision whole-store size failure.

Each snapshot entry carries a SQLite-backed monotonically increasing `revision`. Use
`NoticeStateProjection` to keep immutable notice data separate from mutable decisions.
Merge both poll and action responses by revision, never response arrival order. Older
responses are ignored, same-revision disagreement is rejected, and another binding is
rejected. A repeated identical notice is harmless; changing its immutable content is not.
A failed/empty poll must not clear previously known decisions or enable action buttons.
Pending button state is transient UI state, not a replacement for authoritative decisions.
A missing decision has unknown status, not implicit permission to act.

The existing Hermes `events` cursor remains an immutable-notice feed for compatibility;
it is **not** a stream of decision updates. A Hermes consumer must poll the state API for
already displayed cards even after reaching the end of that feed and apply the revision
rules above. This HAB change does not update the separately maintained Hermes Desktop UI.
Its real rendering, polling and same-session behavior require independent product tests.

`shown` is a historical decision-state name meaning the adapter accepted publication.
It is not proof of pixels rendered, user attention, or model execution. File publication
is `published`; a product may claim `displayed` only with its actual display acknowledgement.
Likewise `queued` requires confirmed admission into that bound session, not a file write.
The JSONL transport cannot provide that guarantee and refuses handoff as `unsupported`.
The Claude Code static channel session label cannot establish identity after `/clear` or
resume; without an atomic product-side bound-session delivery implementation it refuses
handoff. No fallback CLI, new session or address impersonation is permitted.

### Safe migration and verification limits

Binding identity is now connection/recipient/session specific. Opening an old decision
store under a changed binding fails with `notices_target_mismatch`. Do not relabel that
store or silently create an empty replacement: that could lose the guard against duplicate
handling. Stop the old notifier, preserve its records, reconcile in-flight decisions and preserve terminal unknown outcomes,
and explicitly configure the intended binding before migration. No running notifier,
credential, profile, Desktop installation or deployment is changed by this PR.

Rollback: this is a draft, with no automatic deployment or database rebinding. Before a
manual rollout, stop only the owned notifier and take an offline consistent backup of its
SQLite database and private screen file together with the configuration. Keep the old
binding's decision history. Restoring an old database snapshot after new decisions have
been made can replay previously handled mail, so it is not a safe routine rollback. If the
new version has accepted any choices, keep it stopped and reconcile that history before
restoring an older release; do not run old and new notifiers concurrently. The SQLite
revision-column migration is additive, but the stricter identity format is deliberately
not auto-rewritten back to a legacy target. JSONL and bundled static Claude handoffs that
previously returned `queued` now return `unsupported`; this is an intentional safety
restriction, not a claim of feature equivalence. Native integrations must provide actual
same-session admission before enabling that capability again.

The Hermes-specific legacy `action` request also requires the exact common `binding_id`
from its event/setup, in addition to its existing reader fields. Requests without this
connection fence are rejected, not guessed. Existing Hermes consumers need to propagate
this field before enabling actions with this version. Old events without the configured
HAB connection identity are not relabelled for a new connection.

### Gemini の接続対象と残る製品側実装（2026-11-15 調査）

「Gemini」は以下の別製品を区別します。共通契約のテスト成功を、実製品での通知表示・同じ既存会話への引渡し成功とは扱いません。

| 対象 | 公式に確認できた入口 | この実装に必要なもの |
| --- | --- | --- |
| Gemini CLI を利用する既存 ACP ホスト／IDE | ACP の stdio 接続と session ID を指定した prompt。現在の接続をホストが所有する | 利用中のホスト（Zed、JetBrains、独自 UI 等）を特定し、そのホスト内に通知表示・判断操作・同じ既存接続への入力受付を実装する |
| ターミナルの Gemini CLI | MCP ツール利用。組込み通知は作業完了・ユーザー操作待ち向け | 外部 HAB 通知カードを既存 TUI に追加し、既存会話へ入力する正式な入口は今回の調査で未確認。別の `gemini --acp`／resume 起動で代用しない |
| Gemini Apps（Web／モバイル） | Custom Connected Apps の remote MCP、ツール結果に紐付けた MCP Apps UI | 外部から既存会話へのプッシュ通知・モデルを動かさないカード追加の入口は未確認。ユーザー起点のツール利用と区別する。公式利用条件・対象アカウントの確認も必要 |
| Gemini API を使う独自アプリ | Interactions API の `previous_interaction_id` による会話継続 | その独自アプリが表示・判断・会話継続を所有する。Gemini Apps や既存 CLI の会話には接続したことにならない |

Gemini CLI の ACP はクライアントとエージェント間の stdio 接続です。新しいプロセスで過去セッションを読み込むことは、利用者が現在見ているプロセス・画面への接続ではありません。実機の `@google/gemini-cli` 0.45.2 のインストール済みコードも読み取り確認し、prompt は当該プロセス内の session map を参照し、loadSession は保存履歴から session を構築することを確認しました。エージェント起動・認証・実メッセージ送信は行っていません。

既存の `src/owner-integrations/acp-stdio.ts` は、明示的に許可された専用プロセスを起動し `session/new` で専用セッションを作る別用途の owner driver です。`fixedWake` は信頼済み固定文のみで、受信本文を流す入口ではありません。`acp-updates.ts` は進捗フレームの検証・制限用であり、通知カードの表示機構ではありません。この専用 owner driver を「既存会話アダプター」として流用しません。

次の実装単位は新しい共通層ではなく、利用する製品ホスト内の薄い `AgentScreen` です。共通の binding・判断永続化・revision 同期を使い、ホストが通知を描画し、明示的な選択後に現在の接続／会話を照合して入力します。ホスト・製品・対象会話が未指定の段階では実接続を有効にしません。

2026-11-19 追記：Gemini CLI は 2026-06-18 に個人向けの提供を終え、Antigravity CLI に移りました。Antigravity（アプリ・IDE・CLI）と Gemini アプリの接続方式・受信通知・表示の入口は [GeminiとAntigravityの接続](../connections/gemini-antigravity-connection.md) にまとめています。

公式確認先：
- [Gemini CLI ACP mode](https://geminicli.com/docs/cli/acp-mode/)（stdio と session 操作）
- [Gemini CLI notifications](https://geminicli.com/docs/cli/notifications/)（作業完了・操作待ち通知であり HAB 到着通知ではない）
- [Connected Apps MCP developer guide](https://developers.google.com/connected-apps/mcp)（ユーザーのクエリによる呼出し、ツール結果と UI resource の結合）
- [Gemini Apps custom apps](https://support.google.com/gemini/answer/17209137?hl=en-JS)（確認時点では US・個人 Google アカウント・英語等の条件。利用可否を推測しない）
- [Interactions API](https://ai.google.dev/gemini-api/docs/interactions-overview)（API アプリ独自の会話継続）

### Explicit offline legacy-store copy migration

`node scripts/hab-migrate-notices.ts inspect PLAN.json` validates an offline source and
returns its fingerprint, binding labels and state counts (not message bodies). This does
not infer the legacy connection/recipient, change configuration or authorize migration.
The plan contains `source`, a new `destination_directory`, `expected_source_target`, and
`destination_binding` (`product`, `connection_id`, `recipient_id`, `session_id`, optional
`profile`). Copy `destination_binding` from `hab-notify --config <new-config> binding`, whose
`binding_id` must equal the migration report destination target. Do not guess product names
or connection strings. This read-only command does not open the old decision store. Source and destination parent must be canonical,
owner-private paths. Symlinks, a busy writer, pending WAL/rollback journal, or unsettled states (`showing`,
`accepting`, `accept_waiting`, `declining`) are refused. Reconcile those states
without deleting their duplicate guards; this tool does not supply that reconciliation.
An existing `unknown` outcome is terminal and may be copied unchanged, retaining its
revision, decision timestamp and original message. It remains unknown, not a successful
handoff, and migration never retries it. Reopening/checking or selecting accept/later/decline
does not re-admit that retained record or mark it read again.

Only after an operator independently verifies the original connection, recipient and
existing conversation, stops all old notifiers, and commits not to restart that source:
add the inspected `expected_source_sha256` to the plan and supply a separate attestation
file containing both `notifiers_stopped_and_source_will_not_restart: true` and
`old_connection_recipient_and_existing_session_verified: true`. Run
`node scripts/hab-migrate-notices.ts migrate PLAN.json ATTESTATION.json`.
These are operator assertions, not facts proven by old database contents. An exclusive
SQLite transaction fences concurrent writers during copying; it cannot stop an old binary
from reopening the source after the command exits. Maintaining the offline cutover is an
operator prerequisite, not an automatic safety guarantee.

For a legacy Hermes store, `hermes_screen` is required: `source` is the paired private
JSONL file, `legacy_binding` is the exact old tuple `[session_id, profile,
backend_namespace, profile_scope, receiver_id]`, and `expected_source_sha256` is the
screen fingerprint from inspection. The database and screen must come from the same
offline source and verified binding. Migration refuses missing required notices,
unsupported missing-decision records, payload or binding disagreement, incomplete screen
records and changed fingerprints.
Do not generate a replacement empty feed or bind unrelated historical messages.

The decision store's seven-day retention pruning can leave older Hermes JSONL notices
without a corresponding database decision. Legacy JSONL has no structured expiry, so a
missing row is **not proof of legitimate expiry**. Such complete, internally consistent
legacy notices and their associated historical state lines are quarantined in place:
the converted feed preserves their original bytes, old binding, line order and cursor
positions. They are not rebound, inserted back into the decision database, or displayed
by the new binding-aware UI. State-only records without a matching notice, notices with
a different binding, and conflicting duplicate payloads are refused; retained database
rows must still match their notice payload. The original feed and database backups are
kept unchanged. Inspection and the manifest report `screen_quarantined_notice_count`
(unique notice keys), `screen_quarantined_notice_lines` (notice-line count), and
`screen_quarantine_reason: "unverifiable_missing_decision"`; review these counts before
cutover rather than treating quarantine as verified expiry. This prevents old-feed
redisplay only: it is **not a tombstone** that rejects future HAB redelivery of a key
whose database record was pruned.
The SQLite transaction does not lock JSONL writers. Inode and fingerprint checks reject
observed changes, but cannot prevent a write after the final check. All old feed writers
must remain stopped under the explicit offline attestation throughout migration/cutover.

The command atomically publishes one private new directory containing `source.sqlite`
(unaltered database backup), `notices.sqlite` (rebound copy preserving decisions/revisions),
`source-screen.jsonl` (original Hermes feed), `screen.jsonl` (matching converted feed),
and `manifest.json` (fingerprints and attestation). Screen files apply to Hermes migration;
other supported store-only migrations omit them. Neither source is overwritten. Point the
new configuration at the paired `notices.sqlite` and `screen.jsonl` from this same bundle,
not at a mixed old/new pair. Stop all producers and consumers during cutover. Restart
Hermes Desktop or explicitly clear the affected external-message feed/cache and its paging
cursor before enabling the new reader: replacing files alone does not remove cached cards
with the old binding. This cache reset is an operator cutover step, not performed by the
migration command. Keep the old feed and database together as evidence; do not run them.

Repeated execution refuses an existing destination rather than replacing later decisions.
A crash before publication can leave a private staging directory or `.migration-lock`;
inspect and reconcile that attempt before clearing it, never blindly rerun another path.
No automatic launch, deployment, credential edit or rollback occurs. Do not point a
notifier at the backup. Never restore the old snapshot after new choices without explicit
reconciliation: a restored snapshot could execute a previously handled message again.

### Hermes Desktop companion status (2026-11-15)

A separate, unapplied Hermes companion commit `99dc5e1aef21e719e87b004d3093376ac2734708`
was prepared against `b189f28f7462e1cbb568db6878f096277048c079` of the
`hab-external-message-actions` branch. It is not included in this HAB repository and is
not an installed release. It propagates exact binding IDs through decisions and retained-card
state queries, uses revision-monotonic merges, and disables actions when authoritative
state is unavailable. It preserves the current reply-specific choices and rejects delayed poll
responses; a fresh complete snapshot can restore temporarily unavailable actions. A complete empty snapshot differs from a failed query; immutable
notice identity is checked independently of mutable decision state. The configured trusted
action command must enforce the full connection/recipient/session binding (the HAB command
does); the UI cannot prove a third-party command's identity enforcement.

The companion's focused Python tests (69), UI tests (42), Desktop typecheck, frontend lint
and all 14 canonical repository checks passed in an isolated checkout. The full UI suite
was deliberately stopped for host load, and the full Python suite/native Desktop acceptance
were not performed. Apply the separately reviewed patch only to an independent matching
checkout; no upstream publication, installed-app modification, real-agent start or native
message delivery was performed. Coordinated release and the six manual gates remain
necessary; a companion commit is not evidence that the live Desktop has these changes.

The paired database/feed migration and Desktop cache cutover described above have not
been applied to the live installation by this change. Earlier Desktop acceptance results
do not validate this new release, two-choice reply cards, or the new binding migration.

The current companion revision completed a production build and unsigned
mac-arm64 packaging (both exit 0), with a clean `99dc5e1aef21e719e87b004d3093376ac2734708` source stamp (`dirty:false`).
Layered-icon generation warned that Xcode was unavailable, and notarization was intentionally
skipped. This proves build/package creation only: the packaged native application was not
launched, installed or used for a real message, and no signing/notarization acceptance is claimed.

The new companion uses `POST /api/sessions/{session_id}/external-messages/query`
with `{after, retained_keys}` (at most 50 retained keys and a 16,000-byte serialized
retained-key budget). The legacy GET route remains. Retained keys include the full card
binding; newly paged events and retained cards are grouped by binding and queried from HAB
in batches of at most 50, also constrained by a 12,000-byte key-array budget. The backend
requires exact `scope:"requested"`/`keys` echo and rejects foreign or duplicate state rows.
It reports `decision_checked_keys` and `decision_error_keys`, each keyed by binding,
sender and message, so one failed batch does not disable every unrelated card. Missing
authority is applied only within checked keys; other cards are not missing merely because
they were not requested in this poll. A decision POST preflights only its own key and
rechecks the existing conversation before forwarding the user's choice. These are isolated
implementation/test results, not evidence that the installed Desktop uses this contract.
The latest companion also preserves compact UTF-8 JSON when forwarding retained keys,
so added serializer whitespace cannot spuriously exceed the key-array budget. Build/package
verification for `99dc5e1aef21e719e87b004d3093376ac2734708` completed as recorded above,
superseding the preceding `15f2267` package. No package was launched, installed,
deployed or notarized.
