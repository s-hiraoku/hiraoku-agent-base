# 競合比較とロードマップ

[READMEへ](../README.md) · [ADR](hab-decisions.md) · [役割と機能](hab-roles.md)

現在の製品要件と、A2A・NATS JetStreamを将来候補として再評価する範囲は[HAB製品仕様](hab-product-spec.md)を参照してください。標準通信は[共通MCP接続](common-mcp-connection.md)と[受信supervisor](receive-supervisor.md)を基準にし、モデル実行・承認は受信側の既存機構へ残します。以下の比較と初期版の限定Taskの判断は記録時点のものです。inventoryや製品専用runnerを通常通信の開始条件にはしません。

## 比較の扱い

2026-10-10に各projectの公開READMEと一次資料を確認しました。以下は作者が説明する機能と、HABで参考にする観点です。実installation・security audit・本番検証はしていません。導入済み、認可の強さ、運用成熟度や無追加料金を保証しません。異なる目的のprojectを総合順位で評価せず、差分を設計へ戻します。

| 参考project / 一次資料                                     | READMEで確認した範囲                                                                                                                  | HABで参考にする点・追加確認                                                                                                                                                           |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Agent Tincan](https://github.com/mvanhorn/agent-tincan)   | Tailscale relay、Grok/Hermes・coding agent等の接続、request/reply・wake、browser extensionによる`dot-web`（依頼は既定で本人承認待ち） | 構成が近い。adapter・handoff・起床の可観測性を参考にする。dotは公式API接続ではなく、ログイン済みChromeのDM操作で本人として送る境界。主体/client分離と最小権限の保証を同等とみなさない |
| [homelab-agent](https://github.com/TadMSTR/homelab-agent)  | Claude Code中心の五役、task queue、Matrix、manifestでtool surfaceを制御、event ledger                                                 | 役割別manifest、handoff監査、service/runbook分割を参考にする。大きなself-hosted stackであり、HABに全stack・memory基盤を導入する判断はしていない                                       |
| [Pop Agent](https://github.com/viniciusbuscacio/pop-agent) | single-user self-hosted agent、private Tailscale、MCP client、REST/A2A。A2Aはtext中心でstream/file/pushに制限、beta互換性注意         | 単一ownerとlocal storage、APIの初期無効化を参考にする。HABは独立agent仲介を目的とし、A2Aは初期版不採用。公開Funnelとprivate Tailscaleを混同しない                                     |
| [Athena](https://github.com/faelnor92/Athena)              | 開発中のself-hosted orchestrator。READMEにOIDC、tool RBAC、人の承認、budget・audit機能を記載                                          | 承認・権限・費用の表示方法を参考にする。READMEの機能説明は独立した安全性評価ではなく、実装/coverage/versionを採用時に確認する                                                         |

Agent Tincanのbrowser接続は[web-agents資料](https://github.com/mvanhorn/agent-tincan/blob/main/docs/adapters/web-agents.md)も参照対象です。HABはまず公式MCP/OAuthと限定Runsを検証し、browser本人sessionの代理送信を安易な接続fallbackにしません。

## 段階と完了条件

| 段階                          | 状態                                                                           | 完了条件                                                                                                                               |
| ----------------------------- | ------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| 0. sourceと設計の基盤         | **実装済み**。Hub、認証部品、限定contract、停止/照合、Events、隔離bridgeとmock | README・ADR・役割・security・CIを同じ状態に保つ。実設定・履歴を公開しない                                                              |
| 1. public入口とOAuthの確定    | **未完**。既存別MCPのFunnel/Grok動作は本人報告あり                             | 既存routeを維持し、HubのURL/discoveryを選定・承認。Auth0無料条件、client/callback、主体/scope、entrypoint配線、認証拒否を確認          |
| 2. 今回のHermes単発inventory  | **準備済み／実往復未実施**                                                     | fresh Inspector、私的manifest/credential/store binding、許可されたsocket環境、$0モデル枠確認。固定一件を実行・取得・停止・key失効/照合 |
| 3. Dots/Grok診断接続          | **mock実装済み／本番未接続**                                                   | 両clientの認証と固定ping/pong、correlation/TTL、停止、権限変更、再起動を実確認。HTTP受付を完了扱いしない                               |
| 4. 限定通知・継続運用         | **部品実装済み／実配送未接続**                                                 | 必要なreceiver/wakeだけを選び、固定callback、grant/revocation、dedup、retry、retention、停止・監視を検証。常駐は別承認                 |
| 5. 開発・browser executor拡張 | **計画**                                                                       | Claude Code/Codex/Cursor、後続Cuaを個別評価。workspace排他、最小tool、期限/費用、成果物provenance、未知run照合を受入れ条件にする       |
| 6. 個人用途の拡張             | **計画**                                                                       | 重要メール・予定・Calendar・長い仕事を担当agentの既存jobと調整。個人データの転送、承認、重複防止を用途別に確認                         |

順番は承認とclient互換性に応じて調整します。例えばDots/Grokの固定診断を、modelを呼ぶinventoryより先に検証できます。現在の不足を競合の導入で自動的に解消したとはみなしません。

## 文書の更新ルール

実装時はtechnical contractとtestを、接続時は役割表と受入れ表を、方針変更時はADRを更新します。実接続の証拠は非公開に保管し、public文書には対象・確認範囲・証拠種別だけを一般化して残します。新しいhost、秘密、個人データ、課金条件、承認済み操作をsourceから推定しません。
