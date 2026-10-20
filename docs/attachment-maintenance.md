# サーバー添付の有限保守cycle

`AttachmentMaintenanceCycle` はhost専用の任意構成です。固定したRelay DBとupload DBへ、次の順で1回ずつ進みます。

1. Relayの期限切れ・metadata GCを指定batch（1–1000）で実行。期限切れ本文の消去と添付削除outbox登録は既存の同一transaction。
2. 削除workerが最大1jobをclaimし、terminal証明とfence／leaseを照合して別DBのbytes削除を実行。
3. upload側の期限回収・metadata GCを指定batch（1–100）で実行。未受付の孤立uploadも元期限で閉じる。

upload storeの既存binding GCには別の同サイズbatchもあるため、`upload_limit` は全SQL行数の上限ではありません。全工程にloop・再試行timer・network・model実行はありません。hostが `workOnce(verifiedContext)` を明示的に呼びます。既定runtime、MCP catalog、cronは変更しません。

## 権限と部分失敗

保守専用の同期認可が必要です。未設定・例外・Promise・入力のagent名だけでは最初のstoreすら呼びません。全cycleで同じ検証済み主体を要求し、各段階の前後と内部guardで現在権限を再確認します。Relayのmaintenanceもcommit直前に再確認し、非同期認可や途中失効をrollbackします。保守callbackはcycle終了後に無効です。

各DBは独立にcommitします。`done` は今回の3段階が終了したことを表し、保守待ち全件の解消ではありません。`partial` は `completed_stages`、`failed_stage`、固定reasonと、確認できた集計だけを返します。本文・filename・token・任意エラー文字列は返しません。commit応答消失では失敗段階も既にcommit済みの可能性があり、全体rollbackを推測しません。同じ元record／outboxから照合します。

削除がdeferredになったcycleはその段階で止めます。既存の有限backoff／最大attempt・parkを維持し、次の呼出しで元jobを照合します。権限失効からの自動復帰、park解除、sourceや受信済みverified bytesの自動解放は行いません。sender／receiverのlocal journal保守は別のhost境界です。

## 再現

`node --test test/relay-attachment-maintenance.test.js` の16シナリオで、実SQLite上のACK削除、期限切れaccepted／孤立uploadの回収、live bytes保持、1job上限、認可の失効・すり替え・Promise、部分commit、escaped callback、再入、上限を確認します。

整合backup／restore、電源断、本番の保守主体・実行契機・監視は別途確認が必要です。
