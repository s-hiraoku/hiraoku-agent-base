# Task bridge：明示引受けと永続Task link

[README](../README.md) · [正式仕様](hab-relay-spec.md) · [Relay](../src/relay/README.md)

`src/task-bridge/` はRelay coreの外に置いた任意のintegrationです。配送受領、受信側の引受け、Task Engine受付、実行、terminal証拠を分離します。既定runtime・MCP catalog・HABの許可kindへ自動登録せず、worker・model・Hermesを起動しません。

## 最初の実行契約

対象は既存の `connectivity_check` だけです。要求messageは `kind: execution_request`、bodyは以下の1 partだけを持ちます。

```json
{"parts":[{"type":"data","schema_id":"task.execution_request","schema_version":1,"value":{"task_type":"connectivity_check"}}]}
```

その他のenvelopeは通常のRelay version 1です。free text、添付、prompt／shell／path／URL、任意request key・owner、inventoryや他のTask、未知schemaをこのbridgeへ渡せません。受信側の業務判断をbridgeへ移しません。

`TaskBridge.accept(context, {sender_id, message_id})` は、現在のローカル引受け権限と、固定した受信inboxの `withEntry` からsourceを確認します。引数に本文や権限を貼り付けません。SQLiteInboxのhandoffは保存済み本文のHMAC・宛先・IDをwrite guard内で照合し、未releaseのcopyだけを同期callbackへ渡します。このbridgeはACK確認済みのentryに限定します。**受信やACKだけではTaskを作りません。**

## 認可とbinding

hostは `accept / submit / observe` ごとの同期 `BridgeAuthorization` を明示します。未接続・Promise・例外・別受信個体・途中失効は拒否し、commit前にも再確認します。引受けのactorは鍵付き指紋だけを保存します。

`ConnectivityTaskPort` は別途検証済みのTask Principal providerと、固定したTaskServiceを使います。sourceのsender、HAB名、本文からPrincipalを作りません。毎回subject・client・hermes宛先・操作・Task allowlistを照合し、既存のTask Engine停止／epoch／所有者認可も通します。

journalは受信個体、host指定のengine namespace、Task owner／client、HMAC keyにbindingします。再起動で別のownerやengineへ差し替えません。engine namespaceはhostが実接続先と対応させる設定であり、ラベルだけでDB同一性を証明するものではありません。接続portは構築時にmethodを捕捉します。

## 永続状態と1回の操作

| journal状態 | 意味と次の操作 |
| --- | --- |
| `prepared` | 明示引受けと安定keyを保存済み。Task未確認 |
| `submitting` | Task受付を1 RPC試行中。fenceと有限leaseを保持 |
| `uncertain` | 応答・確認commit等が不明。元keyの明示再照合だけを許可 |
| `linked` | owner・type・元keyを検証したTask IDを保存済み |
| `waiting_approval` | 有限試行上限。自動再試行・key変更・別依頼の受付試行を止める |

sourceごとの一意key `(sender_id,message_id)` と、Task owner scope用の `br_<128-bit random>` keyをTask呼出しより先にcommitします。同じ引受けの再送・満杯・再起動でもkeyを作り直しません。Task Engineの既存owner／request keyの原子的重複防止を使います。

`submitOnce(context, source)` は1回だけTask submitを行います。応答消失・DB確認失敗・途中失効は未実行の証明ではなく、元keyを保持した不明状態になります。`submitOnce(context, source, true)` が明示再照合で、同じowner・key・固定Task typeだけを再提出します。crashでsubmittingのままならleaseを越えた後に同じ操作で照合します。期限前の別connectionはbusyとなり、古いfence／期限後の応答はlinkを確定できません。

未解決の1件がある間、他messageのTask submitを始めません。各instanceも未完了Promiseを並列化しません。lease後に別processが照合する場合、古いRPCの停止は保証できないため、同じkeyのTask Engine重複防止が必須です。bridge自身はTaskをclaim／heartbeat／completeしません。実行の同時数1・run照合・lease不明時のgateは既存Task Engine／Adapterが担当します。

`observeOnce` は保存済みTask IDへのgetを1回行うだけです。別Task ID、owner／key／type不一致、古いfence、terminal証拠の巻戻しを拒否します。succeeded／failedのresultも既存の固定契約を検証します。cancelledでも `execution_open=1` なら完了ではなく、次の実行gateを解放しません。

元messageの1時間は配送期限です。このbridgeはTaskの業務期限として流用せず、古いinboxの明示引受けにも現在の権限を必要とします。Taskのdeadline・中断・cancelは別契約です。bridge保存後のinbox本文releaseは可能ですが、未保存のsourceを先に捨てません。

## 保存と障害

新規の専用private SQLite schema1を明示migrateします。Relay／Task表は変更しません。link全体と索引列の整合をHMACで確認し、状態とredacted auditを同じtransactionでcommitします。本文は保存せず、source比較指紋・ID・時刻・Task参照と検証済み固定結果だけを持ちます。DBは0600、symlink・不明schema・binding/key不一致・欠落したschema objectは拒否します。

link／audit件数と試行回数はhostの有限設定です。満杯では既存記録を追い出しません。この段階で安全なGC・承認待ち解除・key再発行のAPIは提供していません。Task dedupとsource再引受けを壊さないretentionは後続の運用境界です。transaction全体のrollbackで状態が不明ならstoreを使用停止し、明示migration・照合まで再使用しません。

既存snapshot profileはこのbridge DB／Task DBを含みません。独立DBのrestoreやrollback後の自動再開は実装しておらず、同一engine・key・Task・inboxの静止と照合が必要です。

## 検証と次の段階

`node --test test/task-bridge.test.js` の30シナリオで、実SQLite Relay・inbox・TaskServiceを使い、ACKと引受けの分離、厳格schema、認可、応答消失・reopen・同key再照合、有限試行・lease／fencing・native競合、Task停止、cancel gate、terminal証拠、audit rollback・改ざん・private fileを確認します。実agentやmodelを呼びません。

既存MCP経路は `verify-hab` でも別途確認しました。resolve-okは `003-a-relay_resolve.res`、send-ok／send-replayは `004/005-a-relay_submit.res`、recv-poll／recv-emptyは `006/007-b-relay_poll.res`、recv-ack-refusedは `008-c-relay_ack.res`、recv-ack／recv-ack-replayは `009/010-b-relay_ack.res` が証拠です。独立したsender statusは `011-a-relay_status.res`、DB auditは `012-inspect-after-ack.json` で照合し、専用processをcleanupしました。raw evidenceはローカル一時領域だけに保持し、公開repoへ入れません。Macでhelperを動かすためのwc空白・Bash空配列の互換修正も含みます。

**execution_accepted／execution_resultを通常の送信outboxへ保存・再送する部分、返信budget、実製品からの引受け操作、本番binding／credential、restore運用は未完了です。** この段階はローカルの明示引受けとTask link／照合の基盤であり、3者本番接続や返信配送の完了ではありません。
