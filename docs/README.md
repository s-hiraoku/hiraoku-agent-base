# 文書一覧

[README](../README.md)

最初に [HAB の構成](architecture.md) を読み、次に目的に合う文書へ進んでください。

## 設計

| 文書 | 内容 |
| --- | --- |
| [HAB の構成](architecture.md) | 部品、アドレスと認証、送受信の流れ |
| [設計思想](hab-principles.md) | 分業、疎結合、費用の制約 |
| [製品仕様](hab-product-spec.md) | 登録・宛先選択・状態表示などの製品要件 |
| [メッセージ配送の正式仕様](hab-relay-spec.md) | store-and-forward、個体認証、ACK、期限 |
| [設計判断（ADR）](hab-decisions.md) | 採用・不採用・保留の判断と理由 |
| [セキュリティ](hab-security.md) | 認証、権限、秘密、公開境界 |

## 接続と運用

| 文書 | 内容 |
| --- | --- |
| [共通 MCP 接続](common-mcp-connection.md) | 新しいエージェントをつなぐ手順 |
| [認証グループ](relay-auth-groups.md) | 接続とアドレスの結びつけ方 |
| [アドレスの改名](agent-address-rename.md) | 同じ ID を保った改名と旧名の扱い |
| [ローカルサービス](local-relay-service.md) | host の起動・設定・管理 CLI |
| [ローカル MVP](local-mvp.md) | 1 コマンドで動作を確かめる手順 |

## 分野別

| フォルダ | 内容 |
| --- | --- |
| [connections](connections/) | 製品ごとの接続手順（Claude Code、Grok Bot）とアドレス照会 |
| [operations](operations/) | host の常駐、OAuth 入口、Auth0 の手順と復旧 |
| [receiver](receiver/) | 受信 supervisor と受信側の任意部品 |
| [delivery](delivery/) | 容量、公平な poll、writer 受付 |
| [a2a](a2a/) | A2A 入口 |
| [history](history/README.md) | 削除したコードの説明、試験記録、過去の計画 |
