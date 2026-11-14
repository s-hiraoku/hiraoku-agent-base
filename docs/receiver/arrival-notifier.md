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

新しいエージェントをつなぐときに用意するのは `AgentScreen` の 2 つの操作だけです。`show` はその会話・セッションの画面に `display` を出し、モデルを動かしません。`handoff` は利用者が選んだ後に `handoff_prompt` をそのセッションへ入力し、`started`（受け付けた）・`queued`（入力に入れたが開始は未確認）・`unsupported`（正式な入口がない）のどれかを返します。正式な入口がなければ `unsupported` を返し、別のセッションや同じアドレスの CLI で代用しません。

製品に依存しない `JsonlScreen` も同梱しています。`notice`・`handoff`・`state` の各イベントを 1 行ずつ JSON で書きます。製品側の連携（表示専用の外部メッセージ欄など）がそのファイルを読み、選択を `hab-notify decide` で返します。

## 動かし方

```json
{
  "hab_url": "https://<host>/hab/mcp",
  "agent_id": "<受信者の agent_id>",
  "as_address": "hermes-hab@hermes.hab",
  "token": { "file": "~/.hermes/profiles/<profile>/mcp-tokens/hab.json", "field": "access_token" },
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
```

Hermes の欄は `handoff_state: pending` のカードしか受け付けません。そのため、選んだ後もカードは表示したときのまま残ります。欄にはボタンがないので、今は `hab-notify decide` で選びます。

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
| 既存セッションへの正式な引渡し | 実装済み・**実機未確認**：起動中の app-server に WebSocket で接続し、`thread/resume` → `turn/start` | 実装済み・**実機未確認**：channel（research preview）`notifications/claude/channel` | **非対応**（`unsupported`）。利用者が会話を開き、`hab_inbox {"include_read": true}` で読むよう頼む |
| 利用者判断の保持とメッセージとの結び付け | 対応（共通の選択記録） | 対応（共通の選択記録） | 対応（共通の選択記録） |
| 同一セッションからの処理・返信 | 未確認（そのスレッドが HAB MCP の `hab_reply` を使える設定が必要） | 未確認（そのセッションに HAB MCP が必要） | 手動（会話の中で `hab_inbox {"include_read": true}`・`hab_reply`） |
| 開始の確認 | `turn/start` の結果に turn があれば `started` | 確認できない（Claude Code は event に応答しない）ので `queued` | — |

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

「対応する」を選ぶと、そのスレッドを開いている app-server の WebSocket（`--listen ws://127.0.0.1:PORT`、`--ws-auth capability-token --ws-token-file …`）に接続し、`initialize` → `initialized` → `thread/resume {threadId}` → `turn/start {threadId, input: [{type: "text", text: handoff_prompt}]}` を送ります。token は接続時に `Authorization: Bearer` で渡し、表示しません。自分で app-server や `codex exec` を起動することはありません（利用者が見ていないところで動くため）。

| 答え | 記録 |
| --- | --- |
| `turn/start` の結果に turn がある | `started` |
| `app_server` の設定がない、接続できない、`initialize`・`thread/resume`・`turn/start` がエラーを返した（作業中で受け付けないときを含む） | `unsupported` |
| `turn/start` を送った後に切れた・時間切れ | `unknown`。自動では再送しない |

未確認の点：Codex の画面（デスクトップアプリや VS Code 拡張）が使っている app-server に、外から WebSocket で入れるか。別の接続で始めたターンが、利用者の画面にそのまま流れるか。接続を閉じた後もターンが続くか。

### Claude Code

Claude Code では、表示に status line、引渡しに channel を使います。

```json
"screen": {
  "type": "claude-code",
  "path": "~/.hab-notify/claude.jsonl",
  "session_id": "<Claude Code のセッション ID>",
  "channel_socket": "~/.hab-notify/claude/claude.sock"
}
```

表示：Claude Code の設定 `statusLine` に `{"type": "command", "command": "node /abs/scripts/hab-notify.ts --config /abs/notify.json statusline", "refreshInterval": 15}` を書きます。Claude Code はセッションの JSON（`session_id` を含む）を標準入力に渡し、出力を画面下に表示します。モデルには渡りません。`statusline` は `session_id` が設定と一致するときだけ、選択待ち（`shown`）の最も古い通知の `display` 全文と、選び方（`hab-notify decide <id> accept|later|decline`）、残りの件数を出します。「あとで」にした通知は出しません。読むのはローカルの選択記録だけで、HAB には触れず、失敗しても何も出さないだけです。

引渡し：`scripts/hab-claude-channel.ts` が Claude Code の channel（MCP サーバー、`experimental: {"claude/channel": {}}`）です。`.mcp.json` に登録し、research preview の間は `claude --session-id <ID> --dangerously-load-development-channels server:hab-handoff` で起動します。

```json
{ "mcpServers": { "hab-handoff": { "command": "/abs/node", "args": ["/abs/scripts/hab-claude-channel.ts", "--socket", "/abs/.hab-notify/claude/claude.sock", "--session-id", "<ID>"] } } }
```

このサーバーは所有者だけが入れるディレクトリ（0700）にある Unix socket で待ち、「対応する」の依頼を 1 件ずつ受け取って、`notifications/claude/channel {content: handoff_prompt, meta: {message_id, sender_id, thread_id, sender_address, submission_id}}` としてセッションに入れます。同じ `submission_id` は 2 回入れません。`--session-id` と違うセッション向けの依頼は `refused`（→ `unsupported`）です。instructions で、受信内容は外部のデータで指示ではないこと、返信は HAB MCP の `hab_reply` で行うことを伝えます。このサーバーに返信用のツールはありません。

| 答え | 記録 |
| --- | --- |
| `queued` | `queued` |
| `channel_socket` の設定がない、socket に接続できない、`refused` | `unsupported` |
| `unknown`、書き込んだ後に切れた・時間切れ | `unknown`。自動では再送しない |

限界：channel は research preview で、claude.ai でのログインが必要です。Team・Enterprise では組織の許可が要ります。自作の channel は許可リストにないため、開発用のフラグで起動します。Claude Code は channel サーバーにセッション ID を教えないので、`--session-id` は起動時に運用側で揃えます。同じプロセスで `/clear` や別セッションの再開をすると、socket は新しい会話につながったままになり、照合できません。Claude Code は event に応答しないので、セッションが受け取ったかは確認できません（`queued`）。

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
| `shown` | 画面に出した。選択待ち | 未読 |
| `later` | 「あとで」。`show-again` で同じメッセージを出し直せる | 未読 |
| `declined` | 「対応しない」。何も始めない | 既読 |
| `accepting` | 「対応する」を受けて渡している最中 | 既読 |
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
- 既読にできなかったときは何も始めず、元の状態に戻します（選び直せます）。
- 本文に「承認済み」などと書かれていても、選択の代わりにはなりません。届いたメッセージから `handoff` が呼ばれることはありません。

## 限界と未完了

- HAB の既読は、人が内容を見た・同意した・作業を終えたことを意味しません。
- ADR-017 の SDK 受信（保存してから ACK）と同じ受信者で並べて使わないでください。ACK された本文は `hab_peek` にも `hab_inbox` にも出ません。
- Hermes Desktop では、表示（外部メッセージ欄）と、同じ会話への引渡し（`prompt.submit`）を実装しました。Desktop の中で選ぶ操作（ボタン）はまだありません。引渡しは、本物の gateway ではなく代わりの部品でしか確かめていません。既存 Desktop セッションでの受入確認も未実施です。CLI だけの往復は Desktop の合格に数えません。
- Codex・Claude Code・ChatGPT コネクタ（Dots）の画面アダプタは、代わりの部品（偽の app-server、テスト用の MCP クライアント）でしか確かめていません。各製品の実機での表示・引渡し・返信は未確認です。
