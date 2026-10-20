# 添付メッセージの永続送信キュー

任意のhost組立てでのみ有効になります。既定の `SQLiteOutbox` は添付を拒否し、runtime・認証・自動実行を変更しません。

`AttachmentOutboxAdmission` は同期のローカル能力です。`SQLiteUploadJournal` を `SQLiteOutbox` の第3引数に渡すと、新規enqueue前に全添付の完了receipt、固定owner、元のmessage ID・宛先・kind・時刻、ファイル名・media type・サイズ・SHAを照合し、保持中sourceの全bytesを再検証します。テキストや構造化データは既存契約を使います。任意URL・ローカルpath・受信側の実行指示は追加しません。

## 引渡しと再開

1. sourceをprepare／putSource／sealし、有限upload workerでfinalizedを確認します。
2. 同じmessage ID・宛先・期限と、得られたattachment IDでメッセージを組み立て、添付gateを設定したoutboxへenqueueします。
3. enqueue成功後、必要ならsourceを明示的にreleaseできます。自動解放はしません。claim時には保持された完了metadataを再照合します。新規登録前のreleaseは拒否します。
4. `DurableSender.sendOnce()` は既存の固定transportへ1回submit／statusします。失われた応答は同じID・本文・期限で照合します。

source DB → outbox DBの順に同期guardを保持します。callbackのPromise・再入・guard外再利用を拒否します。異なるDBを分散transactionとは扱いません。outbox commit後のsource側失敗では結果が不確実になり得ますが、同じenqueueを再試行すると既存のfingerprintに照合し、重複jobを作りません。元ファイルを先に消したり、新しいIDを発行したりしません。

永続本文のHMACと行のidentityをclaim前に再検証します。添付gate未接続で再起動した場合、添付submitは保留し、試行回数を消費しません。本文TTL後のstatus照合は添付gateなしでも可能です。source metadataを先に回収すると未送信メッセージは送信できないため、outboxの状態・照合期間も考慮してhostが保守します。

## 検証と限界

`node --test test/relay-attachment-outbox.test.js` は21シナリオです。native loopback MCPで送信→受信保存→ACK→サーバーbytes削除を確認し、失われたsubmit応答、再起動、宛先・manifest変更、複数添付、source／本文破損、容量不足、guard逸脱、期限後statusを検証します。

受信の有限orchestration、本番binding、実Adapterの再送契機、整合backup・運用回収は別の境界です。配送ACKはTask実行・内容の受諾を意味しません。
