# 管理添付：独立upload基盤

[README](../README.md) · [正式仕様](hab-relay-spec.md) · [Relay実装](../src/relay/README.md)

第1段階はbegin・status・chunk再送・finalize・cancel・期限回収・30日receipt回収である。HAB名、Task、製品SDKに依存しない。**messageの添付受付、受信bytes取得、ACK前のdurable添付保存、message連動削除outbox、HTTP/MCP転送は後続**とし、既存Relay／outbox／inboxは添付参照を引き続き`attachment_store_unavailable`で拒否する。finalizedはuploadの完全性を示し、message受付・受領・実行を示さない。

## 契約

副作用のない[attachments.ts](../src/relay/attachments.ts)がversion 1の`UploadIntent`、`UploadReceipt`、`AttachmentUploadStore`、`AttachmentUploadService`を定義する。既存Relay公開entryは自動importしない。

begin入力は`version:1`、`request_id`、`message_id`、`recipient_id`、`kind`、`first_sent_at`、`expires_at`、`attachment`のみである。attachmentは`media_type`、`size_bytes`、lowercase SHA-256、任意の表示用`filename`を持つ。元message時刻はUTC、期限との差は固定1時間とする。ownerは検証済みhost contextから確定し、任意URL、path、添付ID、tokenやclaimsの追加fieldは拒否する。filenameは保存先pathに使わず、画像・音声・ファイルのbytesを解釈・変換・実行しない。

`makeUploadRequestId(first_sent_at,fresh128BitEntropyHex)`は`au1.<epochミリ秒>.<32桁hex>`を作る。時刻を元期限と照合し、receipt回収後も同じIDを未来期限へ付け替えられない。helperは乱数を生成せず、hostが新しいentropyを供給し外部送信前にintentをdurable保存する。これはcredentialではない。

`put(context,attachment_id,offset,Uint8Array)`はoffset順に固定chunk長を受け取り、末尾だけ残byte長を許可する。statusの`next_offset`と`chunk_bytes`から再開する。同じoffset・bytesは冪等で、異内容、gap、overlap、不正長を拒否する。bytesは上限確認後にcopyする。空ファイルはchunkなしで空SHAを検証する。HTTPのchunk表現や公開MCP toolはまだ追加しない。

## 認可と状態

`UploadAuthorization`は`begin/status/chunk/finalize/cancel/maintenance`の現在主体と操作権限をhostから受け取る。未注入・失効・例外・非同期decisionは拒否する。引数の名前や未検証claimsを認証するportではない。

storeはtransaction内でownerを解決し、既存uploadならowner scopeで取得後、保存済み宛先・kindを再検証する。外国体と未知IDは同じ`upload_not_found`になる。exact retryも現在認可を省略しない。停止・失効とcommitの間を保護するhostは、policyの同期guardを先に取得しupload transaction完了まで保持する。HABへの組立ては次の層で行う。maintenanceは別の明示権限である。

状態は`uploading → finalized`、またはterminalな`cancelled / expired / rejected`である。finalizeはchunkの連続性、長さ、鍵付きfingerprint、全体SHA-256を再検証する。未完了は`upload_incomplete`として再開でき、digest不一致・保存破損は`rejected`をcommitしbytesを解放する。呼出しが返っただけで成功とせず、`state`と固定`reason`を確認する。

cancelと期限切れはpartial／finalizedのbytesを削除する。ID・owner・元intent・期限は変更できず、terminalを再開しない。upload期限は`min(begin時刻＋明示upload_ttl_ms,元message期限)`で固定する。status／finalize／cancelと有限maintenanceで期限回収する。daemonは起動せず、idle時の保守は後続hostが組み込む。

## Backendと容量

[sqlite-attachment-store.ts](../src/relay/sqlite-attachment-store.ts)はmanifestとchunk BLOBをRelay message DBとは別の専用schema 1へ保存する。message SQL行やMCP envelopeへ大きなbytesを埋め込まない。chunkとprogress、finalize、cancel／期限回収はupload DB内の同一transactionでcommitする。Relay DBとの分散transactionや、将来の外部blob backendとの原子性は仮定しない。

新規ファイルは0600とし、symlink・緩い権限・未知schema・鍵不一致・chunk policy変更を拒否する。migrateは明示操作である。private HMAC keyはhost供給で、発行・取得・保管先選択は行わない。親、journal／sidecar、backupもhostが保護する。SQLite secure_deleteを有効にするが、backup等の複製消去は別の運用責務である。

hostは添付bytes、chunk bytes、record数、open upload数と予約bytesの全体／owner別上限、upload TTL、clock skew、DB busy timeoutを明示する。beginで全宣言bytesを予約し、partialとfinalized orphanもquotaを消費する。cancel／期限回収／rejectがbytes枠を解放する。

実装天井は添付256 MiB、chunk 1 MiB、1upload最大1024chunk、upload TTL最大1時間、maintenance 1–100recordであり、本番値ではない。finalizeはchunkごとにhashし添付全体をメモリへ集めない。同期SQLite/hash処理はhostの応答期限で途中中断できない。実転送adapterの入力・並列・rate・時間上限は別途必要である。

terminal receiptは`max(terminal時刻,upload期限,元message期限)＋30日`まで保持する。maintenanceは期限切れとreceipt回収を共通の有限batchで進める。回収後の古い要求は期限切れ、同じIDの未来期限への付替えは不正要求になる。容量不足は新規beginを拒否し、既存exact retryや保守のための新規record枠は要求しない。

## 検証と次の層

`node --test test/relay-attachments.test.js`の25件でbinary／空ファイル、strict schema、外国体拒否、現在権限、再開・冪等、digest／chunk破損、rollback、容量予約、期限・30日GC、private file／schema／key、競合・再入を検証する。期限とretentionは専用一時DBだけをagingし、実時間を待つ試験ではない。実ファイルやcredentialは使わない。

次はHAB registryのsubmit権限、宛先状態・kind・block・失効のguardと組み合わせる。その後、messageとの参照確定・孤立回収、認証付き取得、receiverのdurable保存とACK連携、削除outbox、MCP転送、backup整合を実装する。upload単体の成功を添付配送や本番3者接続の完了とは扱わない。
