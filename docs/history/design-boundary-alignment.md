# 共通MCPと任意Taskの設計境界の照合

2026-11-04 UTC。照合基準は main `c667095dcd3b0d7c672b522fe3dd45eaeade0c81` と、未マージ [PR #132](https://github.com/s-hiraoku/hiraoku-agent-base/pull/132) の head `32903598a236bab2c3c9b002b4f9eef3670d810f`。本番設定や稼働中processを調査・変更した記録ではない。

## 確認した境界と修正

[共通MCP接続](../common-mcp-connection.md)、[Relay正式仕様](../hab-relay-spec.md)、[設計思想](../hab-principles.md)、[製品仕様](../hab-product-spec.md)、[受信supervisor](../receiver/receive-supervisor.md)を基準に、役割・処理・ADR・内部設計・既存Hermes接続・汎用Task設計と実装を照合した。

| 対象 | 照合結果 | 今回の扱い |
| --- | --- | --- |
| 標準MCPと受信supervisor | 受信側がpollし、保存後ACK。`ReceiveSupervisor` は `receive` のみを呼び、`AdapterHostCycle` は `DurableReceiver` へ保存・ACKを委ねる | 既存動作を維持。外部本文と構造化実行要求で、Taskと返信を生成しないHTTP回帰試験を追加 |
| 固定TaskとTask bridge | 明示引受け・Task link・安定key・照合を持つ任意機能。ACKだけでTaskを作らない | 保持。旧文書のHermes Runs・固定payload・並列1を限定Taskの契約へ位置付ける |
| 汎用TaskとA2A/NATS実行port | `createGenericTextHost` は明示した `GenericTextJobs` を受け取る独立host。通常Relayや受信supervisorの必須依存ではない | 保持。通常通信の次段階として製品実行API・専用consumer・承認機構を要求する説明を修正 |
| PR #132 | Hermesの `AIAgent` を構築して `run_conversation` を呼び、専用の実行・返信承認journalを持つ隔離候補。8ファイルの追加だけでmainへ未導入 | 標準接続に採用しない。mainから削除する対象はなく、PRのbranch・状態や既存bridgeを変更しない |
| `working` の説明 | 汎用設計は受信側で処理中と説明していたが、実装はTask claim後を投影し、NATS実行受付前も含む | 現行のcoordinator状態として文書を統一。モデル起動・承認・完了の証拠にしないことを明示 |

方針は[ADR-015](../hab-decisions.md)に記録した。通常接続で製品固有のモデル実行・承認をHABへ追加せず、内容判断・実行・必要な承認は受信エージェントの既存機構に残す。任意Taskの一律no-tools・返信承認の限定実験を、通常通信の必須条件へ広げない。受信側に必要な承認を省略する権限も与えない。

照合では通常受信の自動モデル実行や稼働経路の破損を確認していないため、runtimeの挙動を変更する修正やデータ削除は加えなかった。原因は標準通信、歴史的な限定Task、後発の任意実行設計の適用範囲が曖昧だったことである。

## 回帰検証

[既存verify-habの手順](../../.claude/skills/verify-hab/features/communication-boundary.md)から再実行できる。

```sh
npm ci
NODE_NO_WARNINGS=1 npm run test:communication-boundary
npm run lint
npm run typecheck
node docs/diagrams/render-mermaid.mjs --check
python3 -B -m unittest discover -s hermes_bridge -p 'test_*.py'
```

| 検証 | 結果と証拠の範囲 |
| --- | --- |
| 変更前の受信supervisor・通常catalog・汎用ジョブ | 57件成功。通常受信の既存境界を確認 |
| `test:communication-boundary` | 61件成功。新規3件は実loopback HTTP MCPの送信→周期受信→保存後ACK→送信側statusを検証。独立SQLite接続がACK前の本文とACK要求のcommitを確認。Task portを構成してもTask link・Task・返信outboxは0件 |
| 汎用ジョブ状態の追加試験 | claim後、runtime IDがnullでも `working`・`outcome=pending` となり、結果を公開しないことを確認。既存A2A投影はこの状態を `TASK_STATE_WORKING` に対応させる |
| Node全体 | buildと1685件が成功。以下の正規TMPDIRで実行 |
| 既存Python bridge | 34件成功。PR #132の未マージコードは試験・有効化していない |
| 静的検証 | lint・typecheck成功。READMEと既存PNGのMermaid manifestは2図一致。新コードのコメント・抑制指定は0件。独立レビューで必須修正の指摘なし |

Macの既定一時領域は `/var` 経由の別名だった。全体テストでは未変更snapshot群23件が `snapshot_unavailable` で失敗し、同群の単独実行でも27件中23件が再現した。snapshotは実パス一致を検証するため、正規パスのTMPDIRを渡すと同じ27件が全て成功し、全体1685件も成功した。検査やruntimeを緩めず、次の環境指定を使った。

```sh
HAB_TEST_TMPDIR="$(node --input-type=module -e 'import {tmpdir} from "node:os"; import {realpathSync} from "node:fs"; process.stdout.write(realpathSync(tmpdir()));')"
TMPDIR="$HAB_TEST_TMPDIR" NODE_NO_WARNINGS=1 npm test
```

## GitHub CIのsource固定への追従

最初の[PR CI](https://github.com/s-hiraoku/hiraoku-agent-base/actions/runs/41935743092)は、今回変更した `generic-job-application.md` がP7 successor manifestの固定hashと異なり、試験開始前に拒否された。通常の `npm test` は `test/p7/` の専用guardを含まないため、Node全体1685件の成功だけではこのCI入口を検証できなかった。

既存の `scripts/pin-p7-successor.mjs` を使い、固定commit `84248665cfce44791027a0b232de6c7dd76c529c` からsuccessor manifestを生成し直した。新しい境界試験も `--include test/common-mcp-boundary.test.js` で検証対象へ加えた。historical source-pinとpredecessor fixturesは変更せず、265入力の固定hash検査を維持した。P7の全体回帰期待件数も追加4件を含む1685件へ更新し、失敗・skip・cancel・TODOを許可する変更は加えていない。

修正後、CIと同じ `scripts/p7-lab.mjs --full --nats-server <検証済み公式binary>` をローカルで実行し、9グループすべてが成功した。全体回帰1685件、sourceの前後一致、所有workerの終了、scratch削除を確認し、`P7_LOGICAL_PASS` を得た。lintとroot/NATSの型検証も成功した。これは製品やbrokerの本番採用を意味しない。

P7に固定された文書・試験・sourceを変更する場合は、[P7実行手順](testing/p7-lab.md)の専用検証も実行する。manifestは可変な作業ファイルのhashを直接書き換えず、レビューしたcommitから既存生成器で作成する。

## 残る受入れ

ローカル試験は合成認証・一時DB・loopback listenerを使い、周期は注入schedulerで進める。実時間のpoll頻度、実製品への表示・引渡し、既存のtool・承認UI、認証更新、本番hostの常駐受信を検証したものではない。GUIの稼働版を変更・検証した主張もしない。

実製品への引渡しは、正式な既存MCP機能、受信契機、永続保存先、必要な受信側の既存権限・承認を確認して進める。Hermes固有runnerやPR #132をその前提にしない。汎用Taskを配備する場合は、その用途と受信側の引受け・実行契約を別途明示する。今回マージ・本番反映・credentialやgrantの変更は行わない。
