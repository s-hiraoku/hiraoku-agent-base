# NATS入力検証とローカルCI準備の結果

**履歴文書（ADR-018で削除した経路）**：本書が使う`packages/relay-nats`、nats-serverの導入script、`--nats-server`入力、P7 runnerは削除済みです。2026-11-13の[ADR-018](../hab-decisions.md)で配送はhostのSQLite配送storeだけになりました（[配送store](../delivery-store.md)）。現在のCIは`.github/workflows/ci.yml`を参照してください。以下は当時の記録で、現在のコードや手順を表しません。

検証した実装commitは `caef55bf68915a624225304d0c28c3cf1fb6d88a`。clean working treeで公開CLIを実行し、実行前後のsource inventory一致を確認した。この結果文書はその後の文書だけの変更である。

```sh
npm run test:delivery-lab -- --full --nats-server /absolute/path/to/official/nats-server
```

| 検証                                   | 結果                              | 証拠                                                                      |
| -------------------------------------- | --------------------------------- | ------------------------------------------------------------------------- |
| 公式Darwin arm64 2.15.2の公開CLI正例   | BASELINE_PASS、終了0              | `.lab/run-4ikWOc/report.json`                                             |
| private copyの実Node-child引渡し       | 1成功、元file不変、終了後copy削除 | 同runの `nats-input-handoff.tap`、`.lab/nats-runner/public-positive.json` |
| 新しいguard fixture N01〜N10           | 10成功、0失敗                     | 同runの `storage-and-harness.tap`                                         |
| SQLite障害・環境・guard群              | 計21成功、0失敗                   | 同runの `storage-and-harness.tap`                                         |
| 共通配送契約                           | 現行8成功、未実装16skip           | 同runの `shared-contracts.tap`                                            |
| 既存重点回帰                           | 281成功、0失敗                    | 同runの `relay-regressions.tap`                                           |
| 既存全JS回帰                           | 1436成功、0失敗                   | 同runの `full-regression.tap`                                             |
| lint、typecheck、diagram manifest      | 成功                              | 最終実装commitに対して実行                                                |
| CI YAML構文・主要構成                  | 成功                              | `.lab/nats-runner/ci-local-check.json`                                    |
| 専用checkout/worktreeの残存process確認 | 該当0件                           | `.lab/nats-runner/process-inspection.json`                                |

guardの10件は21件の一部で、重点回帰281件は全JS1436件の一部。合計をunique件数として扱わない。公式ファイルと実Node-childで観察したのは入力の検証・引渡しだけで、NATS executableとbrokerは起動していない。

公開CLIは固定公式pinを使い、caller指定のSHA、manifest、URL、認証情報、任意cwdを受け付けない。候補へ `--version` を送らず、opened FDから読んだ同じbytesをprivate copyへ保存する。通常Relay群の環境/cwdは維持し、専用probeだけに検証済みpathとprivate cwdを渡す。詳細は [利用手順](verified-nats-input.md) を参照。

公式release APIのasset digestと4環境のarchive SHAを照合し、そのarchive memberを実行せず読み出してbinary SHAとサイズを導出した。checked-inのpin JSONはその独立記録と一致した。source SHAは `bbb31e6a05f4c3e9bd10c39ef74e79f708f11ea1fe7b8e746c9a1f1663b22b9d`。全4環境分のpin導出を、全4環境での実行成功と呼ばない。

## pstackの作業単位

howの説明と3候補のarchitect/arena比較を実装前に行い、cross-judgeと親の判断が一致したB案を採用した。Cの構造化エラーとjob timeout、Aの公式pin provenanceを取り込んだ。単独ownerが専用SSD worktreeで実装し、親がdiffと独立レビューを確認してローカル検証checkoutへ取り込んだ。

Blocking first stepsは公式pin確認と設計選択、Independent workstreamsは読取設計とpin導出、Shared mutable stateは単独writerの隔離worktree、Smallest safe decompositionはCLI/verifier/probe/CIを一人が所有する構成とした。Model the Domainで未検証pathと検証済みcopyを別recordにし、Prove It Worksで実CLIとchildの観測を合格条件にした。独立reviewは阻害不具合なし、コメント削除とMUST KILLは0件だった。native inherit-parentなのでmodel/provider多様性は増えていない。

最初のfocused runはinert fixture用digestの誤記で3件失敗し、訂正後10件成功した。失敗TAPも `.lab/nats-runner/worker-evidence/` に保持した。workerの途中baselineはprobe/testの2ファイルと最終source inventoryが不一致だったため、最終実装SHAの根拠には使わず、親のclean commit公開CLI runで置き換えた。設計・レビュー原文は `.lab/nats-runner/design/` と同領域のreview文書に残す。

## 保留の境界

CI workflowはNode版固定、nested lab、限定artifact保存までローカルで配線した。公開、hosted CI、Linux実行は行っていない。既存Pythonコードは変更しておらず、この追加phaseではPython47件を再実行していない。前phaseの結果は [基盤検証結果](results.md) に保持する。

backendのskipと移行保留条件は維持した。今回の共通contractは現行Relayであり、NATSの実group/epoch認可、host選択、A2A経路、broker故障・restore・rollbackを統合した試験ではない。backend-ready通知と対象SHAの確定後に別段階で検証する。既存NATS packageの直接launcherはこの変更の対象外である。
