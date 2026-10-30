# 有限Adapter host：受信・返信・停止・照合

[README](../README.md) · [返信budget](adapter-reply-budget.md) · [質問返信intent](answer-intents.md) · [Task bridge](task-bridge.md)

`src/adapter-host/` は既存のdurable inbox／outbox、返信budget、任意のTask bridgeを組み立てるローカルAPIです。1命令ずつ明示的に動かし、scheduler、常駐loop、model、Task worker、listenerを起動しません。既定runtime・MCP catalog・実製品へは未配線です。

明示構成したhostの受信だけを反復する場合は、任意の[共通受信supervisor](receive-supervisor.md)を使えます。
これは自動resume・認証設定・常駐登録・モデル起動を行わず、既存の保存後ACKとownerを維持します。

## 操作と責務

| stepOnceのop | 動作・1命令の上限 |
| --- | --- |
| message_enqueue | 新規question／notice／execution_requestを自分のdurable outboxへ1件保存。HTTPやTask操作はしない |
| receive | 既存ACKの照合→poll→保存後ACK。最大3 MCP RPC |
| send | 既存outboxのsubmitまたはstatusを最大1 RPC |
| inbox | 自分の未release inboxのID・kind・ACK確認有無を診断表示。本文を返さず、実行の証明には使わない |
| answer | intent未設定の従来入口。確認済みsourceと確定済みenvelopeを共通budget経由でoutboxへ保存 |
| answer_prepare／answer_enqueue | 任意の質問返信journalへ先に保存／同ID・本文・期限でoutboxへ引渡し |
| answer_inspect／answer_pending／answer_maintain | 任意journalの照合／有限ページ一覧／期限処理・30日GC |
| task_accept | ACK確認済みの固定execution_requestを明示引受け。Task submitはしない |
| task_submit | 元keyで固定Taskを最大1 RPC受付。reconcile:trueは同keyの明示照合 |
| task_observe | 保存済みTask IDへgetを最大1 RPC |
| task_reply_prepare | 既存journalへ受付／結果の固定返信を保存 |
| task_reply_enqueue | 保存済みTask返信を共通budget経由でoutboxへ引渡し |

新規メッセージは `message_enqueue` へ既存Relay version 1のenvelopeを渡します。独立した同名操作の認可、現在のpause／epochと任意ownerを確認し、outbox commit内でも再確認します。senderや接続先URLは命令から指定できません。ID・本文・期限はcallerが確定したものを保存し、同じ内容の再投入は元のreceiptへ照合します。内容を変えた同IDは上書きしません。完了応答が失われても新ID・新期限は生成せず、元のenvelopeで照合します。結果は本文を含まないoutbox metadataで、queuedは配達成功を意味しません。実送信には別のsend命令が必要です。

`in_reply_to` を持つenvelopeやanswer／execution_accepted／execution_resultはこの入口で拒否します。返信は元sourceに固定された既存answer／Task返信intentと共通budgetを通します。execution_requestもこの段階では配送するデータに留まり、Task引受け・submitは受信側の別操作です。既定の添付拒否、outboxの容量・期限・重複制御は変えません。この追加はローカルhost APIだけで、MCP catalog・製品設定・常駐loopを自動変更しません。実接続の構成側はmessage_enqueueの権限を明示してください。

受信・ACK・一覧取得からTaskを作りません。Taskのclaim／heartbeat／complete／cancelやHermes実行は提供しません。Task Engineへの接続には、別途検証済みPrincipalを使う既存BridgeTasks portが必要です。hostの認可やHAB名からTask Principalを作りません。

step結果のdoneはその命令の完了です。配送ACK・業務成功とは別で、Task queuedやRelay pendingをTask成功と解釈しません。途中の失効・停止・不明な通信・quota上限ではincompleteと固定reasonを返します。初期の権限不足・paused・busy・不正命令は副作用前に拒否します。未知の例外本文を返却・通知へコピーしません。

## 構成と認可

hostは同じ個体にbindingしたcontrol、SQLiteInbox、SQLiteOutbox、SQLiteReplyBudget、limits、固定clientのpure factoryを明示します。Taskを使う場合は同じ受信個体のjournalと既存Task portも渡します。違う個体の構成を拒否します。

`HostAuthorization(context, operation, source|null)` は同期のhost portで、検証済みcontextから個体・actor・操作・source scopeを確認します。既定拒否、Promise拒否、別個体拒否、actor変更・失効拒否を適用します。命令にagent名・credential・送信先URL・scopeを指定する欄はありません。Taskのaccept／submit／observe／replyは別のhost操作へ対応させます。

network clientはreceive／send命令の中で構築し、その命令専用のguarded fetchを使います。factoryはIOを始めず、固定resource・固定個体・現在の認証providerを持つRelayMcpClient等を組み立てるだけです。実認証の検証・tokenの取得は既存client／接続portの責務です。この実装はcredentialの発行・読取り・コピーや接続先の自動探索を行いません。

質問返信producerは[独立した永続intent](answer-intents.md)を任意指定できます。設定時は新しいanswer_*操作を使い、従来answerを拒否します。未設定の場合、回答envelopeのproducerは呼出し側の責務です。answer命令の呼出し側はID・本文・first_sent_at・expires_atを初回より前に確定・保持し、再起動後も同じenvelopeを渡します。budgetだけから失った回答本文を復元できるとは扱いません。Task返信は既存Task journalがその永続化を担当します。

## 永続停止と世代

専用private SQLiteHostControl schema1を明示migrateします。**新規DBはpaused=true／epoch=0**です。既存DBを開き直した場合は保存済み状態を維持します。認可未接続でも自動でresumeしません。

statusとsetPausedはそれぞれ現在の権限を必要とします。setPausedにはexpectedEpochを指定し、古い世代からの変更を拒否します。状態が変わるたびにepochを進め、同じ状態・同じ世代への再確認はauditを増やしません。

各命令は開始時のepochとactorを保持します。同期保存はcontrol → inbox／budget／outbox／Task journalの順の短いguard内で動かし、network awaitの間はDB lockを保持しません。実fetchの開始、各RPCの前後、各保存／確認で現在の認可と世代を確認します。停止後すぐresumeしても、古い命令は新しい世代を借りられません。終了済み命令のfetch callbackも拒否します。

**pauseは遠隔の取消しではありません。** 既に開始したRPCは相手側でcommitする可能性があります。停止中に返ったpollを新規保存・ACKせず、ACK応答が消えたら元ACK requestを残し、submit応答が消えたらoutboxの元ID・leaseを残します。Task受付の不明結果は元Task keyとsubmitting／uncertainを保持します。resume後に既存lease・backoff・有限再試行の契約で照合し、新Task・新返信IDで迂回しません。

## 未完了通信の扱い

1 host instanceでは同時に1命令だけを受け付けます。MCP clientがcaller向けtimeoutを返しても、credential／fetch／body等の裏のworkが残る場合はactiveRequestsを確認し、settleまで新命令を拒否します。control操作とstatusは引き続き使用できます。fetchを始めた後にguardが失敗してSDKから取り残された通信も追跡し、取得したResponseを回収するまで枠を保持します。

client／network providerは実際の未完了数を報告し、AbortSignalと有限timeoutを守る必要があります。未知・壊れたactive数はidleと扱いません。強制的なslot解除や自動client再生成で未完了workを隠しません。Task portもPromiseを早期成功させて裏の仕事を放置しない契約が必要です。

running／drainingはinstance内の状態です。任意の[単一owner管理](adapter-owner.md)を追加し、専用SQLiteのprocess-lifetime lockを取得した一つのhostへattachできます。未設定の互換モードでは複数hostを防ぎません。複数connectionのcontrol変更はSQLiteのCASで競合を防ぎ、既存outbox・ACK・Taskのlease／fencing・実行並列1も維持しますが、host全体の分散single-flightを実装したとは扱いません。

## 保存と運用

control DBは0600、symlink・異なる個体／key／policy・不明schema・欠落したaudit triggerを拒否します。状態とappend-only auditにHMACを付け、epoch・件数・索引列の整合を確認します。auditには時刻・世代・pausedとactorの鍵付き指紋だけを保存し、本文・認証値は保存しません。

audit上限はhostの明示設定です。resumeで最後の1枠を消費できないようにし、activeのhostをpauseする記録枠を残します。満杯で既存auditを追い出さず、pausedのまま再開を止めます。上限変更・GC・resetのAPIは未提供です。

pauseの永続化に失敗したら成功とは返さず、そのcontrol instanceを使用停止します。明示migrate・照合まで再使用しません。失敗したpauseが他processにも永続化されたと推測してはいけません。

control・inbox・outbox・budget・任意の質問返信journal・Task journal／Task DBのcommitは単一transactionではありません。途中失敗でも既存のdurable証拠を保ちます。新controlは既存snapshot profileへ自動追加せず、DB単独restoreからの自動再開も行いません。古いsnapshot全体への巻戻しはHMACだけでは検出できないため、全host・未完了通信・Task実行を静止し、整合する世代と元IDを照合する復旧手順が必要です。

## ローカル再現

Node 24以上で次を実行します。fixtureは一時DB・模擬認証だけを使い、native HTTP試験のlistenerも127.0.0.1の動的portに限定して終了時に停止します。

```sh
npm ci
node --test test/adapter-host.test.js
node --test --test-name-pattern="real loopback HTTP MCP" test/adapter-host.test.js
```

30シナリオで、受信→明示回答→送信／ACK、固定Taskの引受け・受付・結果返信、停止・再起動・世代変更、RPC中の失効、遅いcredential／fetch、timeout後の枠保持、ACK／送信応答消失、同key Task照合、終了後callback拒否、取り残された通信、制御audit容量・失敗・改ざん、native control競合を確認します。固定Taskはモデルなしの模擬workerで検証し、実エージェントを呼びません。

既存HAB MCPは `verify-hab` でも別途回帰確認しました。recv-ackは `009-b-relay_ack.res`、send-statusは `011-a-relay_status.res`、独立DB auditは `012-inspect-after-ack.json` が証拠です。専用processはcleanup済みで、raw evidenceは一時領域のみです。この確認は既存Relayの回帰試験であり、新hostを既定MCPや実製品へ配線した証明ではありません。

実製品の接続・常駐起動、認証binding、全入口へのowner適用、整合restore・運用監視・本番E2Eは未完了です。
