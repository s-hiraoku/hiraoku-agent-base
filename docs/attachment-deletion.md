# 添付配送・削除outboxとterminal証明

[README](../README.md) · [管理添付](managed-attachments.md) · [受信添付journal](attachment-inbox.md) · [正式仕様](hab-relay-spec.md)

Relay schema 4は、元messageに固定した順序付き添付IDと、terminal時の削除outboxを同じDBへ保存する。[host-only契約](../src/relay/attachment-deletion.ts)と[単発worker](../src/relay/attachment-deletion-worker.ts)が、別DBの物理削除を元jobへ照合する。資格情報・scheduler・公開toolは持たない。添付配送は明示的なhost組立てだけが利用でき、既定の添付拒否を維持する。

## 配送の明示組立て

`SQLiteRelayStore`の第3引数へprepare済み参照のadmission、第4引数へ[AttachmentDeliveryPolicy](../src/relay/attachment-delivery.ts)を注入する。第4引数は有限の`limits`と同期`check`を持ち、同じ固定upload storeの`checkDeliverable(acceptance,receipt,limits)`へ接続する。callerのbooleanやagent名では有効化できない。省略時は添付pollを保留し、ACKを拒否する。

poll／初回ACKは元本文のfingerprint、順序付き参照、finalized状態、confirm済みの元receipt identityを再確認する。prepare後やRelay commit後にconfirmが失われたmessageはleaseせず、送信側の同じIDによる再照合を待つ。現在の受信権限・保存済みsender／kind・元期限・leaseも確認する。HAB経由では既存のregistry guardと停止・失効・blockを維持する。

受信側は`AttachmentStager`で有限chunkをdurable保存し、全体SHAを検証する。`SQLiteInbox`へ同じ受信個体の添付journalを第3引数として注入し、saveとACK claimの直前に全bytesを再確認する。ACKは受領の記録であり、内容の実行は行わない。これらに[任意MCP／HTTP転送境界](attachment-transport.md)を組み立てられる。固定client転送と既存runtimeへの配線は別途必要である。

## terminalと同時に保存するもの

受付時に、sender／message／recipient／receipt identity／元期限へ固定した参照fingerprintを本文・配送・auditと同じtransactionで保存する。本文の別コピーやfilename、digest、bytesは保存せず、添付IDだけを保持する。元messageの期限回収と初回ACKでは、本文消去・配送terminal化・audit・削除依頼を同じtransactionでcommitする。enqueueや後続auditの失敗はACKを含む全体をrollbackする。

削除payloadは元receipt、順序付き添付ID、acked／expiredの理由とterminal時刻だけを持つ。messageごとに1件で、元IDの再試行はjobを増やさない。payloadと参照は鍵付きfingerprintと更新禁止triggerで保護する。本文・token・任意エラー文字列をoutboxへ残さない。ACK確定後の取得は直ちに拒否し、物理削除の成功を待たない。

pending／leased／parkedな削除依頼が残る間はmessage GCを止める。doneとなった依頼は元messageの30日retention、ACK retry horizon等を満たしてから、参照・ACK・auditと同じtransactionで回収する。削除依頼がGCだけで消え、未削除bytesの所有情報を失う状態を作らない。

## leaseと認可境界

hostはmaintenance専用の同期認可と、lease・最大attempt・backoffの有限policyを明示する。callerのagent名を認証に使わず、個体のsubmit／poll権限を保守権限に読み替えない。未接続・例外・非同期decisionは拒否し、書込み前後にも現在権限を確認する。

claimは原子的に1jobだけをleaseし、tokenはhashのみ保存する。reopen後もleaseを尊重し、期限後の再claimでは世代とtokenを更新する。古いworkerのproof・完了・失敗報告は新しいleaseへ書けない。失敗は固定codeだけを保存し、有限backoff後に再試行する。最大attemptでparkし、自動復活は行わない。

`withAttachmentDeletion`は固定したRelay DBから元messageのacked／expired状態、receipt identity、参照、job payloadとleaseを照合してから、callback中だけ有効なterminal証明を渡す。証明は持ち出せず、期限到来や失効後に再利用できない。upload backendは同じproofのguard下で所有者・元message・宛先・期限・順序付きbindingと元receipt identityを照合し、全添付bytesの削除を1transactionでcommitする。別messageの添付への差替えは拒否する。

## 単発workerと別DB間の復旧

`AttachmentDeletionWorker.workOnce(context)`は明示呼出しで最大1jobを扱う。`idle`、`done`、`deferred`と最小job IDだけを返し、loop・timer・agent実行・network通信を起動しない。削除失敗ではbytesをrollbackして有限backoffへ移る。parkを含む`deferred`は自動回復を約束せず、hostが状態を照合する必要がある。

blob commit後に応答やRelay側の完了が失われても、同じ元jobから再試行できる。閉じたuploadや既に回収されたmetadataを再作成せず、所有するterminal行の残存chunkだけを回収する。blob削除後の認可失効やlease切れでは`attachment_deletion_uncertain`とし、現在の権限と新しいleaseで照合する。完了commitの応答だけが失われた場合は同じ世代／tokenで照合でき、done jobを新規作成しない。

upload schema 2の状態列は維持する。ACK後の物理削除は既存の`cancelled`閉鎖状態、期限後は`expired`を使用する。これは送信者によるcancel操作の証明ではなく、配送上の理由はRelay receipt／削除outboxの`acked`／`expired`を正本とする。受信者のverifiedなlocal bytesはserver削除では消さず、durable引渡しとACK照合後の明示releaseまで保持する。

## 明示migration

schema 1／2／3から4への移行は専用DBに対する明示操作である。旧schemaに残る添付本文から参照を復元する場合は、hostが元の有限`ContractLimits`を渡す。本文と元fingerprintの照合に失敗すれば全体をrollbackする。第4引数を組み立てたstoreはそのlimitsを使える。

旧schemaで既に消去されたterminal本文から添付IDを推測しない。その既存blobはupload側の元期限による有限maintenanceで回収し、整合backup／restoreや運用照合は別途実証する。Relay DBはforeign keysに加え、synchronous FULLとsecure_deleteを明示する。

## 検証範囲

outboxの18件はatomic enqueue、rollback、lease競合、reopenとfencing、証明の持出し・失効、完了の冪等、backoff／park、認可、期限到来、破損、明示migration、GC保護を確認する。期限・長期保持には専用DBのhistorical fixtureも使う。

配送・workerの20件は登録済み模擬HAB個体のupload → prepare／commit／confirm → 実Relay lease → chunk保存・SHA検証 → local inbox／ACK journal → 実server ACK → 物理削除をin-processで確認する。ACK enqueue／audit失敗、ACK応答消失と両側reopen、削除途中の全体rollback、blob commit後の応答消失、完了commit後の応答消失、保守権限失効、古いlease、元期限、複数添付、binding差替え、停止・block、破損も対象とする。この組立てのleaseは実storeが発行し、HTTP/MCPの転送や実製品の接続は試していない。backup restore・電源断耐久性・本番3者接続の完了を意味しない。
