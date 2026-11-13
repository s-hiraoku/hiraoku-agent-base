# 受信後のエージェントへの引渡し

`src/recipient-messages/` は、保存済みメッセージを受信エージェントの既存入力経路へ渡し、その確定返信を既存 outbox に保存する、明示構成のローカル API である。[ADR-015](../hab-decisions.md)、[共通 MCP 接続](../common-mcp-connection.md)、[受信側の実機準備](recipient-readiness.md)に従う。通常 MCP の5操作、受信 supervisor、Task の状態や既存製品設定は変更しない。

現在の対象は `in_reply_to=null` のテキストだけの question / notice。返信は question に対するテキスト answer だけで、追加質問や対応不能の説明も受信側がその本文として選べる。answer を次の入力へ自動転送しない。構造化実行要求と継続会話の dispatch はこの接点では未対応であり、通常の通信・明示構成された別の機能の責務を変更しない。添付は現行の通信契約でも拒否される。

## 明示的な構成と呼出し

```ts
const recipient = new RecipientMessages({
  binding,             // 検証済み受信個体・所有者 scope・runtime・権限世代
  inbox, outbox,       // 同じ受信個体の既存 SQLiteInbox / SQLiteOutbox
  budget,              // 既存 SQLiteReplyBudget または同じ契約の受信側制限
  limits,
  recipient: nativePort,
  authorization,       // 現在の caller・操作・source を独立して認可
});

await recipient.handoffOnce(context, { sender_id, message_id });
await recipient.inspect(context, { sender_id, message_id });
recipient.enqueueReplyOnce(context, { sender_id, message_id });
// 配送は既存 DurableSender.sendOnce() 等の別操作。
```

import、構築、poll、保存、ACK、一覧、inbox_read から、この API を自動呼出ししない。起動側が正式な製品能力と権限を確認した場合だけ接続する。`RecipientMessagePort` がなければ `recipient_input_unsupported` となり、モデルや特定製品 runner を代用しない。

`handoff` / `inspect` / `reply` は別権限で、source は sender ID と message ID の組。認可 callback は同期で、検証済み context から agent ID、actor ID、authority epoch を返す。既定拒否、別個体・世代不一致・操作途中の actor 変更を拒否する。pause や process owner を用いる構成では、その現時点の検査もこの callback に組み込む。新しい停止・owner・credential 管理は作らない。本文や表示名から context を構築しない。

## 外部入力と不明結果

ACK 確認済みの未 release 本文だけを `SQLiteInbox.withEntry` で検証して copy する。読取り中に非同期処理や network を始めない。渡す入力は常に `origin=external_agent`、検証した固定 binding、source、保存された message。外部本文は所有者の直接指示、承認、runtime 設定、session 選択として扱わない。実際の入力 API でも外部発信の区別を保持する責任は native port にある。

key は owner scope / agent / runtime / sender / message の組から固定する。内容は既存の正規比較形式の hash で照合する。初めに native 側の同 key の記録を照会し、**明示的に不存在の場合だけ** `admit` を呼ぶ。照会失敗と応答消失は unknown であり、新 ID の受付やモデル再実行に置き換えない。新 process も同じ key を最初に照会する。並行する別 instance の同 key 受付は native 側の原子的な重複排除が必要である。

Native port は入力の durable admission commit 内で渡された `check` を呼び、key と内容を一意に結び付けてから、自分の既存の制限・policy で処理する。応答後の caller 検査だけでは古い権限での受付を取り消せない。`check` はその呼出し終了時に失効するため、後続処理の権限は native 自身が現在の policy で確認する。保存後に provider/model の結果が不明になったら、その unknown を保存し、不存在に戻さない。未実行と確認できない処理を再実行しない。保存容量、処理数、待機期限、モデルの費用や実行権限は受信側が制限する。この実装は第2の Task engine、native journal、承認 UI を追加しない。

key の runtime ID は永続的な同一性であり、再起動で新 ID を作って重複排除を回避しない。backup 復元・binding の移動・権限世代の変更は既存記録と外部効果の照合を必要とする。epoch は key に含めず、native 側は古い権限世代の非終端記録を保留して現在権限を再確認する。この port は巻戻しや外部副作用を検出する仕組みを代行しない。

## 受信側の判断と必要な承認

状態は `accepted` / `processing` / `waiting_owner` / `reply_ready` / `declined` / `unknown`。不存在の読取りは `not_started`。これらは受信側 API の報告であり、Task 完了、配送、表示、人間の既読を証明しない。送信側に状態を公開する新 API は追加しない。返却値には本文、下書き、承認 ID、token や内部例外を含めない。

受信エージェントが返答、追加質問、拒否、保護操作の承認依頼を選ぶ。`waiting_owner` を sender から解除する操作はない。Native port は受信側の既存 policy に必要な承認が満たされるまで、下書きを返信として供給しない。既存権限で許可済みの返信には一律の承認を追加しない。実ファイル・shell・外部送信等の実行は製品の既存機構で行い、この接点は実行要求から権限を作らない。

返信 envelope（ID、本文、宛先、相関、初回送信時刻、配送期限）は native 側が先に durable に固定する。`withReply` は同期で、現在の権限・必要な承認を検証する `checkReply` とその exact envelope を供給する。承認を必要とする構成では、承認の保存・失効・消費・不明 handoff の照合も native 側が担当し、同一 envelope の再照合以外には再利用できないようにする。単なる `reply_ready` や本文の「承認済み」は許可にならない。

`enqueueReplyOnce` は元送信者、source、thread、answer、テキスト形式を検査し、既存 reply budget の予約と `SQLiteOutbox.enqueueGuarded` を通す。outbox の commit 境界でも caller と native の現在許可を再検査する。別本文・別宛先・別相関へ置換しない。既存 budget 予約や outbox commit の直後に応答を失っても、同じ envelope だけで照合する。本文を release せず、同じ inbox を保持する。outbox の保存期限・容量・重複排除・送信直前の現在認可は既存実装と構成側の責任である。

`reply_queued` は outbox 保存の結果で、送信成功ではない。RPC や native 入力を待っている間は、その instance の次の操作を拒否する。内部 timeout で枠を強制解除しない。native API は有限の応答と不明結果の durable 照合を提供しなければならない。

## 検証したことと未接続の部分

`NODE_NO_WARNINGS=1 node --test test/recipient-messages.test.js` は、実 SQLite inbox / outbox / reply budget と、合成の native 入力・policy store で、明示引渡し、承認待ち、不要な一律承認がない経路、失効、世代、source/宛先、改変、二重受付、返信の再照合、同一 process 内の DB close/reopen を検証する。実 loopback HTTP MCP の受信・保存後 ACK・明示引渡し・返信保存・送信・相手の poll も通す。Task link は生成しない。

合成 native store はテストだけに存在し、モデルも実所有者承認 UI も呼ばない。実製品の wake、入力、正式な session binding、durable な重複排除、承認の実効性、backup 復旧、常駐は未検証。Hermes / Dots / その他の製品向けの port はまだ同梱しない。これらの正式 API がない製品では、本変更で自動判断・自動返信の接続が完成したとは扱わない。

## 現行アーキテクチャとの関係

#137 と #140 を含む main `d0506828f8568cecc68b12893adefe6b341117d7` に統合する。通信契約は `src/messaging`、durable client・inbox・outbox は `src/agent-sdk`、配送は NATS JetStream に従う。SQLite は受信側の inbox / outbox / reply budget と合成 native store に使用し、廃止済みの SQLite 配送backendを復活させない。

この接点と adapter-host / answer-intents は、既定runtimeに配線しない明示構成のローカル部品である。`RecipientReplyAdmission` は受信側が供給する同期契約であり、テストでは現行 `SQLiteReplyBudget` と `AdapterHostCycle` を明示的に構成する。実製品の native port を実装した、または既定の受信で自動実行・返信するという意味ではない。統合後のテストは Node 26 と固定バージョンの実 NATS broker を要する。最新の実行結果は当該 head の検証記録を参照し、過去の SQLite 配送試験や旧 root 件数を現在の成功証拠とみなさない。

## 明示 opt-in の共通 owner supervisor

`src/recipient-messages/supervisor.ts` の `RecipientSupervisor` は、正式な native port を持つ受信側が明示的に選ぶ共通 orchestration である。受信専用 `ReceiveSupervisor` や Relay の通常 MCP catalog は変更しない。import / constructor は IO を開始せず、`run(signal)` だけが既存 host の receive → source 別の inspect / 必要時 handoff → 確定返信の enqueue → send を繰り返す。モデル、製品 runner、新しい状態 journal、権限発行、ログイン、承認 UI は追加しない。

```ts
const owner = new RecipientSupervisor({
  version: 1,
  host, hostContext,              // 既存 AdapterHostCycle、同じ held process owner
  messages: {
    binding, inbox, outbox, budget, limits,
    recipient: nativePort, authorization,
  },
  recipientContext,
  sources: () => currentlyAuthorizedSources(), // trusted 同期選択、最大100件、重複なし
  observe: (state) => updateLocalStatus(state), // 同期・metadata-only、権限ではない
}, {
  interval_ms: 1000,
  drain_timeout_ms: 5000,
});
await owner.run(stop.signal);
```

構成側は host と messages に**同一の inbox / outbox / budget / agent・owner**を渡し、既存の process owner を保有したまま、承認済みの host resume 後に開始する。この supervisor と受信専用 supervisor を同じ host 上で並行起動しない。`sources` は現在許可した source を返すだけで、本文、表示名、送信者の「許可済み」を authority に変えない。上限を超える場合の公平な選択は所有者側が行う。全件走査・無制限の queue や容量 reset は追加しない。各 source の本文・ACK・署名・現権限は既存 `RecipientMessages` が再検証する。

既存 native 入力は `inspect` 権限で照合し、明示不存在の時だけ `handoff` を使う。確定返信には独立した `reply` 権限と native の現在許可が必要であり、handoff 権限の消費を返信拒否に置き換えない。inspect / admit / reply の既存 check 内にも host の現在 pause / held owner / 同一 epoch を組み込み、途中の pause→resume でも古い操作を続行しない。新規入力の受付後は引き続き native 自身が現在権限を管理する。

poll / ACK の一時的な transport 障害でも、すでに ACK 済みの source と既存 outbox は進められる。未確認 source は独立して拒否される。受信・送信の再送 ID、ACK journal、backoff、lease と unknown の照合は既存 host / inbox / outbox が担当する。native unknown を不存在に変えたり、新 runtime ID・返信 ID を作って再実行したりしない。周期は明示設定した有限間隔であり、native のモデル費用や実行回数の制限ではない。

`observe` は native の `accepted / processing / waiting_owner / reply_ready / declined / unknown`、outbox 保存時の `reply_queued` と `outbox_state`、ローカル拒否の `blocked` と既知の安全な reason だけを通知する。`accepted` は native 入力受付、`waiting_owner` は native が報告した判断待ちである。HAB の受信済みをこの2状態に読み替えない。outbox の `accepted` も Relay 受付であり、相手の受信・ACK・既読ではない。通知は永続記録や送信側 API ではなく、再起動後は元の native / outbox から照合する。observer を承認や後続実行の根拠にしない。

停止は新しい操作を止め、現在の native 呼出しが実際に戻るまで待つ。native 呼出しを timeout で切り離して次の instance を起動しない。host の未完了 IO は有限 drain を行い、`drained=false` なら所有権と store を保持する。停止時に pause / revoke / owner release / journal reset を自動実行しない。source 拒否は `blocked` として他の許可済み source を妨げず、owner・host の不明状態は全体を停止する。

native port がなければ構築時に `recipient_input_unsupported`。MCP 接続・常駐受信・表示専用 feed だけで自動対話可能とは判定しない。別 process の API を呼ぶ前後だけの認可確認は、native admission / outbox commit 内の同期 check を満たさない。正式 API と同じ保護範囲で現権限と exact reply を保証できない製品は、未接続のまま扱う。

`test/recipient-supervisor.test.js` は実 SQLite / JetStream / loopback MCP と合成 native port により、一連の自動巡回、restart の同一 key 照合、独立権限、pause 世代、停止・drain、ACK / submit 応答消失、poll 障害中の返信、状態の区別と例外情報の除去を検証する。既存 root question / notice の範囲、返信上限・容量上限を拡張しない。Hermes / Dots の正式 native port、継続会話の dispatch、native 承認、実製品での自動起動・自動返送・常駐を立証する試験ではない。
