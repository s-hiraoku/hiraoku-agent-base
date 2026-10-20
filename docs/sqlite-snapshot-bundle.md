# 配送DB群のsnapshotと停止状態への復元

`SQLiteSnapshotBundle` はtrusted host用の任意APIです。実装と合成データの試験だけを追加し、実ユーザーデータのbackup・runtime停止／起動・資格情報の発行やコピー・外部転送は実行していません。

## 対象と境界

profileは次の固定した一組です。部分集合、未知role、異なるlocal owner、未知schema、許可したtable集合以外が混在するDBは拒否します。

| profile | DB（取得lock順） |
| --- | --- |
| server | Relay schema 4 → upload／binding schema 2 |
| sender | source upload journal schema 1 → message outbox schema 2 |
| receiver | 全delivery checkpoint schema 1 → attachment inbox schema 1 → body／ACK inbox schema 3 |

registry・認証／権限・OAuth・秘密設定・Task EngineのDBや鍵は対象に含めません。復元で現在の停止・失効情報を巻き戻さず、現在のregistry／認証を別途使います。本文・source bytes・一時lease tokenを含むSQLiteコピーは**暗号化されていない私有データ**です。snapshotは公開repo・公開ディレクトリ・外部storageへ出しません。

hostはprofileの全source絶対path、snapshot root、別のrestore root、有限容量／DB wait／期限と、承認済みの既存integrity keyを明示します。キーは生成・取得せず、bundleへ保存しません。元storeのfingerprint keyもコピーせず、hostが既存の安全な手段で保持する必要があります。新しい永続キーの発行や外部保存先接続は別の承認事項です。

## 作成と検証

`create(verifiedContext, snapshotId)`、`verify(verifiedContext, snapshotId)`、`restore(verifiedContext, snapshotId, restoredId)` は独立した同期認可を要求します。未設定は拒否し、入力の名前を認証に使いません。各段階で同じ検証済み主体と現在権限を確認し、Promise decision・途中失効・主体変更を拒否します。

1. sourceはprivate owner・mode、直接のprivate parent、canonical path、非symlink・非hardlink、sidecarのmode、容量を確認します。ゆるい権限を自動修復しません。
2. profileの**全DBにBEGIN IMMEDIATE writer lockを取得してから**、別readonly接続でNode 24の公式 `sqlite.backup` APIを実行します。一つでもbusyなら取得済みlockも解放し、完成品を公開しません。
3. 全lockを保持したまま各DBを取得し、source inode、schema・owner、SQLite integrity／foreign keys、容量を確認します。WALはSQLiteの論理snapshotから取り込み、コピーを単独DELETE journal形式へ確定します。live WAL／SHMファイルを単純コピーしません。
4. 0600のDBごとのサイズ・SHA-256とprofile／schema／作成時刻を、HMAC付き `manifest.json` に保存します。source path・本文・tokenをmanifestへ入れません。ファイルとディレクトリをfsyncし、manifestを最後の完成条件とします。
5. `verify` は署名・固定ファイル集合・hash・schema・owner・SQLite整合を再検証します。任意ファイル名や余剰ファイルを拒否します。

snapshot／restore rootと成果物directoryは0700、ファイルは0600です。出力IDはpathではなく制限した単一名です。既存directoryを置換せず、途中失敗の成果物を完成品と扱いません。失敗時は完成manifest／復元markerを残さず、部分ファイルは私有directoryに保持します。同じIDへ上書き再試行せず、hostが不完全成果物を照合・処置します。

## 停止復元と照合

restoreは検証済みの同じprofileだけを**新しいdirectory**へコピーします。既存source DB・既存復元先・runtime設定へ書き戻しません。`restore.json` に `network_enabled:false` と `requires_reconciliation:true` を残し、結果は `state:offline` です。このmarkerは作業状態の記録であり、認証やネットワークを強制停止するsecurity boundaryではありません。API自体にruntime起動・接続再開機能がありません。

実運用へ昇格させる前には、hostが旧個体の処理と新規外部IOを停止し、使用するDB一式・元の鍵・current registryを照合します。元ID、元期限、server receipt、run／ACK／削除outboxを照合し、不明な送信・仕事を新しいIDで再実行しません。snapshot取得後にremote側が進んだ場合や、冪等記録の保持期限を過ぎた場合を、復元ファイルだけで解決したと扱いません。元leaseのwall-clock期限は保持し、延長・再発行しません。

writer lockが保証するのは取得時点の対象DBの静止です。実行中のmodel、外部RPC、DBの置換や運用全体の停止は別のhost境界です。live writerはbusyになり得るため、本番実行にはadmission／IOを止める運用手順と事前確認が必要です。backup APIの完了を待ってからlockを解放し、途中のdeadline／認可失効では完成manifestを公開しません。期限は同期SQL・native copy・fsyncの境界で確認し、OS I/Oを強制中断するhard timeoutや電源断耐久性は保証しません。

## 検証と次の受入れ

`node --test test/relay-snapshot-bundle.test.js` の24シナリオで、server／sender／receiverの一括復元、WAL、source／未送信本文／部分受信の保持、blob commit後・削除完了前の同じfenced job照合、全writer lock、busyと解放、改ざん、権限の分離・失効・主体変更、inode差替え、schema／owner、容量／期限、重複操作、private permissionsと上書き拒否を確認します。停止復元したserverの同じ受付receiptを照合し、現在のregistryによる停止も有効なことを確認します。

これはlocal合成DBでのrehearsalです。実runtimeの静止・昇格、current registryと鍵の復旧、古いremote状態との照合、世代管理・保存期限・ディスク故障／電源断、外部backup先、本番エージェント接続は未検証です。自動常駐・本番配線・権限拡大の根拠にはしません。

実装確認に使った一次資料: [Node v24.x SQLite backup API](https://github.com/nodejs/node/blob/v24.x/doc/api/sqlite.md)、[SQLite Online Backup API](https://www.sqlite.org/backup.html)。APIは実機でもwriter lock保持中のreadonly接続による合成snapshotで確認しました。
