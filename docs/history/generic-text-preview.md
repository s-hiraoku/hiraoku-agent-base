# 汎用テキスト処理の最初の実装単位

この文書は明示構成する任意Task連携の契約です。標準の[共通MCP接続](../common-mcp-connection.md)と[受信supervisor](../receiver/receive-supervisor.md)はTaskなしで使えます。内容判断・実行・既存の権限や承認は受信エージェント側に残し、Hermes固有runnerを接続条件にしません。

この実装は、認証済みホストから汎用テキストを受け付け、既存の Task エンジンと合成 runtime で処理し、元の依頼に対応する結果を照会するためのものです。製品名で分岐しません。実製品への接続や本番有効化とは別の段階です。

## 実行状態の正本

`TaskService` が queue、lease、fence、実行状態、結果、通知 outbox を保持します。`task_text_requests` は Task と1対1の不変な相関記録です。相関記録に別の実行状態機械を持たせません。

既存の固定タスクは `submit()` と `Runs.create()` を使います。汎用テキストは `submitText()` と `Runs.createText()` を使います。汎用本文を固定タスクの prompt に流す fallback はありません。

## ホストの binding と外部本文

認証済みホストが `Principal.textBinding` を設定します。

| 項目                  | 意味                                 |
| --------------------- | ------------------------------------ |
| `ownerScope`          | 現在の所有者 scope                   |
| `senderAgent`         | 認証・認可済みの送信 agent           |
| `recipientAgent`      | 明示的に許可された処理先 agent       |
| `recipientOwner`      | 処理先の所有者                       |
| `conversationBinding` | ホストが確認した元会話の表示 binding |

`clientId` は必須です。外部入力は `messageId`、`contextId`、`text`、`workDeadline` だけを持ちます。外部の session ID や本文の「承認済み」という記述から binding や実行権限を生成しません。

同じ所有者、client、scope、送信 agent、message ID は同じ Task を参照します。本文、宛先、context、会話 binding、期限が変わった再送は競合です。再送によって元の期限を延長しません。

## 実行能力と復帰

汎用 runtime は、外部 agent 由来の構造化入力を受け取ります。固定 prompt の入口は使用しません。Task の allowlist、専用の text boundary、永続的な重複防止、保持契約を満たさない runtime は claim 前に拒否します。

ここで試験する runtime は2種類の合成実装です。ファイル操作、shell、plugin、sub-agent、外部送信の API を持ちません。runtime が申告する descriptor や `tools: []` だけで、実製品の隔離を証明したとは扱いません。

実行前に既存の journal へ安定 key を保存します。応答が失われた場合は、同じ key の照合保証がある保持期間内だけ再照合します。既知の run ID は照会します。保証がない相手や保持期限後へ新しい key で再提出しません。

`waiting_approval` は既存エンジンでは lease 切れによる実行照合待ちにも使われます。この実装では受信側所有者の承認として扱いません。`cancelled` でも `execution_open=1` の間は停止未確認です。

## 提供しない経路

汎用 A2A・MCP の opt-in 入口は、後続の[非同期テキスト profile](async-text-v1.md)で提供します。このエンジン単位には、実 Hermes のモデル実行、受信側所有者の承認・再開、保護対象 tool、HAB への自動返信を含めません。結果の照会とローカル outbox は、外部への返信送信とは異なります。

本番用の認証 policy と固定 A2A preview は維持します。稼働版にある GUI、Auth0、常駐受信、managed broker の未公開変更は、この実装の依存として取り込みません。

[製品要件と追加設計](generic-agent-async-design.md)の受入条件は段階ごとに検証します。合成 runtime の成功を、実製品の承認境界や本番疎通の成功とは表現しません。

## 検証コマンド

Node と npm の版は `.node-version` と `package.json` に従います。既存 lockfile の依存を準備した後、次を実行します。

```sh
npm ci
npm run typecheck
NODE_NO_WARNINGS=1 node --test test/generic-text-task.test.js test/generic-async-e2e.test.js
```

合成試験は一時ディレクトリに実際の SQLite データベースと journal を作ります。子 process の終了後に別 process で再開します。試験の終了時に一時ファイルを削除します。本番の設定、credential、agent、受信 inbox は使用しません。

試験は、2種類の合成 runtime、順序が逆転した結果、内容変更の競合、owner・client・agent の分離、失効、期限、移行保全を確認します。受付応答の消失、既知 run の再開、実行前 image の独立復元、結果保存後の応答消失も確認します。これらは合成実行の受入試験です。

汎用 `claim()` の第3引数は `{ textRetentionMs }` です。実行先の `runnerScope` も必須です。保持期間が作業期限を覆わない依頼は、実行枠を取る前に候補から除外します。

runtime の重複防止保持期間は、不変の `acceptedAt` と作業期限を覆う必要があります。復元後に receipt を作り直しても、この基準時刻を更新しません。期限切れや保持契約の不一致では新規実行を止め、未確認の実行を未実行とは扱いません。

## 後続の受入条件

| 対象             | この単位の範囲                                                                            |
| ---------------- | ----------------------------------------------------------------------------------------- |
| T-01、T-02       | 合成2製品と元会話への相関。cross-owner 招待の公開入口は未提供                             |
| T-03、T-09、T-12 | Task 受付・実行受付・結果保存の故障と照会復帰。新しい汎用 NATS 配送経路は未接続           |
| T-05、T-06       | 外部入力と binding の分離、能力不足時の claim 拒否。実製品のモデル・tool 遮断試験は未実施 |
| T-07、T-08       | 所有者承認と承認消費の復元は未実装。実行を許可する代替経路は設けない                      |
| T-10、T-11       | 作業期限と停止未確認を区別。汎用 A2A profile の相互運用と取消状態は後続入口の試験で確認   |
| T-13             | 本文・結果・待機 queue の有限サイズ。モデル費用と自動返信ループは接続前の受入条件         |

本文・結果はNULを含まない正しいUnicode文字列です。孤立サロゲートとNULは保存前に拒否し、暗黙の置換や切り詰めは行いません。[共通application service](generic-job-application.md)に操作と公開状態を記載しています。
