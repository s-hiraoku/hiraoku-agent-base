# 質問返信の永続intentと再起動時の照合

[README](../README.md) · [有限Adapter host](adapter-host.md) · [返信budget](adapter-reply-budget.md)

`src/answer-intents/` は、質問への回答を配送outboxへ渡す前に保存する独立したローカル部品です。モデルやTaskを呼ばず、HAB登録、認証発行、scheduler、listener、既定MCP catalogへの配線も行いません。人・エージェントが確定した回答bodyを明示的に渡します。

## 保存から配送まで

1. `AnswerIntents.prepare(context, source, body)` で、現在の認可と実inboxのACK確認済みquestionを検証します。宛先・thread・返信参照はその原質問から固定します。呼出し側はagent名・宛先・ID・期限を指定できません。
2. 専用SQLiteAnswerJournalへ、原質問ごとに一つの返信ID・body・作成時刻・1時間の期限をcommitします。この時点ではbudgetもoutboxも消費せず、送信もしません。IDはreplay-bound形式です。呼出し引数の後からの変更は保存内容へ影響しません。
3. `enqueueOnce(context, source)` は保存済みのenvelopeを共通ReplyAdmissionへ渡し、SQLiteOutboxへ保存します。quota・不明結果・再起動後も同じID・body・期限を使います。
4. outbox引渡しが確認できたら、journalをenqueuedにしてproducer側の本文を削除します。outboxの送信・status・ACKは既存DurableSenderの別操作です。enqueuedを配送ACKと解釈しません。

原質問のbodyは最初のprepare後に既存inboxのreleaseBodyで解放できます。journalには原質問本文を複製せず、検証した原質問の宛先・thread・ID・期限と秘密key付き比較指紋を保存します。原質問ごとの確定回答は一つです。同じbodyのprepareは元の記録を返し、変更したbodyはanswer_intent_conflictです。これは本文解放後にも維持します。構造化JSONのobject key順は同一視し、文字列・parts順・値は保持します。

添付partは既存契約の管理添付metadataだけを保持します。添付本体の生成・ownership・寿命・outboxへのready admissionは既存添付portの責務であり、ここでURLを取得したり添付を延命したりしません。

## 不明な引渡しと起動時照合

journalとbudgetとoutboxは別DBです。outboxがcommitしてから応答やjournal確認writeが失われた場合、journalにはpreparedと元のbodyが残ります。次のenqueueは保存済みenvelopeで既存outboxへ再照合し、同じbudget予約を再利用します。新IDや新しい期限を作りません。quota不足のpreparedも自動削除・作り直し・refundを行いません。

再起動時は、同じ個体・key・policyのDBを明示migrateしてから以下を順に呼びます。

- `pending(context, limit, after?)`：未確認preparedの有限ページ。返信ID順で、ID・source key・状態・時刻だけを返します。bodyや指紋は返しません。
- `inspect(context, source)`：保存状態と、同じ返信IDのoutbox状態を照合します。存在しなければmissingです。診断結果は実行や新返信の権限になりません。
- `enqueueOnce(context, source)`：現在も権限がある原質問だけを明示的に引き渡します。

起動だけで送信・Task・全件再試行を始めません。ページ一覧の権限と各sourceの引渡し権限は別です。継続中の書込みがあれば、一覧はsnapshotではありません。有限ページを走査し、必要に応じて先頭から再確認する運用にします。

enqueuedなのにoutboxがmissingなら、個別DBのrestore・GCなどを確認します。producer本文は解放済みなので、自動的に新しい本文・IDを作り直しません。expiredも再生成しません。

## 期限と30日記録

prepareで確定した返信envelopeの期限は1時間です。期限を過ぎたpreparedは引渡しできず、enqueueまたは明示maintainでexpiredにしてbodyを削除します。不明な引渡しの後なら、producerがexpiredでもoutbox側で既に受付・配送されている可能性があります。inspectで元IDの状態を確認し、expiredを未配送や遠隔取消しの証明にしません。常駐timerはなく、物理的な削除には有限maintainを動かす必要があります。

terminal metadataは、原質問の配送期限・返信期限・terminal確認時刻の最大値から30日保持します。`maintain(context, limit)` は最大limit件の期限処理／削除を一transactionで行います。limitは1〜1000、保管record・body bytes上限はhostで明示します。最大record 10000・body bytes 64MiBを超えるpolicyは拒否します。満杯で既存の未確認回答を追い出しません。

replay-bound原質問は、原質問期限から30日を過ぎた新規prepareを拒否します。既存記録の正確な再確認は許可します。これによりmetadata削除後に古いinboxから新返信IDを作ることを防ぎます。原質問の1時間の配送期限は回答判断の締切ではありません。上記dedup期間内なら、配送期限後の最初のprepareもできます。

旧形式のopaque原質問IDは時刻を検証できないため、terminal metadataの自動削除をsafety-heldにします。有限容量を消費し続けるので、勝手なresetで再回答を可能にしません。保守・移行は別途検討します。永続時計high-waterをHMACで保持し、GC後も時計の巻戻しを拒否します。

## 認可・保存境界

`AnswerAuthorization(context, operation, source|null)` は同期の信頼するlocal portです。prepare／enqueue／inspect／pending／maintainを別々に認可し、検証済みcontextから個体とactorを決めます。既定拒否、Promise・別個体・操作中の失効／actor変更を拒否します。source引数自体を認証に使いません。

journalのproof／handoff callbackは信頼する組込みportで、wire APIへ公開しません。Facadeは実inboxのwithEntryで保存内容とACK確認を得ます。任意bodyの決定・安全性の判断は受信側アプリケーションに残します。question以外からanswerを作らず、通知・回答からの自動往復やTask生成も行いません。

専用SQLite schema1は0600、symlink拒否、同期FULL・secure_deleteを使います。個体・key・policyのbinding、recordとbodyのHMAC、索引列・件数・body bytes・clock sealを確認します。明示migration前、不明schema、改ざん、clock regressionは拒否します。rollback失敗ではinstanceを使用停止し、明示migrationまで使いません。暗号化DBではないため、専用DBとkeyは秘密設定として管理し、Gitへ保存しません。

## 有限hostとの配線

AdapterHostOptionsへ同じ個体の`answer_intents: SQLiteAnswerJournal`を任意指定します。

| stepOnce op | 引数 |
| --- | --- |
| answer_prepare | source、body |
| answer_enqueue | source |
| answer_inspect | source |
| answer_pending | limit、任意after |
| answer_maintain | limit |

すべて既存controlのactive世代と現在のhost認可を通す同期操作です。停止中は実行せず、Taskやnetworkを開始しません。設定時は従来の自由envelopeによるanswer操作を拒否し、二つのproducerを混在させません。未設定のhostは従来answerの契約を維持し、新操作は未設定として拒否します。

独立部品を直接使うhostにも、同じ個体で一つのproducer journal・budget・outboxを使い、ほかの入口で手動answerを生成しない構成が必要です。journal内の並行prepareはSQLite transactionで一つのIDへ収束しますが、host全体の単一ownerや別journalを使った二重producerを自動検出する仕組みではありません。

既存snapshot profileにこのDBは含めません。inbox／outbox／budget／control／Task DBとの整合backup・owner lease・全起動状態の照合・運用監視・本番配線は次段階です。DB全体の古い正当なsnapshotへの巻戻しはHMACでは検出できません。停止・整合世代と元IDの確認なしに単独restoreして再開しません。

## 検証

`node --test test/answer-intents.test.js` の44シナリオで、準備前後の副作用、再起動とinbox本文解放、outbox応答消失、journal確認write失敗、同budget再利用、期限・30日GC・opaque保持、時計巻戻し、認可・停止・quota・容量・改ざん・rollback失敗・二接続／native並列producerを検証します。native loopback HTTP MCPでは実client経由の受信→prepare→journal再起動→引渡し→送信→返信ACKを確認します。一時DB・模擬認証・モデルなしです。

既存Relay MCPはverify-hab skillでも別途回帰確認しました。これは新producer APIのMCP公開や実Bot接続を証明するものではありません。recv-ackの証拠は009-b-relay_ack.res、send-statusは011-a-relay_status.res、独立DB auditは012-inspect-after-ack.jsonです。専用processはcleanup済みで、raw evidenceは一時領域だけに保持します。新規credential・常駐起動・実エージェント接続・外部公開は行いません。
