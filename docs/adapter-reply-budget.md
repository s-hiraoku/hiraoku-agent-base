# Adapterの永続返信budgetとloop制御

[README](../README.md) · [正式仕様](hab-relay-spec.md) · [Task bridge](task-bridge.md)

`src/adapter-policy/` は受信側integrationの独立部品です。Relay coreやHAB registryへ内容判断を追加せず、model・Task・HTTP呼出しや常駐loopを起動しません。既定MCP・runtimeへは未配線です。

## 許可する関係

| 保存済みsourceのkind | 自動返信kind | 原要求ごとの枠 |
| --- | --- | --- |
| question | answer | 1件 |
| execution_request | execution_accepted | 1件 |
| execution_request | execution_result | 1件 |

answer、delivery_failure、notice、受付・結果通知からは自動返信しません。拒否はローカルの固定errorで返し、不達通知への不達通知や新たな実行依頼を生成しません。受信やACKだけでも返信を作りません。Taskの実行可否・完了証拠はTask bridgeの責務のままです。

`InboxAnswers.enqueueOnce(context, sourceKey, message)` は、現在のhost認可と確認済みSQLiteInboxのsourceを照合してanswerを通常outboxへ保存します。sourceのsender・ID・宛先・kind・threadはdurable inboxから取り、本文から認証主体を作りません。未確認・未保存・本文解放済みの新規sourceは拒否します。既に予約した完全一致の返信は、保存済みsource metadataを使って本文解放後も照合できます。

hostの認可providerは、検証済みcontextとsource scopeから受信個体・actorを返す同期portです。既定拒否、別個体拒否、Promise拒否、actor変更・途中失効拒否を適用し、予約commitとoutbox commitの前に確認します。個体名・IDを知っているだけでは許可しません。hostは受付済みoutboxの送信時にも現在の接続権限・Relayの認可を適用します。

## 枠の単位と消費点

`SQLiteReplyBudget` は1受信個体につき1つの専用DBを使います。同じ個体のanswer・Task受付・Task結果を同じinstance／DBへ接続します。

- source単位：`(sender_id,message_id,reply_kind)` ごとに1つの固定返信ID・比較指紋だけを許可。
- thread単位：その受信個体が発信する自動返信の累積件数を制限。相手と共有する両方向合計カウンターではありません。
- 個体全体：全threadにまたがる直近windowの新しい予約件数を制限。新thread・新sourceでも回避できません。
- DB全体：保持recordに有限上限を設け、満杯で記録を追い出しません。完全一致の再試行は満杯でも照合できます。

数値はhostの必須設定です。仕様の「thread 8件」「個体60件/分」は未合意の候補のままで、暗黙の既定値にはしません。実装はtoken bucketではなく予約時刻によるsliding windowです。hard ceilingはmax_records 10,000、max_thread_replies 1,000、max_per_window 10,000、window_ms 1日です。clock skew上限も明示し、最大60秒です。

新しい予約をwrite transactionでcommitしてからoutboxへ渡します。送信前の障害、応答消失、quarantine、取消などでも枠を返却しません。枠を戻すと、送信済みか不明な状態で別返信を増やせるためです。同じID・同じ内容だけを再照合し、別ID・本文変更・宛先変更はconflictになります。再試行は予約時刻・thread件数・rate消費を更新せず、outboxの通常の再送上限・期限を使います。

これは**新しい自動返信意図の受付rate**です。既に予約済みのbacklogやネットワーク再送の実送信rate・HTTP受付上限は、Sender／Relay／writer admissionでも別途制限します。複数DBを作って同じ個体の枠を分散する構成は許可しません。複数processは同じDBを共有し、原子的に枠を予約します。

上限ではreply_thread_exhausted、reply_rate_exhausted、reply_budget_capacity_exceeded等を返して処理を止めます。別threadの自動生成・枠の自動リセット・新Task作成で迂回しません。rateはwindow経過後に回復しますが、元要求とthreadの消費は残ります。

## Task返信との組立て

`TaskReplies(journal, outbox, authorizeTaskReply, budget)` の第4引数に同じbudgetを渡します。保存済みTask返信をjournalが検証した後だけ、元execution_requestに対する枠を予約します。別個体budgetを拒否し、port methodを構築時に捕捉します。

Task journal → budget予約commit → outbox commit → Task journal確認の順です。budgetのtransaction中はoutboxを呼ばず、network IOを行いません。outbox受付後のjournal確認が失敗しても、元Task・元返信ID・予約を維持して再照合します。budget上限で結果返信が止まっても、Taskそのものの完了状態を変更・再実行しません。

既存のTaskRepliesの明示ローカル操作はbudget省略の互換性を維持します。**自動処理するhostはbudgetを明示配線する必要があります。** 省略した構成でthread／個体全体の自動返信制限が有効だと主張しません。

InboxAnswersは返信envelopeを生成・保存するproducerの代わりではありません。呼出し側は初回より前に安定したID・本文・first_sent_at・expires_atを確定して保持します。budgetは本文を保存しないため、再起動後の再照合にも同じenvelopeが必要です。Task返信は既存のTask bridge journalがその役割を担当します。

## 保存・障害・運用

専用private SQLite schema1を明示migrateします。受信個体・有限policy・HMAC keyをbindingし、再起動時に別個体・別key・別policyへ差し替えません。policy変更やresetのAPIは未提供です。DBは0600、symlink・不明schema・欠落したimmutable triggerを拒否します。

予約はappend-onlyで、source／reply ID・kind・thread・予約時刻と鍵付き内容比較指紋を保持します。質問・回答・添付bytes・認証値は保存しません。行と索引列の整合性に加え、件数と時計のhigh-water markもHMACで確認し、行削除・改ざんや時計巻戻しを次の受付前に拒否します。transaction全体がrollbackされ状態が不明ならstoreを停止し、明示migrateまで再使用しません。

本文の1時間配送TTL・30日receipt保持とは別のローカルquota証拠です。この段階では自動GC・枠返却・thread resetを提供せず、有限容量に達したら停止します。DB全体を古いsnapshotへ巻き戻した場合はHMACだけでは検出できないため、単独restoreからの自動再開は未対応です。既存snapshot profileにも含めません。inbox・Task journal・budget・outbox・送信処理を静止し、照合してから再開する運用が必要です。

低水準の`ReplyAdmission.withReply`は、hostが確認済みsource metadataと同期commit guard・同期outbox actionを渡すローカルportです。認証APIやMCP toolとして直接公開しません。受信の証拠はInboxAnswers、Task証拠はTaskRepliesから供給します。任意のcallbackや任意sourceをwire引数から渡せるようにしません。

## 検証範囲

`node --test test/adapter-reply-budget.test.js` の36シナリオで、確認済み受信・ACKとの分離、許可関係、既定拒否、source／宛先／thread固定、同一返信の再試行、thread／rate／容量、再起動、失効、応答消失・別DBの確認失敗、期限、時計・行改ざん、rollback、native競合、answerとTask返信の共通枠を確認します。実SQLite／Relayのquestion→answer→ACKも確認し、Taskを起動しないことを検証します。Task返信はモデルなしの既存固定Taskを使います。

既存の模擬MCP経路も `verify-hab` で別途回帰確認しました。recv-ackは `009-b-relay_ack.res`、send-statusは `011-a-relay_status.res`、独立したDB auditは `012-inspect-after-ack.json` が証拠です。専用processはcleanup済みです。raw evidenceは一時領域のみで、公開repoへ入れません。この確認は既存Relayの回帰試験であり、未配線のbudget APIをMCPから操作した証拠ではありません。

[有限Adapter host](adapter-host.md)では、確認済みsourceの明示回答とTask返信に同じbudgetを組み立て、停止・通信前後・commitのguardも適用します。

実製品のmodel判断・callback・poll/wakeへの配線、自動処理の全入口への適用、実個体binding、運用restore・容量監視、本番E2Eは未実施です。ローカルの任意APIの実装を、三者の本番接続完了と混同しません。
