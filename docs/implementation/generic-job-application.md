# 汎用ジョブ application service

`GenericTextJobs` は、認証済みホストと既存の `TaskService` を接続します。ジョブを保存するエンジンと ID は追加しません。A2A と MCP の adapter はこの service を共有できます。

ホストの resolver は操作ごとに現在の Principal を返します。subject、clientId、送受信 agent、owner scope、受信側所有者、会話 binding はホストが検証します。外部本文はこれらを指定できません。異なる認証 client を、同じ人という理由で同一視しません。

| 操作           | 既存の必要権限                                       | 結果                                                          |
| -------------- | ---------------------------------------------------- | ------------------------------------------------------------- |
| `capabilities` | 有効な送信側 binding と submit/get/cancel のいずれか | 許可された操作の一覧                                          |
| `submit`       | submit                                               | 永続受付したジョブ。結果本文は get で取得                     |
| `get`          | get                                                  | 同じ client と完全な binding に属するジョブと確認済み結果     |
| `list`         | get                                                  | 最大20件の summary、次cursor、現在の認可scope内の正確な総件数 |
| `cancel`       | cancel                                               | 取消要求後の実際の状態。固定タスクは変更しない                |

公開する情報は ID、元message/contextの相関、状態、時刻、期限、取消確認、版付き結果です。本文、所有者、client、内部binding、実行ID、runner、journal、SQL例外は公開しません。submit-onlyの利用者が完了済み依頼を再送しても、結果本文は返しません。

一覧は状態更新時刻、IDの降順です。cursorは認可scope・filter・pageSizeへ結び付け、全ページで現在の認可条件を適用します。状態更新でページ間の位置が変わるため、snapshot保証はありません。summaryには結果本文を含めません。

lease切れは `working` と `waitReason=execution_reconciliation`、取消未確認は `working` と `waitReason=cancellation_confirmation` です。両方とも `outcome=unknown` とします。所有者承認待ちへ変換しません。停止が確認できた場合だけ `canceled` を返します。

本文と結果は、NULを含まない正しいUnicode文字列で、UTF-8最大32,768バイトです。NULと孤立サロゲートは保存前に拒否します。置換・正規化は行いません。固定版NodeのSQLite APIがこれらを変換・切り詰める場合でも、成功として扱いません。

検証はリポジトリ直下で実行します。

```sh
NODE_NO_WARNINGS=1 node --test test/generic-jobs.test.js test/generic-text-unicode.test.js
```

この段階はホスト内部のapplication APIです。プロトコル入口、実Hermes、所有者承認・再開、保護対象tool、自動返信、本番配置は、このserviceの公開だけでは有効になりません。
