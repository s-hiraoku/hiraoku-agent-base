# 受信添付の永続journal

[管理添付](managed-attachments.md) · [Relay実装](../src/relay/README.md)

専用の[SQLiteAttachmentInbox](../src/relay/sqlite-attachment-inbox.ts)が受信者ごとの有限chunkを保存する。serverのupload DB、Relay message DB、通常の本文／ACK inboxとは別schema 1であり、既存DBを暗黙に移行しない。HAB名・Task・製品SDK・network・model実行には依存しない。

この段階は保存と検証のhost APIである。通常inboxへのACK gateと、取得transportからの有限なstaging組立ては後続である。serverの添付poll／ACK、削除outbox、HTTP/MCP転送、本番接続は有効にしない。

## 保存と検証

hostは受信する個体ID、private fingerprint key、ContractLimits、固定chunk長、添付1個・record・live予約bytes・clock skew・DB waitの各上限を明示する。DBはこの個体／鍵／chunk policyに固定され、変更した設定でreopenすると拒否する。新規ファイルは0600、symlink・緩い権限・未知schemaを拒否し、migrateを明示する。親directory、journal／sidecar、backupの保護はhostが担う。資格情報や鍵を発行しない。

\x60prepare(sender_id,message)\x60は宛先が固定した受信個体であることと、時刻拘束ID・固定1時間TTL・一意な1–64添付を検証し、元message全体の鍵付きfingerprintと順序付きmanifestをtransactionで保存する。本文やlease tokenの別コピーは持たない。宣言された全添付bytesを先に予約する。元IDで同じ内容を再試行でき、caption・thread・parts順序等の変更は拒否する。sender IDは受信データの識別子であり、ネットワーク認証として使うものではない。hostは固定の検証済みtransportから得たmessageを渡す。

\x60put(sender_id,message_id,chunk)\x60はサーバーから得た有限chunkをcopyし、元の宛先・添付ID・期限・manifestと長さ・offset・EOFを検証する。chunk BLOBと次offsetを同じtransactionでcommitする。gap、overlap、異内容の再送、任意URL／path／余剰field、過大chunkを拒否する。同じoffset・bytesの再送は冪等であり、DBをreopenして保存済みnext_offsetから再開できる。実装上限はchunk 1 MiB、添付256 MiB、1添付最大1024chunkで、本番容量値ではない。

状態は\x60receiving → verified\x60、または\x60rejected / expired\x60である。bytesが全て入っただけではverifiedにしない。\x60verify\x60は全ファイルの宣言長、chunk連続性と鍵付きfingerprint、全体SHA-256を有限chunkで再計算する。未完了は再開でき、破損・digest不一致はrejectedを保存してbytesを削除し、同じIDを再開しない。空ファイルにも空SHA検証が必要である。ファイル行の欠落を「全て検証済み」と誤認しないよう、元の個数と順序も固定する。

\x60withVerified(sender_id,message,action)\x60は同じ元messageと全bytesを再確認し、同期action完了まで受信添付DBのguardを保持するローカルhost capabilityである。未完了・未検証・破損・release後にはactionを実行せず、非同期actionと再入を拒否する。リモートcallerのproofや添付ID所持で代用しない。将来の通常inboxとの組立ては、受信添付DB → 本文／ACK inboxのlock順を守る。

## 保存寿命と回収

部分保存は元message期限後に続きを受け付けず、明示maintenanceで有限batch回収する。再送・再開で期限を延長しない。一方、verifiedな受信済みbytesは受信者のlocal保存であり、server TTLで自動削除しない。\x60read\x60はverifiedデータを1chunkずつcopyして返し、ファイル名をpathにしない。内容を解釈・実行・変換しない。

hostはアプリケーションへ全bytesをdurable引渡しし、ACKが未確定なら必要な再照合も終えてから\x60release\x60する。releaseはbytesを削除してterminalなreleasedとし、冪等である。単なる取得成功・本文通知・server TTLを引渡し完了の代用にしない。

released／rejected／expiredのmetadataは元期限とterminal時刻の遅い方から30日保持する。maintenanceは期限回収とtombstone削除を共通1–100件のbatchで進め、旧要求の未来期限への付替えを時刻拘束IDで拒否する。daemonや自動常駐を起動しない。SQLite secure_deleteは有効だが、backup等の複製消去・整合restoreは別の運用責務である。

## 検証

新規17件でbinary／空ファイル、全体digest、部分保存とreopen、exact retryと差分拒否、multipart未完了・行欠落、原子的rollback、容量予約、期限、明示handoff、破損／過大BLOB、30日回収、private file／schema／identity・鍵・chunk policy、別接続との競合、非同期・再入拒否を検証した。時刻の長い経過は専用DBのhistorical fixtureで模擬する。これは電源断・backup restore・本番エージェント往復の証拠ではない。
