# Messageの個体別容量と最低予約枠

`SQLiteRelayStore` の任意host設定 `agent_capacity` は、既存の全体上限・宛先別pending件数と組み合わせます。既定runtime・認証・登録・MCP catalogを有効化せず、wireのagent名や追加fieldを権限に使いません。

## 上限と予約

- 送信者ごとのpending件数・live本文bytes・保持record件数。
- 宛先ごとのlive本文bytes・保持record件数。既存の宛先別pending件数も維持。
- hostが指定する最大256個体の、送信者別pending・本文bytes・recordの最低予約枠。

pending／live本文には `pending / leased / quarantined` を数えます。保持recordはACK済み・期限切れ・legacy safety-heldを含む全状態です。ACKはpendingと本文bytesを解放しても、30日等の既存retentionに従うrecordを無条件には消しません。容量不足で既存の本文やreceiptを捨てません。

新規受付後の全体使用量に、保護個体の**未使用の予約量**を足して全体上限を超える場合は拒否します。これにより、別の送信者が予約分を共有枠として使い切れません。予約を持たない検証済み個体も、個体上限と未予約の共有枠の範囲で送信できます。予約一覧は認証・登録・送信許可を与えません。

pending・bytes・recordは独立した条件です。count枠があっても本文がbyte枠へ収まらない場合や、宛先自体の上限・停止・blockなどに該当する場合の受付は保証しません。数値と保護対象はhostの明示policyで、coreが本番値や保護個体を推測しません。

## 原子性・再開・変更

容量はverified `Acceptance.sender_id` に基づき、受付のSQLite write transaction内で元の期限回収後に読みます。message／配送／auditのcommitと同じtransactionで判定し、独立した使用量counterを先に消費しません。複数writerは同じ最後の枠を使えません。

同じIDのexact replayと内容conflict判定は新規quota消費より先です。満杯・設定縮小後も保存済みreceiptを照合でき、再送で期限や容量を追加消費しません。policyはコピーして保持し、呼出元のobject変更では実行中storeの制限が変わりません。

新しい予約対象を追加するなどして既存の使用量が予約を圧迫している場合、古いrecordを追い出して予約を作りません。新規受付をbackpressureで止め、ACK・期限処理・保守による容量回復を待ちます。現在のusageがある状態で予約を追加すれば即座に最低枠を提供できる、という保証ではありません。

追加schema・migrationはありません。snapshotには配送recordが入り、quota policyはhost側の現在設定を使います。公開toolには個体一覧や他者usageを出さず、拒否は既存の `capacity_exceeded` です。

## 検証と範囲

`node --test test/relay-agent-capacity.test.js` の15シナリオで、件数／bytes／metadataの枠、ACK・元TTL、lease／隔離、exact replay、policy縮小・copy、認証分離、audit rollback、native worker同士の受付競合を確認します。

これはmessage受付の保存容量です。[添付blob側の最低予約枠](attachment-capacity.md)と[配送順・有限scanの進行](relay-fair-poll.md)も別の任意policyとして実装しました。個体別の送信rate、公平なwriter admission、遅延SLOは残っています。message最低枠だけで全体の公平性を証明したとは扱いません。
