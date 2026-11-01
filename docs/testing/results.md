# 配送テスト基盤の検証結果

2026-11-01 UTC。検証した実装commitは `216e63969ede5ec57b95e1df81cf46f2c6c102f0`。基準mainはPR114の `83220931e65a7db286c9964da98e4d3a2e03177a`。この記録は検証後に文書だけを追加したもので、製品コード、dependency、lockfile、既存CIの変更はない。

## 実行済み

| 確認                       | 結果                                           | 証拠                                                        |
| -------------------------- | ---------------------------------------------- | ----------------------------------------------------------- |
| 変更前の主要Relay baseline | 100成功、0失敗                                 | `.lab/baseline/relay.tap`                                   |
| 最終通常baseline           | BASELINE_PASS、終了0                           | `.lab/run-bhXzht/report.json`                               |
| 共通配送契約               | 現行8成功、A2A/JetStream各8skip                | `.lab/run-54gpBL/shared-contracts.tap`                      |
| SQLite障害と実行環境       | 11成功、0失敗                                  | `.lab/run-54gpBL/storage-and-harness.tap`                   |
| 既存Relay重点回帰          | 281成功、0失敗                                 | `.lab/run-54gpBL/relay-regressions.tap`                     |
| 既存全JS回帰               | 1436成功、0失敗、0skip                         | `.lab/run-54gpBL/full-regression.tap`                       |
| worker build               | 終了0                                          | `.lab/run-54gpBL/build.log`                                 |
| lintとtypecheck            | 終了0                                          | 実装commit前の `npm run lint` と `npm run typecheck` を実行 |
| Python Hermes bridge       | 34成功、0失敗                                  | `.lab/python-verification/python-0.log`                     |
| Python token入力境界       | 13成功、0失敗                                  | `.lab/python-verification/python-1.log`                     |
| 移行gate                   | BLOCKED、終了1。未実装のまま合格しない         | `.lab/run-54gpBL/report.json`                               |
| 試験process残存確認        | 専用checkoutに結び付くnode/workerd/esbuild 0件 | `.lab/process-inspection.json`                              |

重点回帰281件は全JS回帰1436件に含まれる。重複を合計してunique件数とは呼ばない。新規テストは現行契約8件、SQLite固有5件、環境6件の計19件が成功した。未実装の16skipは成功数へ含めない。

最終gateはclean working treeの実装commitを記録し、実行前後のsource inventory一致を確認した。Nodeは24.12.0、npmは11.6.2、SQLiteは3.50.4。lockfile SHA256は `f60f83afabc0fc2070eff5e1310ce9bb201d97c50bf1ec1a8cdc9525ad041a1b`。実行ソースSHA256は `f2d611606178f27ab8d90f6efa6d90def80ba8797396c6b646e60b4490b0c1de`。

## 失敗した試行も保持

| 試行       | 観測                                                  | 対応                                                                                         |
| ---------- | ----------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| run-liKEss | clock fixtureの1件失敗                                | SQLite clock関数の引数設定をvarargsへ修正                                                    |
| run-kUvLmB | 全JSでCLI stderrの9件失敗                             | 継承optionsを拒否し、ExperimentalWarningの扱いを固定                                         |
| run-BPi07t | SIGKILL fixtureの子processが保存前に構文エラー        | 生成arrow式を修正しstderr証拠を追加                                                          |
| run-IQeWW4 | 固定8789を使う既存inventoryで6件のbind関連失敗        | 競合が疑われるが当時のnative errorは非公開で原因未確定。port事前検査とown-listener確認を追加 |
| run-b7Z5a1 | 新しいready markerが期待ファイル一覧に未反映で1件失敗 | 期待一覧を修正。最終全回帰では成功                                                           |

全試行のTAPとJSONを `.lab/` に残す。失敗した試行を最終成功として扱わない。最初の判断記録5行はJST時刻へ誤ってZを付けていたため、append-onlyの訂正を [decisions.tsv](decisions.tsv) に記録した。

## 未実行と保留

A2AとJetStreamの製品adapterはこの変更にない。native Task lifecycle、broker commit/ACK/保持/復元、async認可境界、route rollbackを検証済みとは扱わない。mainにないrenameも未実行で、復旧時間と性能許容は未合意。GUIや実製品の常時接続、OS/電源断、物理SSD故障、全コピーの消去、任意外部side effectのexactly-onceは保証しない。

CI配線は [手順書](delivery-lab.md) の構成案のみ。push、PR、merge、本番切替は行っていない。pstackはnative inherit-parentの独立contextで実行し、provider/model familyの多様性を増やしたとは主張しない。
