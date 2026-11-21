# Messageの個体別容量と最低予約枠

SQLite配送store（`src/delivery`、[ADR-018](../hab-decisions.md)）のhost設定 `delivery.queue.agent_capacity` は必須で、既存の全体上限・宛先別pending件数と組み合わせます。既定runtime・認証・登録・MCP catalogを有効化せず、wireのagent名や追加fieldを権限に使いません。

## 上限と予約

2026-11-21 JST、[ADR-033](../hab-decisions.md)で数え方を変えました。個体別の枠は「まだ相手が読んでいないメール」だけを数えます。

- 送信者ごとの未読件数（`max_pending_per_sender`）と未読本文bytes（`max_body_bytes_per_sender`）。
- 宛先ごとの未読本文bytes（`max_body_bytes_per_recipient`）。宛先ごとの未読件数は既存の `max_pending_per_recipient` です。
- hostが指定する最大256個体の、送信者別の未読件数・未読本文bytesの最低予約枠（`reservations[].pending` / `body_bytes`）。

未読は `pending / leased / quarantined` です。受信者が読んだ（ACK・`hab_inbox` の既読）時点、または期限切れになった時点で、そのメールは送信者にも宛先にも数えません。既読後7日だけ読み直せるように残す本文も、個体別の枠には数えません。

保持recordと残した本文は、ディスクを守る全体の上限だけで扱います。`max_records` はACK済み・期限切れ・legacy safety-heldを含む全recordの数、`max_body_bytes` は既読で残した本文を含む全本文bytesです。どちらも通常は届かない大きさに設定する最後の歯止めで、ACKは既存retention（期限＋30日）に従うrecordを無条件には消しません。容量不足で既存の本文やreceiptを捨てません。

以前は送信者・宛先ごとの保持record件数（`max_records_per_sender` / `max_records_per_recipient`、予約の `records`）も数えていました。既読のメールが保持期限まで送信者の枠を使い続けるため、少しやり取りしただけで送れなくなりました（25件で `capacity_exceeded`）。これらの設定は削除し、残っているとhostは起動しません（`config_invalid`）。

新規受付後の全体の未読件数・全本文bytesに、保護個体の**未使用の予約量**（予約量から、その個体の今の未読を引いた量）を足して全体上限を超える場合は拒否します。これにより、別の送信者が予約分を共有枠として使い切れません。予約を持たない検証済み個体も、個体上限と未予約の共有枠の範囲で送信できます。予約一覧は認証・登録・送信許可を与えません。

件数・bytesは独立した条件です。件数の枠があっても本文がbyte枠へ収まらない場合や、宛先自体の上限・停止・blockなどに該当する場合の受付は保証しません。数値と保護対象はhostの明示policyで、coreが本番値や保護個体を推測しません。

既読のメールを数えないので、受信者がすぐ読む相手へは、送信者は未読枠に関係なく送り続けられます。その増え方を抑えるのは送信rate（未実装）の役目で、個体別の保持record枠ではありません。全体の `max_records` に届くと全員が送れなくなるので、保持期間（約37日以上）に見込む通数より十分大きくします。

## 原子性・再開・変更

容量はverified `Acceptance.sender_id` に基づき、受付のSQLite write transaction内で元の期限回収後に読みます。message／配送／auditのcommitと同じtransactionで判定し、独立した使用量counterを先に消費しません。複数writerは同じ最後の枠を使えません。

同じIDのexact replayと内容conflict判定は新規quota消費より先です。満杯・設定縮小後も保存済みreceiptを照合でき、再送で期限や容量を追加消費しません。policyはコピーして保持し、呼出元のobject変更では実行中storeの制限が変わりません。

新しい予約対象を追加するなどして既存の未読が予約を圧迫している場合、古いrecordを追い出して予約を作りません。新規受付をbackpressureで止め、受信者の既読・期限処理による容量回復を待ちます。現在のusageがある状態で予約を追加すれば即座に最低枠を提供できる、という保証ではありません。

追加schema・migrationはありません。quota policyはhost側の現在設定を使います。公開toolには個体一覧や他者usageを出さず、拒否は既存の `capacity_exceeded` です。

## 検証と範囲

個体別容量の回帰は `node --test test/sqlite-delivery.test.js` に含まれます。既読（ACK・`hab_inbox`）と期限切れで枠が空くこと、隔離中の未読は数え続けること、既読で残した本文が全体のbyte上限だけに数えられること、予約の未使用分が既読で戻ることを確認します。旧Relay実装時には15シナリオで、件数／bytes／metadataの枠、ACK・元TTL、lease／隔離、exact replay、policy縮小・copy、認証分離、audit rollback、native worker同士の受付競合を確認しました。

これはmessage受付の保存容量です。[配送順・有限scanの進行](fair-poll.md)も別の任意policyとして実装しました。個体別の送信rate、公平なwriter admission、遅延SLOは残っています。message最低枠だけで全体の公平性を証明したとは扱いません。
