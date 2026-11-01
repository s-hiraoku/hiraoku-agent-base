# 配送テストの境界と設計判断

利用者は `npm run test:delivery-lab` を実行し、最後の判定と証拠pathを読む。`--full` はbuildと既存全JS回帰を追加する。`--release` は全回帰を必須にし、未実装backendと未合意の受入条件でBLOCKEDになる。

共通テストはHABの配送互換adapterを呼ぶ。A2AとJetStreamのnative protocolを同じAPIとみなすものではない。

```js
const fixture = await backend.create(t);
const input = fixture.message("b");
await fixture.transport("a").submit(input);
await fixture.receiver("b").once();
assert.equal(
  (await fixture.transport("a").status(input.message_id)).state,
  "acked",
);
```

```text
DeliveryFixture
  agent(name) -> immutable agent ID
  message(to, patch?) -> HAB Submission
  transport(name) -> async submit, status, poll, ack
  receiver(name, transportPatch?) -> once, entries, close
  restart, disconnect, reconnect -> Promise<void>
  faults.ackRetryDue(name), faults.leaseExpired() -> void
```

`backends.js` は既存journey fixtureを包み、enrollment、Registry、loopback HTTP、SQLiteを再利用する。endpointを開き直すたびにclientを作るので、restart後のURLを古いclientへ固定しない。SQLiteのpage capやclockの置換は `sqlite-failures.test.js` だけが所有する。

`manifest.js` は未実装backendと移行保留条件を記録する。共通テストのskip理由とrunnerのblockerは同じ定義から読む。runnerが各process、log、source inventory、一時DBの所有者になる。`gateVerdict` は期待するgroup集合、exit code、TAPの失敗/skipを判定する。

## 比較した構造

| 案                                    | 隠せる複雑さ                                        | 採否                                                                              |
| ------------------------------------- | --------------------------------------------------- | --------------------------------------------------------------------------------- |
| 通常のasync scenarioとbackend adapter | identity、endpoint再生成、保存と障害注入のbackend差 | 採用。8ケースを通常のassertで読める                                               |
| 宣言的action/event列とinterpreter     | async順序とhandle管理                               | 不採用。別の状態機械と言語を増やし、製品とinterpreterが同じ誤りをする余地が増える |
| 既存suiteの一覧だけを実行             | 現在の起動方法                                      | 不採用。将来backendが同じassertを通る比較基準が残らない                           |

独立候補A/B/Cは同じadapter構造を推奨した。親の評価もcross-judgeと一致し、Cを基礎にした。評価は実挙動の比較、隔離とcleanup、不完全なrelease拒否、実行ソースとlog、interfaceの小ささの5項目。候補スコアはAが8/10、Bが9/10、Cが10/10で、測定値ではなくレビュー判断である。

Cからreleaseの全回帰必須化と期待group検証、Bからbuild/cleanup失敗の保存と実子process試験、Aから純粋metadataへの一元化とsource hashを取り込んだ。D01の受信sender照合もcross-judgeの指摘で加えた。新しいDSLや汎用process監督機能への拡大は避けた。

## 検証の限界

Model the Domainをbackend表と判定状態に、Test Behavior, Not Implementationを公開配送操作と独立inboxの照合に、Prove It Worksを実HTTP・SQLite FULL・子process終了の検証に適用した。これらのleaf skillは実際に読んだ。

今回の設計比較は初期コード作成後である。pstack更新保留が解除されてからhow、architect、arena、no-commentsを使い、不足を修正した。事前にworkflow全体を完了したとは扱わない。モデル設定は全laneがnative `inherit-parent` で、独立contextによるレビューはしたがprovider/model familyの多様性は増えていない。raw transcriptの検証済みpathはなく、判断記録の監査は限定session digestと実ファイルによる。

証拠の原文は専用checkoutの `.lab/pstack/` に残す。設計案とレビューはコードを変更しておらず、製品テストの成功証拠には数えない。試験結果は各 `.lab/run-*/report.json` とTAPを読む。異なるgroupには重複する既存テストがあるため、合計をunique件数と呼ばない。
