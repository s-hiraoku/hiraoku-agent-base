# 添付blobの個体別容量と最低予約枠

[README](../README.md) · [管理添付](managed-attachments.md) · [Message容量](relay-agent-capacity.md)

`SQLiteAttachmentStore` の任意host設定 `owner_capacity` で、検証済みownerごとの保持record上限と最低枠を追加します。MCP入力・catalog・既定runtime・認証・HAB登録は変わりません。ownerは既存の同期認可portから確定し、予約一覧やwireの名前で認証しません。HAB組立てではregistryの不変agent IDを使います。

## 数える対象

| dimension | 使用量 | 上限と解放 |
| --- | --- | --- |
| `open_uploads` | `uploading / finalized` の件数。bound済みを含む | 既存の全体・owner上限。取消し、期限処理、digest拒否、証拠付きterminal削除で解放 |
| `live_bytes` | 上記uploadの**宣言した全size_bytes**。受信済みchunk量ではない | 既存の全体・owner上限。部分uploadも全量予約し、finalize・prepareでは解放しない |
| `records` | terminalを含む全upload記録 | 全体 `max_records` と新しい `max_records_per_owner`。既存retentionと安全なGCでのみ解放 |
| `bindings` | receipt確定・ACK後も含む全message参照確定記録 | binding表独立の全体 `max_records` と `max_bindings_per_owner`。既存retentionとGCでのみ解放 |

1つのbindingに複数の添付をまとめても、uploadは添付ごと、bindingはmessageごとに数えます。chunkの再送・finalizeで重複課金しません。空ファイルも件数・記録を消費します。ACKと物理削除は分かれており、通常取得を閉じただけではblob使用量を解放しません。削除workerが現在のterminal証拠を確認してchunkを消し、uploadを閉じた時点でlive分を解放します。upload／bindingの重複防止記録は残します。

これはpayloadの予約量とrecord件数です。SQLiteのpage・index・WAL・snapshotを含むfilesystem消費量の厳密な上限ではありません。

## 予約policy

`owner_capacity` は `max_records_per_owner`、`max_bindings_per_owner`、`reservations` を持ちます。reservationは `{owner_id, open_uploads, live_bytes, records, bindings}`。hostが最大256個体を指定し、各dimensionは非負整数、0はそのdimensionの予約なしです。owner ID重複、不正ID、不足field、owner／全体上限を超える予約合計、open予約に足りないrecord予約はDBを開く前に拒否します。policyはdeep copyして保持します。

新規受付後の全体使用量に、各保護ownerの**未使用の最低予約量**を足して全体上限を超える場合は、既存の `upload_capacity_exceeded` を返します。uploadの3dimensionはbegin、binding数はprepareで判定します。保護対象以外も、現在認可されたownerであり、owner上限と未予約共有枠に収まれば受付できます。

各dimensionは独立です。bytes枠があってもrecordやbinding、message側容量、現在の宛先権限で拒否される場合があります。予約はupload成功・配送・実行の保証や、個体の登録・権限付与ではありません。本番の数値と保護対象はhostが決めます。

## commit・再照合・復旧

使用量は独立counterへ先取りせず、begin／prepareの `BEGIN IMMEDIATE` 内で既存表から集計します。判定と新規row・refのcommitは同じtransactionです。native connection同士でも最後の枠を二重使用できず、insert・ref・現在認可の失敗はquotaごとrollbackします。beginは初期化時刻から決めた元upload期限もcommit前に再確認し、遅い容量判定やSQLで期限を過ぎれば受付を取り消します。接続初期化にもhostの有限busy timeoutを最初から適用します。

同じowner／元request IDのbegin再送、同じmessageのprepare再送とconflict判定は、新規quota判定より先です。満杯・設定縮小・再起動後も元receiptを照合できます。chunk継続・finalizeは既存の予約を使い、同じID・bytes・期限を維持します。予約を後から追加しても、保存済みuploadや記録を追い出しません。

元期限を過ぎた行も、既存statusの期限処理または明示した有限maintenanceで閉じるまでは容量へ数えます。受付のために無制限GCやretention短縮を行いません。bound uploadは短いupload期限ではなく元bindingの期限まで保持します。

追加schema・migrationはなく、upload DBはschema2のままです。snapshotには元の表が入り、停止復元後は現在host policyで使用量を再集計します。policyはsnapshotに含めません。すべてのwriterへ同じpolicyを配線し、変更時はwriterを静止・照合して切り替える必要があります。異なるpolicyのwriterを同時稼働した状態の予約保証は提供しません。

## 検証と残り

`node --test test/relay-attachment-capacity.test.js` の24シナリオで、宣言bytes・open・terminal metadata・bindingの予約、空ファイル、複数refs、再送・conflict、policy copy／縮小／reopen、取消し・digest拒否・元期限・bound削除、rollback、native begin／prepare競合、起動lock待機・遅いSQLを確認します。HAB registryを通した不変IDのowner確定・予約・現在block拒否も含みます。

個体別rate、公平なwriter受付、disk／時間の予算、本番のpolicy値・監視・実製品配線は残っています。送信側source journal・受信側ファイルinboxの容量は、それぞれのローカル契約が担当します。
