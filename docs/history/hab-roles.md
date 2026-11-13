# HABの役割と機能

[READMEへ](../../README.md) · [設計思想](../hab-principles.md) · [ロードマップ](hab-roadmap.md)

「計画」は担当候補、「実装済み」はrepoのコード／mock検証、「実接続確認済み」は対象の本番経路の確認です。本人報告とコード実測は証拠の種類を分けます。製品自体を利用できることと、Hubから制御できることは別です。

| 担当               | 機能・目標                                                                | HABに関する現状                                                                                                                                                                               |
| ------------------ | ------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Dots（スタローン） | 個人文脈、相談、重要メール判断、通知後の既読、予定要約                    | **計画**。これらはDots側の担当方針。Hub OAuthと結果取得・自動通知の本番接続は未確認                                                                                                           |
| Grok Bot           | 既存connpass取得を継続。将来のCalendar同期、browser service操作、長い仕事 | 既存別MCPの到達・認証拒否は**本人報告で確認済み**。Hub用wake/control、Dotsとの双方向本番は**未接続**。既存jobは移管・再作成しない                                                             |
| Hermes             | Macの開発実験、MCP・Skills、限定Runs実行                                  | Runs driver・独立Inspector・Python bridge・一時キーは**実装済み**。今回のinventory用profile/code/dependencyは**準備済み**、本人preflight測定報告あり。今回の実キー/API/model/往復は**未実施** |
| Claude Code        | 将来のMac開発・テスト・レビュー実行手段                                   | **計画**。Claude Channel候補はmockのみ、Hubの実adapterは未接続                                                                                                                                |
| Codex              | 開発・検証・GitHub管理、将来の限定実行手段                                | このrepoの実装・文書作業に使用。これはHub-controlled executorの接続証拠ではない。Hub adapterは**計画**                                                                                        |
| Cursor             | 将来の対話的IDE作業・Cloud Agent候補                                      | **本人の利用可能性見込み**。実client/API・scope・Hub adapterは未検証                                                                                                                          |
| Cua（後続候補）    | 将来の限定computer/browser操作                                            | 起動未完。上記開発toolの接続やGrokの操作能力とは別の**後続検証**                                                                                                                              |
| HAB host           | エージェントごとのアドレス登録・認証・名義確認、メッセージ配送（SQLite配送store）、A2A入口 | MCP 5ツール・A2A入口（既定は無効）・Registry・SQLite配送storeは**実装済み**。Codex⇄Hermesの有限往復は実接続確認済み。本番配備・常時接続は未完 |
| 任意のTask Hub     | 固定Taskの依頼・policy routing・進捗・結果・監査 | 限定タスク、ping/pong、Auth0検証部品、Events、停止・照合は**実装済み**。本番Auth0設定・entrypoint配線・公開経路は未完。通常のメッセージ交換には不要 |

標準通信では全製品が[共通MCP](../common-mcp-connection.md)のクライアントとして接続し、受信側hostが定期poll・保存後ACKを行います。表のRuns・inventory・Hub-controlled executorは既存の限定Task連携の状況です。通常通信の必須機能や、HABによるエージェントの判断・承認の代行を意味しません。

## ShiftLogをHABの機能として扱う方針

ShiftLogは独立repoのまま、HABの**作業記憶・再開context**機能として統合する計画です。
既存の `shift_log_inventory` は導入候補metadataの診断であり、この機能の代わりではありません。
実コード読取りに基づく境界・port競合・権限は[ADR](../hab-decisions.md#shiftlog機能の接続境界)に記録します。
収集・履歴・設定の所有はShiftLogに残し、Hubが自動的に収集を有効化したり個人記憶を全agentへ複製したりしません。

## 現在の限定機能

- `connectivity_check`：固定テキスト応答。一般的な会話・コマンド実行ではありません。
- `shift_log_inventory`：固定された五つの候補へのmetadata観測。file内容・個人directory・shellは対象外で、製品の導入有無を断定しません。
- `ping_submit / ping_get / ping_reply / ping_pending`：固定ping/pong、相関ID・TTL・subject/client bindingの診断契約。実Grok wakeは未接続です。
- Events：指定されたtask IDとterminal stateの通知契約。コード上はopt-inで、実callback・常駐配送は未接続です。

各機能はserver policyと明示的なservice配線を必要とします。default entrypointは全件認証拒否です。実装があるだけで全機能が公開される構成にはしません。

## 実行手段を増やす条件

開発作業を許可する前に、toolごとの実認証、workspace予約／isolated worktree、実行idempotency、fileとnetworkの許可範囲、期限・費用・成果物の出所、停止後の照合を設計します。CLIがインストール済み、モデルAPIが利用可能、別clientでMCPが動く、といった事実から権限を推定しません。
