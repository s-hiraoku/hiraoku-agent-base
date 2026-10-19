# 管理添付：独立upload・message参照確定と受付

[README](../README.md) · [正式仕様](hab-relay-spec.md) · [Relay実装](../src/relay/README.md)

uploadとmessageの参照確定・受付再照合を、HAB名・Task・製品SDKに依存しないhost APIとして実装した。既定Relay／outbox／inboxは添付参照を引き続き`attachment_store_unavailable`で拒否する。明示した任意の組立てだけが添付messageを受付でき、受信者認可付きの有限chunk取得も独立host APIとして追加した。HABの取得guardも別層で組み立てた。[受信添付journal](attachment-inbox.md)では部分保存・再開・全体SHA検証も独立して実装した。通常inboxのACK前検証も組み立てた。[terminalと同時commitする削除outboxと単発worker](attachment-deletion.md)も実装した。第4引数の明示host portへ確定bindingの検査を接続するとserver添付poll／ACKを利用でき、受信保存から物理削除までin-processで確認した。admissionだけの構成は引き続き添付をleaseせず、ACKも拒否する。**HTTP/MCP添付転送と本番配線は後続**である。finalized、message受付、受領、実行はそれぞれ別の状態である。

## 契約

副作用のない[attachments.ts](../src/relay/attachments.ts)がversion 1の`UploadIntent`、`UploadReceipt`、`AttachmentUploadStore`、`AttachmentUploadService`を定義する。既存Relay公開entryは自動importしない。

begin入力は`version:1`、`request_id`、`message_id`、`recipient_id`、`kind`、`first_sent_at`、`expires_at`、`attachment`のみである。attachmentは`media_type`、`size_bytes`、lowercase SHA-256、任意の表示用`filename`を持つ。元message時刻はUTC、期限との差は固定1時間とする。ownerは検証済みhost contextから確定し、任意URL、path、添付ID、tokenやclaimsの追加fieldは拒否する。filenameは保存先pathに使わず、画像・音声・ファイルのbytesを解釈・変換・実行しない。

`makeUploadRequestId(first_sent_at,fresh128BitEntropyHex)`は`au1.<epochミリ秒>.<32桁hex>`を作る。時刻を元期限と照合し、receipt回収後も同じIDを未来期限へ付け替えられない。helperは乱数を生成せず、hostが新しいentropyを供給し外部送信前にintentをdurable保存する。これはcredentialではない。

`put(context,attachment_id,offset,Uint8Array)`はoffset順に固定chunk長を受け取り、末尾だけ残byte長を許可する。statusの`next_offset`と`chunk_bytes`から再開する。同じoffset・bytesは冪等で、異内容、gap、overlap、不正長を拒否する。bytesは上限確認後にcopyする。空ファイルはchunkなしで空SHAを検証する。HTTPのchunk表現や公開MCP toolはまだ追加しない。

## 認可と状態

`UploadAuthorization`は`begin/status/chunk/finalize/cancel/maintenance`の現在主体と操作権限をhostから受け取る。未注入・失効・例外・非同期decisionは拒否する。引数の名前や未検証claimsを認証するportではない。

storeはtransaction内でownerを解決し、既存uploadならowner scopeで取得後、保存済み宛先・kindを再検証する。外国体と未知IDは同じ`upload_not_found`になる。exact retryも現在認可を省略せず、SQLite storeはCOMMIT直前にも各decisionを再確認する。callbackは同期・副作用なしとし、複数回呼ばれる前提にする。停止・失効とcommitの間を保護するhostは、policyの同期guardを先に取得しupload transaction完了まで保持する。[HabAttachmentUploads](../src/hab/attachment-uploads.ts)がそのguardを実装し、registry → upload DBの順で取得する。maintenanceは別の明示権限である。

状態は`uploading → finalized`、またはterminalな`cancelled / expired / rejected`である。finalizeはchunkの連続性、長さ、鍵付きfingerprint、全体SHA-256を再検証する。未完了は`upload_incomplete`として再開でき、digest不一致・保存破損は`rejected`をcommitしbytesを解放する。呼出しが返っただけで成功とせず、`state`と固定`reason`を確認する。

未参照uploadのcancelと期限切れはpartial／finalizedのbytesを削除する。messageへ予約済みの添付はcancelを拒否し、元message期限まで保護する。ID・owner・元intent・期限は変更できず、terminalを再開しない。upload期限は`min(begin時刻＋明示upload_ttl_ms,元message期限)`で固定する。status／finalize／cancelと有限maintenanceで期限回収する。daemonは起動せず、idle時の保守は後続hostが組み込む。

## Backendと容量

[sqlite-attachment-store.ts](../src/relay/sqlite-attachment-store.ts)はmanifestとchunk BLOBをRelay message DBとは別の専用schema 2へ保存する。message SQL行やMCP envelopeへ大きなbytesを埋め込まない。chunkとprogress、finalize、cancel／期限回収はupload DB内の同一transactionでcommitする。Relay DBとの分散transactionや、将来の外部blob backendとの原子性は仮定しない。

新規ファイルは0600とし、symlink・緩い権限・未知schema・鍵不一致・chunk policy変更を拒否する。migrateは明示操作であり、schema 1から2へのtransactional migrationは既存chunkと鍵・chunk policyを保持する。private HMAC keyはhost供給で、発行・取得・保管先選択は行わない。親、journal／sidecar、backupもhostが保護する。SQLite secure_deleteを有効にするが、backup等の複製消去は別の運用責務である。

hostは添付bytes、chunk bytes、record数、open upload数と予約bytesの全体／owner別上限、upload TTL、clock skew、DB busy timeoutを明示する。beginで全宣言bytesを予約し、partialとfinalized orphanもquotaを消費する。cancel／期限回収／rejectがbytes枠を解放する。

実装天井は添付256 MiB、chunk 1 MiB、1upload最大1024chunk、upload TTL最大1時間、maintenance 1–100recordであり、本番値ではない。finalizeはchunkごとにhashし添付全体をメモリへ集めない。同期SQLite/hash処理はhostの応答期限で途中中断できない。実転送adapterの入力・並列・rate・時間上限は別途必要である。

terminal receiptは`max(terminal時刻,upload期限,元message期限)＋30日`まで保持する。maintenanceは期限切れとreceipt回収を共通の有限batchで進める。回収後の古い要求は期限切れ、同じIDの未来期限への付替えは不正要求になる。容量不足は新規beginを拒否し、既存exact retryや保守のための新規record枠は要求しない。

## message参照と別DB間の受付

[attachment-bindings.ts](../src/relay/attachment-bindings.ts)は独立した予約port、[attachment-acceptance.ts](../src/relay/attachment-acceptance.ts)は受付専用coordinatorである。新規添付messageは時刻拘束された`rm1` IDと、重複しない1–64個の添付参照を要求する。元owner、message ID、宛先、kind、時刻、media type・byte長・digest・filenameがfinalized uploadと全て一致しなければ拒否する。

`prepare`は全添付の検証と順序付き参照の保存を、upload DBの同じtransactionで行う。一部だけpinされる状態は作らない。本文・thread・返信参照・parts順序を含むmessage全体の鍵付きfingerprintを保存し、本文の別コピーは保存しない。同じIDのexact retryは同じ予約を返し、内容変更を拒否する。予約数も有限のrecord上限を持つ。

hostは専用Relay storeへ同期`AttachmentAdmission.check`を明示注入する。coordinatorは検証済みcontextから現在のsubmit主体を決め、`prepare → Relay commit → confirm`の順に実行する。Relay transaction内のcheckは保存済み予約とmessage全体、順序付きfinalized参照を再確認する。confirmのreceiptは固定のRelay storeが返したものだけを使い、呼出し引数から「受付済みの証拠」を受け付けない。省略・非同期admissionは拒否する。既定constructor、純粋entry、MCP catalog、既存outbox/inboxは変更しない。

これは分散transactionではない。prepare後にRelay受付が失敗しても予約を取り消さず、同じ元intentで再試行できる。Relay commit後にconfirmや応答が失われても、両DBをreopenして元のreceiptへ再照合する。新しいIDで再送したり、期限を延長したりしない。受付前後が不明な予約を早期解除するAPIは設けず、元messageの1時間期限まで保持する。失効中の再照合も拒否し、現在権限が回復した後のexact retryで照合する。一般のstatusは通常のstatus認可を要求する。

参照済み添付は短いorphan upload期限で削除せず、元message期限を有効期限とする。status／finalize／maintenanceで期限後にbytesを回収し、receipt・参照tombstoneは30日保持する。metadata回収は参照を先に外し、保護対象のuploadを先に消さない有限batchで行う。idle時の削除はhostの明示maintenanceが必要であり、daemonは起動しない。通常の添付cancelは生きた予約を解除できない。

添付受付admissionだけを注入したstoreでは、pollは添付を含むmessageをskipし、ACKは`attachment_delivery_unavailable`で拒否する。hostが第4引数へ`AttachmentDeliveryPolicy`を明示し、固定upload storeの`checkDeliverable`でconfirm済みの元receiptと参照を検査する場合だけ配送を有効にする。受信者は検証済みlocal bytesを通常inboxへ保存してからACKする。scanは既存の有限上限内であり、多数の保留添付がある場合の公平性は未検証である。hostはpolicy guardを取得して各DB操作完了まで保持する必要がある。[HabAttachmentAcceptance](../src/hab/attachment-acceptance.ts)がこのcoordinatorをregistryの同期guardで包む。registry → upload prepare → Relay acceptance → upload confirmの順で、registry lockだけを全体に保持する。submit権限だけで元受付のexact retryを照合でき、公開statusには別のstatus権限が必要である。scoped decisionはcallback外へ持ち出せず、別接続の停止・失効は処理の前後へ直列化される。ただし他DBのcommitをregistry rollbackで巻き戻すことはできない。認証contextが受付後に期限切れとなれば、保存した予約・元receiptを維持し、新しい検証済みcontextで照合する。

## 受信者認可付きchunk取得

[attachment-read.ts](../src/relay/attachment-read.ts)の`AttachmentReadService`は取得専用の任意host APIである。呼出し入力は`version:1,sender_id,message_id,attachment_id,offset`だけを許可し、receiver、取得URL、path、自由なrange長、受付証明は受け付けない。sender IDは検索用であり認証ではない。現在の受信主体とpoll権限はhostで検証したcontextから決め、保存済みsender／kindに対する現在ポリシーも確認する。未注入・例外・非同期decisionは拒否する。

固定のRelay storeが自身のtransaction内で、受信者にscopeした元受付、pending／leased状態、残っている本文、元期限、本文全体のfingerprintと添付所属を確認する。upload storeは確定済みbindingのreceipt identity、message全体のfingerprint、順序付きfinalized参照とmanifestを再確認する。未参照upload、prepareだけの予約、confirm未完了の受付からbytesは取得できない。Relay callback中だけ有効なguardは持ち出せず、保存済みproofを後から再利用できない。

取得は固定chunk境界のoffsetから1chunkだけを返す。末尾だけ短くなり、全長offsetでは空のEOF、空ファイルではoffset 0の空EOFとなる。chunk上限はhostの保存policy（最大1 MiB）であり、callerは指定できない。DBからの読み出しもchunk長＋1に制限し、長さと鍵付きchunk fingerprintを確認してcopyする。異offset・破損・欠落は固定エラーとし、黙って欠落したbytesを返さない。EOFはclientがそれ以前の全bytesを保存・検証した証明ではない。

同じoffsetのretryは同じbytes・manifest・元期限を返し、serverの進捗や期限を更新しない。clientは元message／添付IDと次offsetをdurable保存してから再開する必要があるが、部分保存・再開・全体検証のjournalと通常inboxのACK前検証は実装した。任意のserver側host組立てでは、実leaseとACK・削除outbox／workerにも接続できる。finalize時の全体SHA検証に加え、receiverも全体byte長・SHAを確認してから保存完了と扱う。

lock順はRelay → upload DBであり、両方のguard完了後にchunkを返す。取得中のterminal化はRelay write guardで直列化し、ACK済み・期限切れ・隔離・本文削除後は拒否する。送信者の権限や添付IDの所持だけでは取得できない。chunk取得後も権限と期限を再確認し、途中失効／期限到来なら呼出し元へbytesを返さない。[HabAttachmentRead](../src/hab/attachment-read.ts)はregistry guardを最初に取得し、registry → Relay → upload DBの順でchunk取得完了まで保持する。停止・失効・blockと取得を直列化し、受信者の現在poll権限、送信者の現在状態・kindと元の送信方向のblockを確認する。status権限だけでは取得できず、read専用wrapperは保守・ACK権限を追加しない。scoped authorizationとRelay guardはどちらも処理外へ持ち出せない。guardなしの外部認可cacheはこの保証を持たない。

このAPIはlease発行・配送ACK・受信保存・削除を行わず、取得のための新規credential、公開URL、MCP toolやrouteも作らない。default Relayは添付admission未注入なら取得も拒否する。配送policy未注入のpollは添付messageを引き続き保留し、ACKも拒否する。取得APIの成功を配送完了や実エージェント接続の成功とは扱わない。

## 検証と次の層

`node --test test/relay-attachments.test.js`の25件でbinary／空ファイル、strict schema、外国体拒否、現在権限、再開・冪等、digest／chunk破損、rollback、容量予約、期限・30日GC、private file／schema／key、競合・再入を検証する。期限とretentionは専用一時DBだけをagingし、実時間を待つ試験ではない。実ファイルやcredentialは使わない。

HAB guardとの組立ても別層で実装し、submit権限、宛先状態・kind・block・失効とcommit時の現在判定を14件で追加検証した。通常upload portに保守権限や新規MCP toolは追加しない。参照確定の18件と受付の12件では、実SQLiteの原子的pin、cancel競合、migration、期限・順序付きGC、受付前後の障害、両DBのreopen、応答消失、容量不足、再照合、配送／ACK拒否を追加検証した。独立DBのreopen試験はbackup restoreや電源断の耐久性試験ではない。HAB受付guardの14件では別接続によるprepare／Relay commit／confirm間の失効競合、submitとstatusの分離、停止・block・binding失効、持ち出したdecision、実際の短いcontext期限切れと再照合も確認した。受信chunk取得の21件でbinary再構成、空／EOF、再開・reopen、外国体／所属違い、未確定拒否、ACK・期限・隔離後拒否、破損／過大BLOB、持ち出したguard、競合・取得中失効／期限到来を追加検証した。HAB取得guardの13件で権限分離、停止・block・binding失効、取得中の別接続失効競合、持出し、context期限切れ後の同offset再開も検証した。受信添付journalの17件とstaging／local ACK gateの16件も追加した。さらに削除outboxの18件と[配送・workerの20件](attachment-deletion.md#検証範囲)で、terminalと削除依頼の原子的commit、実Relay lease・ACK、受信者のdurable保存、物理削除と障害後の照合を確認した。残るのはHTTP/MCP添付転送、孤立回収の運用、backup整合と本番配線である。host APIの模擬往復を本番3者接続の完了とは扱わない。
