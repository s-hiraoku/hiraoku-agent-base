# 受信通知アダプタ：届いたメッセージを受信側の画面に出す

[ADR-021](../hab-decisions.md) · [共通 MCP 接続](../common-mcp-connection.md) · [受信後の引渡し](recipient-messages.md)

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
| 既読にせずに新着を見つける | host の `hab_peek`（`/mcp/delivery`、操作 `poll`） |
| 利用者に見せる文面（`display`）と、同じセッションへ渡す文面（`handoff_prompt`） | host（`src/messaging/incoming-notice.ts`） |
| 定期的な確認、表示済みの記録、選択の記録、二重実行の防止、期限切れ | `src/agent-notify/`（`ReceiptNotifier`、`SQLiteNotices`） |
| 選択後に既読にする | アダプタが受信者の credential で `hab_inbox`（`message_id` 指定）を呼ぶ |
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
npm run hab:notify -- --config notify.json decide <message_id> accept|later|decline
npm run hab:notify -- --config notify.json show-again <message_id>
```

token は呼ぶたびにファイルか環境変数から読みます（エージェント側が更新する token をそのまま使えます）。アダプタは token も本文も表示しません。`token.file` の形式はエージェントごとに確認してください。

## 選択と状態

| 状態 | 意味 | HAB 上 |
| --- | --- | --- |
| `shown` | 画面に出した。選択待ち | 未読 |
| `later` | 「あとで」。`show-again` で同じメッセージを出し直せる | 未読 |
| `declined` | 「対応しない」。何も始めない | 既読 |
| `accepting` | 「対応する」を受けて渡している最中 | 既読 |
| `started` / `queued` | セッションが受け付けた／入力に入れた | 既読 |
| `unsupported` | そのセッションへの正式な入口がない | 既読 |
| `unknown` | 渡せたか分からない。自動では再送しない | 既読 |
| `expired` | 選ぶ前に返信期限を過ぎた | 期限切れ |

- 表示できなかった新着は記録を消し、次の確認で出し直します。
- 選択は行単位の条件付き更新で 1 回だけ通ります。二重クリック、再起動、並行の選択でも `handoff` は 1 回までです。
- 既読にできなかったときは何も始めず、元の状態に戻します（選び直せます）。
- 本文に「承認済み」などと書かれていても、選択の代わりにはなりません。届いたメッセージから `handoff` が呼ばれることはありません。

## 限界と未完了

- HAB の既読は、人が内容を見た・同意した・作業を終えたことを意味しません。
- ADR-017 の SDK 受信（保存してから ACK）と同じ受信者で並べて使わないでください。ACK された本文は `hab_peek` にも `hab_inbox` にも出ません。
- Hermes Desktop の `AgentScreen`（既存 Desktop セッションの外部メッセージ欄への表示と、`POST /api/sessions/{session_id}/chat` などの正式な入口への引渡し）は未実装です。既存 Desktop セッションでの受入確認も未実施です。CLI だけの往復は Desktop の合格に数えません。
