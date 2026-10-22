# Task bridge：明示引受け・Task link・永続返信

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

hostは `accept / submit / observe / reply` ごとの同期 `BridgeAuthorization` を明示します。未接続・Promise・例外・別受信個体・途中失効は拒否し、commit前にも再確認します。引受けのactorは鍵付き指紋だけを保存します。

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

## 受付・結果返信のoutbox連携

任意のローカルAPI `TaskReplies(journal, outbox, authorize)` を追加しました。既定MCP・runtimeには未配線です。hostは同じ受信個体にbindingした `BridgeReplyOutbox` を渡し、`reply` 操作を現在の権限で認可します。outboxの個体IDは構成の整合確認であり、ネットワーク上の認証の代わりではありません。

`prepare(context, source, kind)` は返信を先に永続化し、`enqueueOnce(context, source, kind)` はその保存済み返信を通常のSQLiteOutboxへ同期で1回引き渡します。Task submit／getやHTTP送信は行いません。実配送は既存のDurableSenderとRelayの現在の認可・再送契約を使います。

| kind | 生成に必要な証拠 | data partのschema／value |
| --- | --- | --- |
| `execution_accepted` | 検証済みTask IDを保存したlinked状態 | `task.execution_accepted` version 1：`{task_type:"connectivity_check",task_id}` |
| `execution_result` | 保存済みTask証拠がsucceeded／failed／cancelledかつexecution_open=0 | `task.execution_result` version 1：`{task_type:"connectivity_check",task_id,state,result}` |

受付返信はTask Engineの受付を表します。ACK・ローカル引受け・不明なsubmit結果だけでは生成できません。結果返信はobserve済みの証拠だけを使い、queued／running／waiting_approvalやcancelled-openから生成できません。succeeded／failedのresultは既存の固定値、cancelledのresultはnullです。Task owner・client・submit keyはwire本文へ出しません。

返信先は元sender、threadとin_reply_toは元sourceから固定します。本文、宛先、Task IDを呼出し引数で差し替えません。sourceごとに各kindを1件だけ保持し、ID・本文・first_sent_at・expires_atを再試行や再起動で作り直しません。各返信は準備時から1時間で、元messageの配送期限とは別です。結果の準備時刻が遅くても、同じ元messageへの参照は必要です。Relay側で元の参照記録が保守削除されていたら配送は拒否され、新threadや新Taskで迂回しません。

| 返信journal状態 | 意味 |
| --- | --- |
| `prepared` | 一意の返信を保存済み。outbox引渡しは未確認または不明 |
| `enqueued` | 対応するoutbox記録を確認済み。配送・ACK・Task成功とは別 |
| `expired` | 未確認のまま配送期限に到達。新ID・新期限を発行しない |

異なるDBのため、outbox commitとjournal確認を原子的とは扱いません。journalの同期write lock中にoutboxを先にcommitし、その後journalを更新します。応答消失・journal更新失敗はpreparedを残し、同じ本文・IDでoutboxへ再照合します。outboxが本文を消去した後も既存の比較指紋を使えます。nativeの別connection同士もjournalのwrite lockで直列化します。hostはjournal→outboxのlock順を守り、逆順callbackやネットワークIOを入れません。

認可は準備commit、outbox commit、journal確認commitで再確認します。outbox commit後の失効や障害は、既に永続化された送信意図を取り消しません。journal側は未確認として保持し、その後の明示操作を拒否します。配送時の停止・失効はSender側の接続とRelay側でも適用する必要があります。受入れ後のquarantine等はoutbox側で調べ、enqueuedを配達完了と解釈しません。

期限到達時には再enqueueせずexpiredを保存します。既にoutboxへ入ったか不明な場合、その記録の照合・期限処理は通常のoutboxが担当します。journalでenqueuedになった返信は、outboxのGCや単独restoreで記録が消えていても自動再作成しません。独立DBの復元は別途静止・照合が必要です。

1 source当たり2つの固定返信枠と有限audit容量を持ち、容量を確保できなければ新しいoutbox書込みを行いません。返信を受けただけで新Taskを作る処理はありません。[独立した永続返信budget](adapter-reply-budget.md)をTaskRepliesの第4引数へ明示配線すると、answerと共通のthread枠・個体rate・保持件数も予約します。上限では元Taskを再実行せず、preparedの返信を保持します。実製品の実行契機・監視は後続です。配送順序は保証せず、受信側はkindとsource参照で結果を解釈します。

## 保存と障害

専用private SQLite schema2を明示migrateします。schema1からは既存link・安定key・auditを維持して返信表を追加します。Relay／Task表は変更しません。link全体と索引列の整合をHMACで確認し、状態とredacted auditを同じtransactionでcommitします。受信本文は保存せず、source比較指紋・ID・時刻・Task参照と検証済み固定結果を持ちます。返信は固定data partを含むenvelope全体をHMAC付きで保存し、索引列・source・Task証拠を照合します。DBは0600、symlink・不明schema・binding/key不一致・欠落したschema objectは拒否します。

link／audit件数と試行回数はhostの有限設定です。満杯では既存記録を追い出しません。この段階で安全なGC・承認待ち解除・key再発行のAPIは提供していません。Task dedupとsource再引受けを壊さないretentionは後続の運用境界です。transaction全体のrollbackで状態が不明ならstoreを使用停止し、明示migration・照合まで再使用しません。

既存snapshot profileはこのbridge DB／Task DBを含みません。独立DBのrestoreやrollback後の自動再開は実装しておらず、同一engine・key・Task・inboxの静止と照合が必要です。

## 検証と次の段階

`node --test test/task-bridge.test.js` の30シナリオで、実SQLite Relay・inbox・TaskServiceを使い、ACKと引受けの分離、厳格schema、認可、応答消失・reopen・同key再照合、有限試行・lease／fencing・native競合、Task停止、cancel gate、terminal証拠、audit rollback・改ざん・private fileを確認します。実agentやmodelを呼びません。

既存MCP経路は `verify-hab` でも別途確認しました。auth-missing／auth-unknownは `001-none-tools_list.res`／`002-BAD-tools_list.res`、resolve-okは `003-a-relay_resolve.res`、send-ok／send-replayは `004-a-relay_submit.res`／`005-a-relay_submit.res`、recv-poll／recv-emptyは `006-b-relay_poll.res`／`007-b-relay_poll.res`、recv-ack-refusedは `008-c-relay_ack.res`、recv-ack／recv-ack-replayは `009-b-relay_ack.res`／`010-b-relay_ack.res` が証拠です。send-statusは `011-a-relay_status.res`、その独立したDB auditは `012-inspect-after-ack.json` で照合し、専用processをcleanupしました。raw evidenceはローカル一時領域だけに保持し、公開repoへ入れません。このMCP確認は既存Relayの回帰試験で、未配線のTask返信APIの操作証明ではありません。

`node --test test/task-bridge-replies.test.js` の32シナリオで、固定返信schema、未完了の拒否、Task証拠の明示観測、別権限・別outbox拒否、応答消失・再起動・二重commitの間の障害、outbox本文消去後の再照合、容量、期限、native writer競合、模擬Relayの実配送・ACKを検証します。配送応答が消えても同じ返信IDを再送し、元Taskは1件のままです。時計とDBの障害注入はunit試験に限定し、MCPのユーザー経路の証拠と混同しません。

**実Adapterの全入口へのbudget適用、実製品からの引受け操作、本番binding／credential、restore運用は未完了です。** Task bridgeと返信はローカルの任意APIとして模擬検証した段階です。3者本番接続や既定MCPからのTask返信操作を完了したものではありません。
