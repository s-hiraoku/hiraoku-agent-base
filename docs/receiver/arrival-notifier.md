# 受信通知アダプタ：届いたメッセージを受信側の画面に出す

[ADR-021](../hab-decisions.md) · [共通 MCP 接続](../common-mcp-connection.md) · [受信後の引渡し](recipient-messages.md) · [受入条件（利用者指定）](receipt-confirmation.md)

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

届いただけではモデルを動かしません。「対応する」を選んだときだけ、そのエージェントの同じセッションに依頼を渡します。返信はそのセッション自身が `hab_reply` で行います。

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

token は呼ぶたびにファイルか環境変数から読みます（エージェント側が更新する token をそのまま使えます）。アダプタは token も本文も表示しません。`token.file` の形式はエージェントごとに確認してください。

token の更新はエージェント側の仕事です。アダプタは更新しません。Hermes は `expires_at`（期限の UNIX 秒）を書き、期限が切れたあと、自分の次の接続（約 3 分ごと）で更新します。`expires_at_field` を指定すると、期限を過ぎた token は HAB に送らず、`{"error":"token_expired"}` を返します。token の欄が空なら `token_unavailable` です。どちらも `transport_failed`（HAB に届かない、応答がおかしい）とは分けて出ます。`run` は期限切れの間もそのまま待ち、エージェントが更新した次の確認から自然に戻ります。

- `expires_at_field` がなくても、token が JWT なら `exp` を読みます。過ぎているか 5 秒以内に切れる token は、同じく HAB に送らず `token_expired` です。期限は署名を確かめずに読むだけで、判断するのは HAB です。中身の読めない token と `exp` のない JWT は、そのまま HAB に送ります。
- `run` は、同じ失敗が続くあいだ、始まりに `{"error":"token_expired"}` を 1 回、直ったときに `{"resumed":"token_expired"}` を 1 回だけ書きます。確認のたびには書きません。ほかの失敗（`transport_failed` など）も同じ扱いです。
- 待っているあいだにボタンを押しても、選択は失われません。「対応する」は `accept_waiting`、「対応しない」は `declining` として残り、token が更新された後の確認で既読にして続きを進めます（[選択と状態](#選択と状態)）。「あとで」は HAB を呼ばないので、そのまま `later` になります。

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
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>ProcessType</key><string>Background</string>
  <key>Umask</key><integer>63</integer>
  <key>StandardOutPath</key><string>/ABSOLUTE/HOME/.hab-notify/PROFILE/run.log</string>
  <key>StandardErrorPath</key><string>/ABSOLUTE/HOME/.hab-notify/PROFILE/run.err.log</string>
</dict></plist>
```

- `run` が書くのは、表示した ID、失敗の名前、`resumed` だけです。token も本文も書かないので、ログは所有者だけが読めるファイル（`Umask` 63 で 0600）に残せます。同じ失敗は始まりと終わりの 1 行ずつなので、ログはほとんど増えません。
- `SIGTERM` を受けると、その回の確認を終えてから終了コード 0 で止まります（長くても `interval_ms` 待ちます）。`SuccessfulExit` が false なので、止めた後に勝手に起動し直すことはありません。異常終了のときだけ 30 秒おいて起動し直します。
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

カードの「1. 対応する」「2. あとで」「3. 対応しない」ボタンは、Mac mini のローカル版 Hermes（ブランチ `hab-external-message-actions`）に足したものです。reader に `actions_command` があるときだけ出ます。押すと Desktop の `POST /api/sessions/{id}/external-messages/decision` が、そのカードの `{action: "decide", backend_namespace, profile_scope, receiver_id, sender_id, message_id, stored_session_id, choice}` を `hab-notify action` の標準入力に 1 回渡します。Desktop 自身はモデルを動かしません。`hab-notify action` は次のどれかが自分の設定と違えば `binding_mismatch` で断り、記録にも HAB にも触れません。

- `stored_session_id`（会話）
- `backend_namespace`
- `profile_scope`
- `receiver_id`（受信者）

設定と合っていれば `decide` と同じ処理をして `{changed, state}` を返します。カードにはその状態（「この会話に渡しました。」など）を出します。ボタンのない Hermes では、これまでどおり `hab-notify decide` で選びます。

会話を開き直したときや Desktop を再起動したときは、Desktop が同じコマンドに `{action: "states", binding_id, backend_namespace, profile_scope, receiver_id, stored_session_id}` を渡し、その会話のカードがそれぞれどうなったかを `{states: [{sender_id, message_id, state}]}` で受け取ります。結び付けの確かめ方は `decide` と同じで、HAB は呼びません。Desktop は、選択待ち（`shown`）のカードだけにボタンを出します。「あとで」（`later`）のカードは、選んだボタンを示したまま、ほかの 2 つを押せるようにします。決まったカードには状態だけを出し、ボタンは出しません。

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
working native Gemini integration. The synthetic adapter contract tests demonstrate the
extension point, not a real Gemini session.

The local CLI provides a shared bridge for every configured screen:

- `binding` returns `binding_id`. Pin this at explicit integration setup, not on every
  click. The ID fences HAB endpoint, recipient, product and its configured session (and
  configured product connection). It is not a credential or a permission grant.
- `states` takes `{"binding_id":"..."}` on stdin and returns a complete retained decision
  snapshot independently of the notice cursor. Poll it even when there are no new notices.
- `adapter-action` takes the same binding plus `sender_id`, `message_id` and `choice`
  (`accept`, `later`, `decline`). It returns the decision and versioned snapshot. Only
  invoke it for the user's actual choice; receipt alone is not approval.

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
handling. Stop the old notifier, preserve its records, reconcile pending/unknown decisions,
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
