# 配送置き換えの隔離テスト

これは初期baselineとexact-f19専用runnerの記録です。現行の複合実装では、この固定runnerは意図的に拒否します。[P7実行手順](p7-lab.md)と[公開・CIの範囲](publication.md)を使用してください。

現在の配送はNATS JetStreamだけです。下表の「現行Relay」列と`relay-store`等は、廃止したSQLite配送storeを指す当時の記録です。現在の必須群と件数（full-regression 1151件を含む）は[P7実行手順](p7-lab.md)を参照してください。

For the exact-f19 A2A integration branch, see [native A2A acceptance](a2a-native-acceptance.md). It adds mandatory protocol groups and reclassifies the original A2A engine placeholders. Historical counts below describe the original lab baseline.

現行Relayと将来の配送adapterを同じ契約で評価する。コードbaselineは `d83ad6e`、公開仕様PR114取り込み後のmainは `8322093`。[製品仕様](../hab-product-spec.md)のA-10とA-11を中心に検証する。実製品接続や本番の動作保証ではない。LLM、Auth0、実credential、本番設定は使わない。

## 起動と証拠

Nodeは `.node-version` の24.12.0。npmは11.6.2で実行確認する。依存は既存 `package-lock.json` を固定し、新規dependencyは追加しない。

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm run test:delivery-lab
npm run test:delivery-lab -- --full
npm run test:delivery-lab -- --release
```

`--full` はworkerのbuildと既存全JSテストも実行する。Python検証は後述。`--release` もbuildと全JS回帰を必須にし、現在は必ず非ゼロになる。未実装backend、rename、未合意の性能基準が残るためであり、baselineが通っても移行承認とは扱わない。

実行ごとに専用checkout内の `.lab/run-*/` を作成する。SSD checkoutで実行すればDB、一時ファイル、証拠はSSD上に収まる。`report.json` にcommit、lockfile SHA256、Node/SQLite版、各群の実測時間、pass/fail/skip、保留理由を保存する。`sources.json` は未commitファイルを含む実行ソースのSHA256一覧で、実行前後に内容が変わればFAILにする。`.tap` が個別テストの証拠、`build.log` がbuildの証拠。終了時はそのrunの `tmp/` だけを削除し、レポートを残す。cleanup失敗もFAILとして残す。別runや本番processは停止しない。

テスト子processは環境変数を許可リストで作り直す。継承した `NODE_OPTIONS`、proxy、`HAB_*` 本番設定、API key、HOMEは渡さない。`NODE_OPTIONS` は固定値 `--disable-warning=ExperimentalWarning` を設定する。Node24のSQLite警告を含むExperimentalWarning全体を抑制し、CLIのstderr契約を固定する。任意の親設定は取り込まず、他の警告種別やテスト失敗は隠さない。Nodeの実体は親と同じ `process.execPath` を使う。新規fixtureのidentityは合成、HTTPは `127.0.0.1` の空きport。これはOS全体のnetwork sandboxではない。新しい外部通信を含むテストを追加するときは別途隔離を点検する。

`--full` と `--release` には既存inventory試験の固定port `127.0.0.1:8789` がある。実行前はbindだけで空きを検査し、占有時は他processへHTTPを送らずBLOCKEDとして終了する。既存全回帰はfile単位で直列実行する。途中で他taskと競合しても、自分のbootstrap子processがlistenしたPID/host/portのprivate markerを確認するまで、そのCLI試験はHTTPを送らない。占有者の停止やport設定変更はしない。固定portを必要としない通常の配送baselineは独立して実行できる。

各子processは終了確認後にlogを閉じる。H04/H05は実際の成功・失敗・不正出力・中断を検証する。runnerのsignal/timeoutは直接の子processを停止するもので、独立daemonやdetached descendantの監督機能ではない。試験にそのようなprocessを持ち込まない。F05のSIGKILL対象はその試験が起動した受信processだけで、終了を待ってからDBを再openする。

timestampと暗号lease tokenは毎回変わる。合成agent名、本文、送信順、message entropyは固定で、レポートは「乱数seedですべて同一」とは主張しない。leaseやACK retryの加速は新しく作ったfixture DB内に限定する。期限境界はSQLite connection内のclock関数をテスト内だけ差し替え、OS時計を変えない。

## 契約と合否表

`test/delivery-lab/contracts.test.js` のD01〜D08をbackendごとに実行する。adapterの操作はmessage生成、送信、receipt照会、poll、ACK、durable receiver、restart、disconnect/reconnect、名前付き障害注入。SQLiteのSQLはadapter内に閉じ込め、共通テストには書かない。A2A/JetStreamの登録はskip理由のみで、fake backendは実装していない。

| 項目                                      | 実行する証拠                                       | 現行Relay            | A2A / JetStream          |
| ----------------------------------------- | -------------------------------------------------- | -------------------- | ------------------------ |
| 3主体6方向の往復とUTF-8                   | D01                                                | 実行対象             | 未実装skip               |
| 送信重複、内容変更拒否                    | D02、relay-store                                   | 実行対象             | 未実装skip               |
| 永続保存してからACK                       | D03、relay-receiver                                | 実行対象             | 未実装skip               |
| ACK応答消失後の再起動                     | D04                                                | 実行対象             | 未実装skip               |
| commit前ACK消失、lease切れ、重複inboxゼロ | D05                                                | 実行対象             | 未実装skip               |
| 競合consumer                              | D06、relay-deliveryのworker競合                    | 実行対象             | 未実装skip               |
| 他identityのstatus/poll/ACK拒否           | D07、hab-auth-groups                               | 実行対象             | 未実装skip               |
| 切断と再接続                              | D08、receive-supervisor                            | 実行対象             | 未実装skip               |
| TTL等号、未来時計skew境界                 | F03、relay-contract、relay-store                   | 実行対象             | 追加実装必要             |
| 実SQLite FULL、安全な容量制限             | F01、F02                                           | 実行対象             | broker/adapter別注入必要 |
| 書き込み失敗とtransaction rollback        | relay-store/delivery/receiver                      | 実行対象             | 追加実装必要             |
| 破損DB、保存manifest改変                  | F04                                                | 実行対象             | 追加実装必要             |
| 保存直後の実process強制終了と復旧         | F05                                                | 実行対象             | broker/adapter別に必要   |
| group、宛先/送信者偽装、権限取消          | hab-auth-groups、hab-enrollment-delivery           | 実行対象             | 同じRegistry policy必要  |
| keyset paginationとscope漏洩              | hab-discovery                                      | 実行対象             | 共通Registryに再適用     |
| renameでID・inbox・進行中lease不変        | mainにrename APIなし                               | 未実行、移行gate保留 | 未実行                   |
| 配送receiptと実行完了の分離               | task-bridge、task-bridge-replies                   | 既存bridgeの回帰対象 | A2A Task実装が必要       |

F01/F02はSQLiteの `max_page_count` をfixture connectionだけに設定する。native SQLiteのerror 13発生も観測し、空き容量を消費し尽くさない。DB header破損は捨てるfixtureファイルだけに限定する。F05は保存後ACK前に実processをSIGKILLする。SSD切断、ホスト全体のディスク枯渇、電源断は試さない。process killの試験は、電源断でのfsync保証の証拠ではない。

## 移行gate

- 対象集合における受理済みmessageの欠落0件。本文を独立して読み返し、sender statusも照合する。
- 同じ `(sender_id,message_id)` によるinbox保存の重複0件。これは任意の外部side effectにexactly-onceを保証しない。実行adapterができたら、その実際の副作用先で重複0件を検証する。
- 他group/identity/mailboxへの漏洩0件。受理、照会、受信、ACKすべてで確認する。
- 障害後に元のID/期限を維持して復旧し、未保存の本文をACKしない。
- 全対象backendの必須契約がpass。skip、TODO、cancelled、runner失敗を移行合格にしない。
- 復旧時間と性能は同一host、同一負荷、同じ保持条件で測定してから許容値を決める。今ある経過時間はテスト時間で、配送latencyや本番SLOではない。

## A2A実装後の追加受入条件

受付/保存ACKではTaskをCOMPLETEDにしない。実行側の確定した成功とArtifactを必要にする。Task作成の応答消失/再試行でTaskを増殖させない。配送TTLとTask期限を混同しない。cancel競合、cancel不能、期限切れ、実行失敗、重複/順序逆転した結果、再起動後のTask/Artifact相関を検証する。対応不能な能力をAgentCardで公開しない。実際のpersistent Task storeを使い、fakeの状態遷移を製品のpassとして数えない。

## JetStream実装後の追加受入条件

Core NATSを耐久配送として扱わない。採用するserver/client版、image digest、disk storage、replica数、fsync方針、stream/consumer設定を固定した専用環境を別途用意する。Node/SQLite以外のinstallやdaemon起動はこの変更では行わない。

明示ACKをlocal durable commitの後に送り、ACK応答消失、AckWait超過、古いACK、consumer削除/再作成、InactiveThresholdとdurable consumer寿命、MaxDeliver、queue競合、server再起動/killとreconnect/backoffを検証する。retention、MaxAge、MaxBytesとdiscard policyで受理済み本文が失われないこと、1時間の配送期限と30日の冪等記録、ACK後の本文削除と受領証跡保持を別々に検証する。SQL側とbroker側の二重書き込みの中間停止も必要。これは受入条件であり、現在の製品設定や実行結果ではない。

## ローカルCI配線

ローカルの `.github/workflows/ci.yml` は `.node-version` を使い、既存 `npm test` を `npm run test:delivery-lab -- --full` へ置き換えた。nestedなguardを含めてbuildと既存全JS回帰を実行する。JSON/TAP/build logだけをalways() artifactへ保存し、private tmpやbinaryは含めない。timeoutは15分、retentionは7日。公開・hosted CI実行は保留中で、[NATS入力検証とCI準備の結果](verified-nats-results.md)にローカル検証を記録する。

Pythonは既存CIと同じ `python3 -B -m unittest discover -s hermes_bridge -p 'test_*.py'` と `python3 -B -m unittest scripts.test_inventory_token_input` を別stepで実行する。JetStream jobはserver/client版が決まった後、認証付きloopbackのみで立ち上げ、`always()` cleanupでそのjobが作ったcontainerだけを停止する。migration release jobは `--release` を使い、未実装skipのままgreenになることを防ぐ。

## pstackの利用と判断記録

開始時に導入済みopen-pstack 1.16.0のmanifestを確認した。参照は `open-pstack:figure-it-out` と `open-pstack:poteto-mode`。`skills.read` のpackage `e8/skills/figure-it-out` を入口に、poteto-modeのPrinciples、prove-it-works、model-the-domain、test-behavior-not-implementation、show-me-your-workを読んだ。CLI daemonを起動する方式ではない。

最初の手順は、合格条件を定義、既存baseline保存、共通契約/障害fixture追加、実行、判定記録という順にした。Prove It Worksによりコンパイルだけでなく実HTTPとSQLiteの状態を確認する。Model the Domainによりbackend登録表を使い、未実装理由をデータとして保持する。Test Behavior, Not Implementationにより公開操作と受信側の読み返しを照合する。

更新担当から同じ1.16.0が公式最新版と一致したという引継ぎを受け、保留を解除した。how説明、architectの3候補、cross-judge、no-commentsを設定どおりnative `inherit-parent` で実行した。providerやmodel familyの多様性は増えていない。設計比較は初期コード作成後の検証で、事前設計としては扱わない。本体は変更していない。判断記録は [decisions.tsv](decisions.tsv)、設計判断は [architecture.md](architecture.md)、手順のチェックリストは [plan.md](plan.md) に置く。

## 担当間の接続点

この変更が所有するのは `test/delivery-lab/`、`scripts/delivery-lab.mjs`、`scripts/lib/delivery-lab.mjs`、`docs/testing/` とnpm scriptの追加。既存 `bootstrap-guard-fixture.js` と `inventory-entry.test.js` は、子listenerの所有確認だけを補強する。dependencyとlockfile、`src/a2a/`、`src/relay-jetstream/`、Registry、host factory、GUIは変更しない。CIのローカル配線は後続のNATS入力検証phaseが所有する。並行担当の未merge実装をコピーしてfakeのpassにしない。

A2A担当はP1/P2のSDK/Task専用試験を所有する。NATS担当はP4/P5の非同期認可境界、broker fixture、receipt回復を所有する。どちらもHAB配送互換adapterが準備できた後に、この共通契約へfactoryを登録する。P3/P6/P7の統合proof、route rollbackと別保存先からのrestoreは未実装で、今回のbaseline合格には含めない。GUI/MCP等価性や狭幅mobile、実製品のwakeも別受入れとする。
