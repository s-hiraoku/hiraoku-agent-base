# HABの設計思想

[READMEへ](../README.md) · [役割と機能](history/hab-roles.md) · [ADR](hab-decisions.md)

## 判断を保つ分業

Personal ContextはDotsに置きます。相談の背景、重要なメールの判断、予定の意味を理解する担当です。Grok BotはCloud Workerとして、既存の情報収集や将来のブラウザ操作・長い仕事を担当します。HermesはLocal Agentとして、Macの開発実験、MCP、Skillsを扱います。ここでのCloud WorkerはGrokの役割であり、Cloudflare WorkersにHubを配置する意味ではありません。

HABは送信名義・宛先・配送権限を検証し、メッセージと配送状態を記録します。内容の判断、仕事の引受け、実行と必要な承認は受信エージェント側の責務です。各agentの記憶や判断を中央へ移したり、一つの巨大な会話へ統合したりしません。役割分担は目標であり、接続済み機能は[役割表](history/hab-roles.md)で別に示します。

## 共通Hubと疎結合

標準の通信契約は[共通HTTP MCP](common-mcp-connection.md)と永続outbox/inboxです。各エージェント側のhostが定期pollし、重複排除と本文の永続保存後にACKします。[受信supervisor](receiver/receive-supervisor.md)はモデルを呼ばず、受信だけを反復します。製品名による配送分岐や、HABから製品実行APIを起動する専用adapterは標準接続へ追加しません。

質問・回答はTaskなしで送受信できます。既存Task Engineや汎用ジョブは任意の実行連携であり、受信・ACKから自動でTaskを作りません。その連携を明示的に使う場合だけ、実行receiptを照合し、一つのTask状態DBを選びます。Mac側journalを第二のタスクDBにしません。

担当agent、実行tool、実行環境、workspace、完了条件は別の概念です。Claude Code・Codex・Cursorを使う場合も、その名前を指定しただけでは権限や接続を得られません。実際の主体と実行境界の確認が必要です。

## 最小権限と承認

認証済み主体・client・scope・静的policyから操作と宛先を決めます。引数のagent名、自然言語の「readonly」、proxy headerを認証として扱いません。固定payload・並列1のHermes実行は、既存の限定Task試験の契約です。通常のMCPメッセージ接続の要件にはしません。受信後の実行には受信側の既存policyと承認機構を適用し、外部本文を所有者の直接指示や承認へ昇格させません。HAB独自の一律no-tools制約や毎回の返信承認を標準接続へ強制しません。個人データ、転送、shell等の許可範囲と必要な承認は受信側で確認します。

sourceのcommit/pushは、外部公開経路、新credential、OAuth grant、常駐process、課金契約や実agent実行の承認を兼ねません。必要な承認は接続先・scope・データ・時間・停止方法を具体化して取ります。

## 重複と無限連鎖を防ぐ

既存cronやconnpass jobは元の担当に残し、Hubで重複作成しません。要求key、原子的claim、lease、fence、run照合を使って二重実行を防ぎます。結果・outbox通知から自動で新依頼を生成しません。配送はat-least-onceなので、受信側もevent IDを重複排除します。

## 費用と失敗を境界にする

Auth0は無料条件の確認を前提にし、有料機能へ自動fallbackしません。既存モデルsubscriptionやログイン成功は「追加料金0」の証明ではありません。利用枠・追加credit・API課金routeが未確認ならmodelを起動しません。

不明な実行、停止失敗、期限切れ、権限変更では止めて照合します。可用性のために認証や隔離を緩めず、未確認を成功に置き換えません。詳細は[処理](history/hab-workflow.md)と[セキュリティ](hab-security.md)にまとめます。
