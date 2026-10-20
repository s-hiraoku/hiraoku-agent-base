# 公平なpollと永続scan位置

`SQLiteRelayStore` のhost設定 `fair_poll:true` で有効にする任意の配送順です。既定は従来の時刻順で、runtimeやMCP catalogを有効化しません。wire引数でmode・宛先・巡回位置を指定できません。

## 1回の境界

宛先ごとに、直前に確認した送信者の次からsender ID順に巡回します。最大 `poll_scan_limit` 個の異なる送信者を選び、**各送信者につき最大1message**を確認します。送信者内ではaccepted時刻・message ID順を巡回し、前回の位置から再開します。1回のpollで返すdeliveryは最大1件です。

送信者のbacklogが多くても同じ呼出しで複数枠を使いません。候補を許可できない場合も位置をcommitするため、scan上限1でも次のpollは別の送信者へ進みます。同一送信者に異なるkindのmessageがある場合も、先頭の許可されないkindだけを繰り返し確認しません。

現在のpeer権限で拒否される候補、未接続の添付配送policy、明示的な `attachment_binding_unavailable / attachment_delivery_unavailable` は配送を保留して次へ進みます。本文とpending状態を保持し、lease・ACK・attemptを作りません。元の権限が回復すれば将来の巡回で再確認できます。予期しないstore失敗・参照不整合・cursor改ざんはpoll全体をrollbackし、健全なDBとして処理を進めません。

## 既存の保証

宛先の生きたleaseは引き続き最大1件で、lease中の追加pollは新規候補へ進みません。元TTL・再配送の有限backoff／最大attempt・隔離・ACK冪等性・添付proofを維持します。受信者全体の権限と、選択したsender／kindの現在権限を再確認し、textを含めSQL適用後にもlease期限を検査します。拒否・期限切れ・audit失敗ではlease／attemptと巡回位置を一緒にrollbackします。

公平性は**deliveryを選ぶ回数の巡回**です。安定したeligible sender集合に対し他者の候補が順番を塞ぎ続けないことを検証します。writer受付の公平性、byte／転送時間・agent実行時間の公平性、連続的な新個体・policy変更下の遅延上限やSLOは保証しません。1件の大きな添付や既存の生きたleaseを、このpolicyが中断することもありません。hostの有限呼出しと受信側の進捗・停止処理は別の境界です。

## Schema 5と復旧

明示migrationで `relay_poll_cursors`（宛先ごとの最後のsender）と `relay_poll_senders`（宛先・senderごとの最後のmessage位置）を追加します。どちらも元のprivate fingerprint keyからdomainを分けたHMACで保護し、本文・credential・lease tokenを保存しません。選択・位置更新・lease・auditは同じSQLite write transactionで行い、別接続・再起動でも位置とsingle-flightを共有します。

ACK／元期限によるterminal更新では、live queueがなくなったsender pair・宛先の位置を同じtransactionで削除します。空inboxへのpollは行を作らず、位置行の数はlive queueに対応する範囲に収まります。回収triggerやschema5 tableの欠落はmigrateで拒否し、自動修復しません。modeを無効にしても既存の未配送messageを消しません。

既存schema1–4から5へのmigrationはreceipt・本文・元時刻・ACK・削除outboxを保ち、失敗はrollbackします。snapshotにはschema5の位置も含めます。旧schema4の署名付きsnapshotも検証・停止復元でき、復元で自動migrationせず、hostの明示migrateで5へ進めます。未知schemaや追加tableを許可する互換化ではありません。

## 再現と残り

`node --test test/relay-fair-poll.test.js` は25シナリオです。backlog間の巡回、scan1、kind別の拒否と復帰、再起動、有限候補数、添付保留、権限失効、single-flight、backoff／隔離、HMAC、ACK／lease audit rollback、migration、空inbox、TTL回収、遅いSQL、native writer競合、起動時のschema lock待機、既定FIFOを確認します。snapshot側にも旧schema4互換とschema5位置保持の2件を追加しました。

[Message個体別容量・最低枠](relay-agent-capacity.md)と組み合わせられます。blob側の最低予約、個体別の送信rate・writer admission、本番のpolicy値・監視・接続、実Adapterの処理公平性は残っています。

接続時のbusy timeoutは初期化PRAGMAより前に設定し、別connectionが短時間schema lockを保持していても最大5秒待ちます。待機は有限で、pollのlease・原子性・single-flightの条件は変わりません。
