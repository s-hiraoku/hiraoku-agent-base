# GeminiとAntigravityからHABへ接続する

2026-11-19 JST に、Gemini と Antigravity を HAB の対象エージェントに加えた。製品専用の配送コードは追加せず、[共通MCP接続](../common-mcp-connection.md)、[常用認証](../operations/persistent-mcp-auth.md)、[受信通知アダプタ](../receiver/arrival-notifier.md)の境界をそのまま使う。本書は公式資料で確かめた入口と未確認の点の記録であり、実接続・送受信・受信通知の証拠ではない。

他の製品と同じく、次の 3 つの観点で分けて記録する。

1. MCP 接続：HAB の MCP（`hab_send`・`hab_inbox`・`hab_reply`・`hab_status`・`hab_discover`）を製品から呼べるか。
2. 受信通知：届いたことを、モデルを動かさずに利用者へ知らせる公開の入口があるか。
3. 表示と引渡し：通知をカードとして描き、利用者が選んだ後に同じ既存会話へ渡せるか。

## 対象の区別

「Gemini」と「Antigravity」はそれぞれ複数の製品を含む。接続先・会話・認証は製品ごとに別であり、ある製品で動いたことを他の製品の成功として扱わない。

| 対象 | `agent_name` の例 | 主な用途 |
| --- | --- | --- |
| Gemini アプリ（Web・モバイル） | `gemini` | 個人の会話アシスタント |
| Gemini API を使う独自アプリ | `gemini` または独自の名前 | 自分で作るエージェント |
| Antigravity アプリ（デスクトップ） | `antigravity` | エージェント中心の作業画面 |
| Antigravity IDE | `antigravity` | エディタ内のエージェント |
| Antigravity CLI | `antigravity` | ターミナルのエージェント（Gemini CLI の後継） |

Gemini CLI は、2026-05-19 の Google の発表で Antigravity CLI への移行が告知され、2026-06-18 に Google AI Pro・Ultra と無料利用者への提供を終えた（有料の API キーや企業向け契約では引き続き使える）。そのため、新しく接続する対象としては Antigravity CLI を扱う。Gemini CLI の ACP についての 2026-11-15 の調査は[受信通知アダプタ](../receiver/arrival-notifier.md#gemini-の接続対象と残る製品側実装2026-11-15-調査)に残す。

## Antigravity

### MCP 接続

Antigravity のアプリ・IDE・CLI は、1 つの MCP 設定ファイル `~/.gemini/config/mcp_config.json` を共有する。IDE では MCP Servers メニューの「Manage MCP Servers」→「View raw config」から開ける。リモートの MCP サーバーは次の形で書く。

```json
{
  "mcpServers": {
    "hab": {
      "serverUrl": "https://<HAB の公開 MCP 入口>/mcp",
      "oauth": {
        "clientId": "<Antigravity 専用に作った client ID>",
        "clientSecret": "<その client secret>"
      }
    }
  }
}
```

OAuth は認可コード方式で、Google の例では redirect URI に `https://antigravity.google/oauth-callback` を登録し、ブラウザでサインインした後に表示されるコードを Antigravity の設定（CLI ではプロンプト）へ貼り付ける。トークンは画面ごとに別に保存されるため、アプリ・IDE・CLI のそれぞれで認証が要る。v2.33.0（2026-11-17）で、リモート MCP の token 更新時にサインアウトされる不具合が直っている。

HAB 側の準備は Dots・claude.ai・Muse と同じ型になる見込みである。

- Auth0 に Antigravity 専用のアプリ（Regular Web、client secret あり、Refresh Token あり）を作り、上の redirect URI を登録する。他の製品の client ID や token は使い回さない。
- scope は HAB のエージェント用 MCP に必要なものと `offline_access` を要求する。
- サインイン後、主体と client ID の組を接続台帳に登録し、Registry に `<bot_name>@antigravity.hab` を登録して紐付ける（本人の承認を得てから行う）。
- Antigravity は利用者の PC 上で動くため、HAB と同じ Mac で使う場合は loopback の入口も候補になる。どちらを使うかは接続時に決める。

未確認：HAB の Auth0 の認可画面と、コード貼り付け方式での token 発行・更新。`serverUrl` だけで HAB の Streamable HTTP に接続できるか。HAB の MCP ツールの入出力スキーマを Antigravity が受け付けるか。

### 受信通知

Antigravity には、外部のプログラムから既存の会話へ「届いた」ことを知らせる公開の入口が見当たらない（2026-11-19 時点の公開 changelog と資料）。公開されているのは次の仕組みで、どれも HAB の到着通知には当たらない。

- 通知設定とトースト、Remote Control のプッシュ通知：エージェントの作業完了や入力待ちを知らせるもの。
- フック（`hooks.json`、カスタムエージェントの front matter）：ターンの終わりや利用者の入力時に動く。会話が動いていない間に届いたメッセージは知らせられない。
- `antigravity://` リンク：新しい会話を、送信前のプロンプトが入った状態で開く。既存の会話への引渡しではない。

当面は Dots・Muse と同じく、会話の中で `hab_inbox` を呼ぶ手動の受信になる。`hab:notify` の JSON Lines ファイルと `display_command`（デスクトップ通知など）による知らせ方は使える。

### 表示と引渡し

- 表示：Antigravity の会話内にカードを足す公開の口は未確認。MCP ツールの結果としての表示（利用者が `hab_inbox` を呼んだとき）に限られる。
- 引渡し：既存の会話へ外から入力を渡す公開の口は未確認。`antigravity://` で新しい会話を開く方法は、利用者が内容を見て送る形なら使える可能性があるが、同じ既存会話への引渡しの成功としては扱わない。
- Antigravity SDK が公開されている。SDK で HAB を組み込んだ独自のエージェントを作ることはできるが、それは利用者が普段使う Antigravity アプリの会話への接続ではない。

## Gemini

### MCP 接続

- Gemini アプリ：Custom Connected Apps で remote MCP を追加できる。2026-11-15 の確認時点では、米国・個人 Google アカウント・英語などの条件があった。利用者の環境で使えるかは実機で確かめる。
- Gemini API を使う独自アプリ：アプリ側で MCP クライアントを持てば HAB の MCP を呼べる。接続・認証の作り方はそのアプリ次第である。

### 受信通知

- Gemini アプリ：外から既存の会話へ通知を出す公開の入口は未確認。ツールは利用者の問いかけを起点に呼ばれる。
- 独自アプリ：アプリが自分で HAB を確認し、表示する。HAB の `hab:notify` をそのまま使える。

### 表示と引渡し

- Gemini アプリ：ツール結果に結び付けた MCP Apps の UI を出せる。ChatGPT や claude.ai 向けに検討している、HAB の受信を MCP Apps で描く部品を共通で使える可能性があるが、未確認。
- 独自アプリ：Interactions API の `previous_interaction_id` で会話を続けられるため、アプリ自身が表示・選択・会話への引渡しを持てる。Gemini アプリの会話に届いたことにはならない。

## 現状のまとめ

| 項目 | Gemini アプリ | Gemini API の独自アプリ | Antigravity（アプリ・IDE・CLI） |
| --- | --- | --- | --- |
| MCP 接続 | Custom Connected Apps（公開 HTTPS＋OAuth）。利用条件の確認が必要 | アプリが MCP クライアントを持てば可 | `mcp_config.json` の `serverUrl`＋OAuth（コード貼り付け） |
| 受信通知 | 公開の入口なし（未確認） | アプリが自分で実装 | 公開の入口なし。作業完了通知・フックは別用途 |
| 会話への表示 | ツール結果の MCP Apps UI（未確認） | アプリが自分で実装 | ツール結果のみ |
| 既存会話への引渡し | 未確認 | アプリが自分で実装 | 未確認（`antigravity://` は新しい会話） |
| 当面の受信 | 会話で `hab_inbox` | アプリ次第 | 会話で `hab_inbox` |
| 実機確認 | 未実施 | 未実施 | 未実施 |

## 次に確かめること

1. 利用者がどの製品（Gemini アプリ、Antigravity アプリ・IDE・CLI）を使うかと、アドレス（`<bot_name>@gemini.hab`、`<bot_name>@antigravity.hab`）を決める。
2. Auth0 に専用アプリを作り、実機で接続・`hab_send`・`hab_inbox`・`hab_reply` の往復を確かめる。
3. 受信通知・表示の入口が公開されたら、[受信通知アダプタ](../receiver/arrival-notifier.md)の共通契約（binding、判断の記録、revision 同期）に沿って、その製品の画面アダプタだけを足す。配送や判断の仕組みを別に作らない。

## 公式確認先

- [Google Workspace MCP servers in Google Antigravity 2.0, IDE, and/or CLI](https://codelabs.developers.google.com/google-workspace-mcp-antigravity)（共通の `mcp_config.json`、`serverUrl` と `oauth`、redirect URI）
- [Antigravity changelog](https://antigravity.google/docs/changelog.md)（v2.33.0 までの MCP・フック・通知・`antigravity://` リンク）
- [An important update: transitioning Gemini CLI to Antigravity CLI](https://developers.googleblog.com/an-important-update-transitioning-gemini-cli-to-antigravity-cli/)（2026-05-19 発表、2026-06-18 の提供終了）
- [Connected Apps MCP developer guide](https://developers.google.com/connected-apps/mcp)（Gemini アプリのツール呼び出しと UI resource）
- [Gemini Apps custom apps](https://support.google.com/gemini/answer/17209137?hl=en-JS)（利用条件）
- [Interactions API](https://ai.google.dev/gemini-api/docs/interactions-overview)（API アプリの会話継続）
