# 有限受信workerと永続checkpoint

`AttachmentReceiver` はhostが明示的に呼ぶ任意の組立てです。既定runtime・MCP catalog・認証・既存 `DurableReceiver` の動作は変更しません。Task実行、model、shell、常駐loop、任意宛先の通信を追加しません。

## 組立て

固定認証主体・固定HTTP接続先を持つ既存clientと、同じ受信個体に束縛した3つの私有DBを使います。

- `SQLiteReceiveCheckpoint`: pollで受け取った**全文と一時lease token**、generation、元の期限、有限retry・fenceを保存する専用schema v1。1件の受信中deliveryを保持します。
- `SQLiteAttachmentInbox`: 各chunkの永続化・HMAC・全ファイルSHA検証。
- `SQLiteInbox`: 第3引数に同じ添付inboxを渡し、検証済みbytesを条件として本文とACK要求を原子的に保存。

`new AttachmentReceiver(checkpoint, inbox, files, fixedClient, limits, { timeout_ms })` の `workOnce()` をhostの有限実行単位で呼びます。portはtrusted local host用であり、MCP引数やremote proofではありません。異なるowner・DBの組合せを採用しません。添付gateのないinboxでは引渡しが失敗し、ACKしません。

checkpoint DBは非symlink・0600、専用private directoryとbackup管理が前提です。owner／key照合、HMAC、payload byte上限、FULL同期、secure_delete、有限busy timeout、明示migrationを持ちます。本文・lease tokenをログや公開repoへ出しません。`status()` は本文・tokenを含まない状態とsender／message／期限のmetadataだけを返します。

## 1呼出しの境界

各呼出しは**最大1 RPC**、自動loopなしです。local fence付きleaseで1件だけclaimし、SQL適用後にもlease期限を確認します。

| 状況 | 処理 |
| --- | --- |
| durable inboxに送信可能なACKあり | 既存の同じACK要求を1回送信・照合 |
| checkpointが空 | 1回pollし、全文・leaseをcheckpointへ保存 |
| 添付が途中 | 次の1chunkをreadして永続化。最後のchunk取得とlease更新は別呼出し |
| 全ファイル検証済み | inboxへ本文＋ACK要求を保存し、checkpoint本文を消去 |
| ファイル検証後に元leaseが期限切れ | 1回poll。同じsender／message／本文で新しいgenerationならcheckpoint更新 |
| 権限失効・破損・別messageへの変更 | 元checkpointを保持して隔離。未保存のdeliveryをACKしない |

全chunkを保存する前にはpollを繰り返しません。これにより、長いダウンロードでサーバーの配送attemptをchunkごとに消費しません。lease再取得時に別messageが返った場合、そのmessageをACKせず、元のcheckpointを上書きしません。この単一slot構成で複数message間の公平性や自動復旧は保証しません。有限停止後の状況判断はhost側です。

timeout後の遅いread／poll／ACK応答はlocal状態を更新しません。未完了のtransportがsettleするまで同じworkerインスタンスはbusyです。接続を強制停止する能力や、別processのネットワーク完了は保証せず、local commitはfenceで防ぎます。固定HTTP client自身の期限・サイズ・同時数制限も引き続き必要です。

## 再起動・不確実性・保守

checkpointとchunk journalから同じ本文と次のoffsetを復旧します。inbox保存とcheckpoint消去は異なるDBのcommitです。前者の成功後に消去が失敗しても、同じsender／message／generationのinbox saveは重複せず、同じACK要求を再利用します。ACKの応答消失でも新しい要求IDを作りません。

進捗のない通信・local store失敗は有限backoffとattempt上限で隔離します。権限失効・破損・message変更は即時隔離です。空checkpointでの権限失効等も自動再開せず、hostが原因を解消して判断します。`discard()` はactive leaseを拒否する明示local操作で、checkpointだけを捨てます。サーバーACK・受信本文やファイルの解放・ネットワーク通信はしません。

元の1時間TTLは延長しません。期限後の `maintain()` または次のclaimはactive lease終了後にcheckpoint本文・tokenを消去します。本文の受領が完了したinbox、検証済みファイル、各ACK metadataの保守・保持期間はそれぞれ既存契約に従います。私有DBの整合backup、未検証partial bytesの保守、サーバー孤立回収、公平性、hostの再送契機は運用課題として残ります。

## 検証

`node --test test/relay-receive-checkpoint.test.js` の29シナリオでsealed source→guarded message outbox→native loopback MCP→受信保存・ACK・物理削除、途中で全local DBを再生成、古いfence、read／ACK応答消失、inbox保存後の中断、lease更新、別message、失効、破損、遅い応答、容量、SQL rollback／期限、schema／owner／key／private file、metadata表示を検証します。

これは合成データと模擬認証による確認です。実エージェントへの導入・本番binding・費用・実transportの停止と復旧は未実施です。
