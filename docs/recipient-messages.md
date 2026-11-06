# 受信後のエージェントへの引渡し

`src/recipient-messages/` は、保存済みメッセージを受信エージェントの既存入力経路へ渡し、その確定返信を既存 outbox に保存する、明示構成のローカル API である。[ADR-015](hab-decisions.md)、[共通 MCP 接続](common-mcp-connection.md)、[受信側の実機準備](recipient-readiness.md)に従う。通常 MCP の5操作、受信 supervisor、Task の状態や既存製品設定は変更しない。

現在の対象は `in_reply_to=null` のテキストだけの question / notice。返信は question に対するテキスト answer だけで、追加質問や対応不能の説明も受信側がその本文として選べる。answer を次の入力へ自動転送しない。構造化実行要求、添付、継続会話の dispatch はこの接点では未対応であり、既存通信では引き続きデータとして保存される。

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

## #137 との関係

実装基準は main `3e203d7ea210013207a5380a6f08190d8f4e6a9e`。未マージ #137 の head `599c1f2b8552e7b475ef917477ab0b03e1e5aa10` は durable client を `src/agent-sdk` へ移し、adapter-host / answer-intents 等を deferred として除外している。本変更はそれらを編集せず、独立した受信側構成に置く。#137 統合時は contract / inbox / outbox の import を移動先へ合わせ、受信側の reply admission 実装とテスト構成を選び直して再検証する。#137 にこの機能が含まれる、または #137 上で検証済みとは主張しない。
