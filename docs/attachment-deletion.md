# 添付削除outboxとterminal証明

[管理添付](managed-attachments.md) · [受信保存](attachment-inbox.md)

Relay schema 4は、元messageに固定した順序付き添付IDと、terminal時の削除outboxを同じDBへ保存する。新規の[host-only契約](../src/relay/attachment-deletion.ts)は資格情報・scheduler・公開toolを持たない。この段階では物理削除workerと添付配送の有効化は後続で、通常poll／ACKの添付拒否を維持する。

## terminal確定と回収

受付時に、sender／message／recipient／receipt identity／元期限へ固定した参照fingerprintを本文・配送・auditと同じtransactionで保存する。本文とは別のfull copyやfilename、digest、bytesは保存せず、添付IDだけを保持する。元messageの期限回収では、本文消去・配送terminal化・audit・削除依頼を同じtransactionでcommitする。enqueue失敗は全体をrollbackする。ACKのterminal処理にも同じenqueue境界を置き、配送有効化後に利用する。

削除payloadは元receipt、順序付き添付ID、acked／expiredの理由とterminal時刻だけを持つ。messageごとに1件で、元IDの再試行はjobを増やさない。payloadと参照は鍵付きfingerprintと更新禁止triggerで保護する。完了・未完了を問わず、本文・token・任意エラー文字列をoutboxへ残さない。

pending／leased／parkedな削除依頼が残る間はmessage GCを止める。doneとなった依頼は元messageの30日retention、ACK retry horizon等を満たしてから、参照・ACK・auditと同じtransactionで回収する。削除依頼がGCだけで消え、未削除bytesの所有情報を失う状態を作らない。

## leaseとfencing

hostはmaintenance専用の同期認可と、lease・最大attempt・backoffの有限policyを明示する。callerのagent名を認証に使わず、個体のsubmit／poll権限を保守権限に読み替えない。未接続・例外・非同期decisionは拒否し、書込み前後にも現在権限を確認する。

claimは原子的に1jobだけをleaseし、tokenはhashのみ保存する。reopen後もleaseを尊重し、期限後の再claimでは世代とtokenを更新する。古いworkerのproof・完了・失敗報告は新しいleaseへ書けない。失敗は固定codeだけを保存し、有限backoff後に再試行する。最大attemptでparkし、自動復活や自動常駐は行わない。

\x60withAttachmentDeletion\x60は固定したRelay DBから元messageのacked／expired状態、receipt identity、参照、job payloadとleaseを照合してから、callback中だけ有効なterminal証明を渡す。証明は持ち出せず、期限到来や失効後に再利用できない。物理削除backendはこのproofを前後で確認し、元binding以外へ転送しない必要がある。完了の応答消失は同じ世代／tokenで再照合でき、古い世代ではdoneを書けない。

claim／proof／complete／failはlocal host portであり、通常のMCP catalogへ追加しない。parkedや不明な結果は保守者が照合し、lease tokenや個人データをログへ出さない。

## 明示migrationと検証の限界

schema 1／2の既存text receiptを保持し、schema 3から4へtransactionalに移行する。旧schema 3にliveな添付本文がある場合は\x60migrate(ContractLimits)\x60を明示し、元fingerprintを確認して参照を再構成する。限界値の未指定・本文破損・鍵不一致では移行しない。元本文が既に消えた旧terminal行から添付IDを推測せず、legacy uploadの期限回収は既存blob側maintenance／運用照合が担う。既存runtime DBを暗黙に開いたり、migrationを自動実行したりしない。

新規18件はatomic enqueue、rollback、lease競合、reopenとfencing、証明の持出し・失効、完了の冪等、backoff／park、認可、期限到来、破損、明示migration、GC保護を確認する。期限・長期保持は専用DBのhistorical fixtureで模擬する。物理削除・backup restore・本番接続の完了を意味しない。
