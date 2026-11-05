# 受信側への本文引渡しと実機検証の準備

共通MCPの受信後に内容を判断するのは、受信エージェントである。HABは定期poll、durable保存後ACKと、認証済みcallerによる明示的な本文取得を提供する。製品固有runner、モデル起動や承認機構は追加しない。[設計判断 ADR-015](hab-decisions.md)と[共通MCP接続](common-mcp-connection.md)を基準にする。

## 保存済み本文の取得

既存hostの`inbox`は診断用metadataだけを返す。新しいローカル操作[inbox_read](adapter-host.md#保存済み本文を明示的に読む)は一つのsourceを指定し、現在の認可・pause/epoch・設定済みowner・保存内容のHMACを確認してcopyを返す。共通MCPの5操作や受信supervisorは変更しない。

純粋な読取りは`receipt_confirmed=false`の保存済み本文にも対応する。配送receiptの不確実性を隠さず、読取りと引受け・処理・承認を分けるためである。返信とTaskの既存確認条件は緩めない。別のreader serviceや共通ライフサイクルの抽出は、同じ権限境界を二重化するため今回は追加しなかった。

```sh
NODE_NO_WARNINGS=1 npm run test:communication-boundary
```

新規7ケースは、正確な保存本文・nested JSONのcopy、source別権限、返信権限の分離、ACK応答消失中の読取りと元ACKの照合、missing/released、改ざん、返却前の失効とpauseを検証する。実loopback HTTPの送信→周期受信→保存後ACK→明示的本文取得を通り、受信側driverが別のanswer/send操作を選ぶまでoutboxとTaskが空であることを確認する。

このdriverは合成の受信側判断であり、実製品のモデルや所有者承認を模倣して合格したとは扱わない。周期は注入schedulerで進めるため、実時間の30秒運用を測定した結果でもない。

## 実機受入れに必要な対応関係

| 対象 | 既存の証拠・準備 | 実機で確定すること |
| --- | --- | --- |
| 呼出主体 | hostは検証済みcontextから操作・actor・sourceを確認 | 実製品の認証済みcallerと受信アドレスの対応。表示名・本文のsession IDで選ばない |
| 受信契機 | ReceiveSupervisorはモデルなしでreceiveのみを反復 | その製品hostが提供する正式な定期実行、頻度、停止方法。MCP登録だけで常駐としない |
| MCP transport | 共通clientのloopback HTTPと保存後ACKを検証 | 既存native MCP clientの正式な呼出し位置、認証更新の所有者、同じアドレスへの固定 |
| 保存 | SQLiteInbox・control・owner・元ACK照合を利用可能 | 本人限定の保存先・鍵・容量とrestart時の同一binding。新規認証・保管設定は別途確認 |
| 本文引渡し | source別のinbox_readで保存済み外部データを返す | 実製品の表示／agent入力の正式APIと受信者session binding。存在しないinject/wake APIを仮定しない |
| 内容判断・実行 | HABは実行や承認を行わない | 受信agentの既存policy・権限・承認を通る実際の経路と、不足能力の表示 |
| 返信 | 既存answer intent・budget・outbox・明示sendを利用 | 本文・相手・元ID・期限を固定し、受信側が必要な承認を確認して送信 |
| 停止・復旧 | host pause、owner、drainと同ID照合を模擬確認 | 実起動コマンド・対象release・停止権限と整合backup。close/reopenとkill-9を区別 |

この表は実機接続成功を示すものではない。実製品の正式なcaller/表示/agent入力APIが確認できない場合は、ローカル保存・取得までと明記する。Hermes専用実行系や任意Taskへ置き換えて、この不足を隠さない。

## 適用前にレビューする差分

実稼働へ進む前に、対象製品・承認済みrelease、接続先、所属groupとアドレス、既存MCP transport、保存先、実効権限・承認、受信頻度、起動・停止・復元手順を具体化する。設定値やAPIを推測して新credential、grant、常駐jobを作成しない。

今回の変更は製品に依存しないローカル読取り口と検証準備である。稼働中のサービス・設定、実agent、実モデル、承認UIや本番processへの故障注入は変更・実行していない。
