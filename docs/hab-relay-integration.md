# 登録からHTTP配送・停止・復旧までのモデルなし統合試験

[README](../README.md) · [正式仕様](hab-relay-spec.md) · [登録・認可境界](../src/hab/README.md)

2026-10-17時点の、ローカルで再現できる17シナリオを記録する。人向け登録フローと配送を一連で試験するもので、実Grok Bot・Dots・Hermesの個体能力確認や、本番接続の受入れではない。G1の一部を裏付ける証拠とし、管理添付・公平性・実Adapterの返信制御・運用復旧を含むG1全体は未完了とする。

## 再現

Node 24以上で、repo直下から実行する。

```sh
npm ci
npm run test:hab-integration
```

17件すべてに成功すれば終了codeは0となる。各ケースの結果を表示し、失敗時のassertion出力にもfixtureのダミーデータを使う。実本文・認証値を扱う診断コマンドは追加していない。既存機能を含む回帰は`npm test`、登録の対話デモは`npm run demo:hab-enrollment -- --interactive`で別に実行できる。

試験本体は[hab-enrollment-delivery.test.js](../test/hab-enrollment-delivery.test.js)、組立ては[hab-journey-fixtures.js](../test/hab-journey-fixtures.js)、共有HTTP入口は[hab-http-fixtures.js](../test/hab-http-fixtures.js)を参照する。fixtureは専用の新規一時ディレクトリ・DB・模擬主体を作り、正常な後処理でlistenerとDBを閉じて削除する。既存設定、credential、Hermes、cron、公開経路の読取・変更は行わない。

## 通る境界

登録は低水準の`enroll/bind/setAccess`を省略して直接呼び出す近道を使わず、`runHabEnrollment`の製品選択・名前入力・アドレス確定・接続binding・操作選択・有効化を通る。UIの選択と確認、管理権限、個体認証はすべて模擬portである。停止・再開・block・失効・rotationは別の明示管理操作として注入する。

配送経路は次の実装を実際に接続する。

1. 専用`SQLiteEnrollmentJournal`と`SQLiteHabRegistry`へ登録・確認・bindingを保存する。
2. `HabRelayService`がregistryの現在の認可とRelayの永続storeを組み合わせる。
3. `HabHttpGateway`とNode callbackを、新規の`127.0.0.1`一時portにmountする。
4. `HabMcpClient`がnative HTTPでlookup・submit・status・poll・ACKを呼ぶ。
5. `DurableSender`／`DurableReceiver`が、それぞれ個体IDにboundされたprivate outbox／inboxへ保存する。
6. 本文引渡しケースでは、別の一時application DBへ本文を永続保存してからinboxの本文を解放する。

通常はGrok Bot・dot・Hermesという製品名を持つ模擬3個体を使う。別のケースでは同じ`grok-bot`製品の2個体とHermesを登録し、共通のowner subject／clientでも専有connectionが異なれば別ID・別inboxになることを確認する。これらのラベルは実製品の接続を証明しない。

## 試験と証拠

| シナリオ | 確認する結果 |
| --- | --- |
| 有効化前の配送拒否と3製品の相互通信 | binding済みでも有効化前のlookup／pollは拒否。有効化後は6方向の本文・構造化data・parts順序を保存し、ACK確定後のserver本文は消去 |
| 同一製品の2個体 | ID・inbox・差出人を区別し、他個体のreceiptを参照できない。元threadへの正当な回答は配送可能 |
| 受信者不在から復旧 | pollしない間の2通を保存し、registry／Relay／登録journalを開き直してから、元ID・元期限のまま受領 |
| 受付commit後の応答消失 | Hubとsenderを開き直し、元outbox要求で同じreceiptを回収。lookupは最初の1回だけで、追加message／deliveryを作らない |
| ACK commit後の応答消失 | server本文消去後も、private inboxの同じACK要求から同じreceiptを回収。ローカル本文と受領確認は重複しない |
| inbox保存失敗 | 保存に失敗した場合はACKしない。lease再取得後に元本文を保存してACKする |
| 並行pollと古いACK | 同時pollで有効leaseは1件。再取得でgenerationとtokenが変わり、旧ACKは拒否し、新ACKのexact retryは冪等 |
| 受信個体の停止・明示再開 | pending本文を残し、登録フローの再実行では停止を解除しない。管理者の明示再開後に元本文を取得 |
| directional block | 保存済みの対象送信者の配送を保留し、別送信者の配送は可能。明示unblock後に元messageを取得 |
| 失効と接続rotation | 再起動後も旧bindingは拒否・再利用不可。新しく検証した接続を別途binding／有効化しても、旧接続は復活しない |
| 同一要求と異内容再送 | reopenとACK後でもreceipt ID・期限を保持し、同じキーの本文変更はconflict |
| 本文による管理・実行・自動返信の要求 | 本文をdataとして配送し、registry変更・Task・追加messageを発生させない。MCP catalogは5 toolのままで、管理tool呼出しは拒否 |
| applicationへの本文引渡し | 別DBへ元本文を保存してからinbox本文を解放し、reopen後もapplication保存は1件、再pollは空 |
| 永続emergency stop | reopen後も全配送・lookupを拒否。完了済み登録フローの照合ではlatchを解除できず、pending本文は残る |
| ACK不明の間の停止 | ACK exact retryも現在policyで拒否し、ローカルACKを隔離。保存済み本文は失わず、再開だけで隔離ACKを自動再送しない |
| 受付不明の間の送信者停止 | 元outboxを隔離し、別messageを生成しない。明示再開後も隔離を自動解除せず、既に受け付けた元messageは受信可能 |
| 差出人・受信箱・返信参照の越境 | tool引数への他個体selector追加、無関係なthreadへの返信、外国体ACKは拒否し、元の配送だけを維持 |

## 障害注入の範囲

応答消失はnative HTTPの応答を読み捨て、呼出側へ固定の模擬transport failureを返す方法で注入する。これによりserver commit後・client確認前を作る。受付応答消失ケースではその後listenerも閉じる。試験は実ネットワークの切断装置・proxy故障を使うものではない。

Hub再起動は同じNodeプロセス内でlistenerとregistry／Relay／登録journalのDB接続を閉じ、同じprivate key・DB・固定resource URLで再生成する。該当ケースではsender／receiverのprivate journalも閉じて開き直す。認証は模擬hostが再び供給する。プロセス強制終了・電断・cold-startでの実認証復元・backup restoreの試験は別途必要である。

backoffとlease待機はテスト専用DBの`next_retry_at`、`lease_until`、`next_visible_at`だけを変更して進める。元message ID、本文、first_sent_at、expires_atは書き換えない。この操作はfixture内部の障害注入であり、通常hostやMCPへ公開していない。1時間TTL・30日retentionを実時間で待つ試験ではない。

一時DBの親は0700、ファイルは0600とし、keyやBearerはテスト専用定数である。これらを本番設定のdefaultやcredentialとして流用しない。HTTP経路は一時loopbackのみで、TLS・公開proxy・運用上限の本番受入れは含まない。

## 次の実装と接続条件

次は管理添付のupload・finalize・所有者／宛先・digest検証・受信側durable保存へ進む。個体別quota／公平性、固定Task bridge、実Adapterの有限返信budget、retention・migration・backup／restore・運用activationは別項目として残る。本文を解釈しないRelayの試験から、実エージェントの判断・実行ガードレールや自動返信loop停止まで保証したとは扱わない。

本番接続に進むには、製品・個体ごとのG0、管理／個体の検証主体、接続先・scope・送信data・費用・保管／失効・停止手順を具体化し、必要な承認後にhostへ配線する。今回の統合試験を根拠に、新credential発行、公開、実エージェント通信、plugin登録、自動常駐は開始しない。
