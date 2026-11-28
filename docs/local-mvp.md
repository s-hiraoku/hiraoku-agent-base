# HAB ローカルMVP：起動・送受信・停止・再起動確認

[README](../README.md) · [正式仕様のゲート](hab-messaging-spec.md#20-導入と受入れゲート) · [受入れ表](history/mvp-acceptance.md)

**このMVPの完了条件は、モデルなしの模擬3個体で登録→MCP配送→返信→停止→永続状態からの再開→実行依頼を保存だけして実行しないことを、一つの有限コマンドで再現できることです。** 実Grok・Dots・Hermesの接続や、全DBの整合backupを含むG1全体の受入れとは分けます。

## 起動

Node 26以上で、このrepoを新規cloneした作業ディレクトリから実行します。配送はhostのSQLite配送store（[ADR-018](hab-decisions.md)）で行うため、別processは不要です。

```sh
npm ci
npm run demo:hab-mvp -- --simulate
```

成功時はexit 0でJSONを返します。コマンドは実行のたびに0700の新規一時ディレクトリを作り、明示migrationで専用DBを準備します。127.0.0.1の空きportで専用MCP listenerを起動し、終了時に停止・DBを削除します。固定portの既存server、Hermes、cron、認証、既存checkoutのruntime DBは変更しません。

引数なし・未知引数・任意URL指定では、作業状態を作る前にUsageとexit 2を返します。30秒の有限deadlineがあり、Ctrl-C／SIGTERMでは開始済み処理を止め、自分のlistenerと一時状態を片付けてexit 1を返します。OSによる強制終了や電源断は一時ファイルの削除まで保証しません。専用ownerのOS lockはprocess終了で解放されます。

実行結果を保存したい場合は、個人用の作業領域へstdoutをredirectします。通常のnpm表示も含まれるため、JSONだけが必要なら次を使います。

```sh
node scripts/hab-mvp-demo.mjs --simulate
```

実運用credential、実メール・予定・会話を引数や一時DBへ渡す入口はありません。ダミー主体・固定の模擬認証・合成メッセージだけを使います。HABのproduct名は配送先の認証には使いません。

## 13段階の合格条件

| JSONのstage id | 確認する結果 |
| --- | --- |
| enrollment | 実登録workflowで3個体を登録。同じ製品の2個体を含み、アドレスは別々 |
| auth-denial | 認証なし・未知の模擬Bearerは401 |
| send-question | `/mcp` の `hab_send` で質問（shell要求文字列を含む非信頼本文）を送信し、受付状態 `pending` を確認 |
| peek-unread | `/mcp/delivery` の `hab_peek` で未読を既読にせず確認。送信側の `hab_status` は `pending` のまま |
| cold-start | hostのSQLite DB（registry・delivery・enrollment・owner）とHTTP listenerを閉じて再構成。登録と未読が保持されることを確認 |
| inbox-read | `/mcp` の `hab_inbox` で未読を読み込み既読化（`acked`）。非信頼枠付き `notice` と `presentation`、`reply_state: "waiting"` を確認 |
| reread-retention | 既読になったメッセージを `message_id` 指定の `hab_inbox` で7日保持期間内に再読できることを確認 |
| reply-roundtrip | `/mcp` の `hab_reply` で同一threadへ `answer` を返信し、送信元が `hab_inbox` で既読化、`hab_status` が `reply_state: "replied"` になることを確認 |
| offline-store-forward | 不在の受信者宛てに `hab_send`（`notice`）を蓄積し、後続の `hab_inbox` で既読化されることを確認 |
| execution-request-inert | `/mcp/delivery` の `hab_resolve`＋`hab_submit` で `execution_request` を配送し、`hab_peek`＋`hab_mark_read` で既読化しても実行されないことを確認 |
| same-id-idempotency | 同じ `message_id` の `hab_submit` 再送が同一の `receipt_id` を返し、重複配送を作らないことを確認 |
| boundary-denials | 他送信者の `hab_status` 参照拒否（`not_found`）と不正対象への `hab_reply` 拒否（`reply_target_not_found`）を確認 |
| stopped | 配送件数・既読件数・ACK receipt件数が4件で一致することを確認し、listener停止・owner解放を完了 |

JSONの期待する要点は以下です。実行ログそのものを公開repoへ保存する必要はありません。

```json
{
  "scope": "synthetic-loopback-mvp",
  "production_connected": false,
  "counters": {
    "deliveries": 4,
    "acked": 4,
    "ack_receipts": 4
  },
  "cleanup": {
    "server_closed": true,
    "temporary_state_removed": true
  }
}
```

mcp_toolsには実際に呼んだ `hab_inbox`／`hab_mark_read`／`hab_peek`／`hab_reply`／`hab_resolve`／`hab_send`／`hab_status`／`hab_submit` が並び、auditには固定categoryの件数だけを返します。本文・指紋・token・実行パスは出力しません。4配送は質問・回答・不在時通知・実行依頼です。MCPの双方の状態と、最後のDBの配送／ACK receipt件数を照合します。

## 保存と再開の境界

hostは単一のownerロックとSQLite DB（`registry.sqlite`・`delivery.sqlite`・`enrollment.sqlite`）を管理します。ADR-036で第1世代のローカル `AdapterHostCycle`・返信budget・質問返信intentを廃止したため、MVPは現行のメール型 `/mcp` と `/mcp/delivery` の実HTTP往復を検証します。

reopen時は新しいDB handle・host listenerを作り、登録済み個体と未読メッセージをディスクから読み直します。

これは**保存済みDBのclose／reopen**です。過去のbackupへのrollback、ディスク喪失、任意のDB単独restoreからの自動再開は行いません。整合世代を揃えたbackup／restoreの全host profileは未完了です。

## 継続検証

`test:hab-mvp`と`npm test`も同じ一時SQLite配送storeを使い、外部processを必要としません。

```sh
npm run test:hab-mvp
npm run lint
npm run typecheck
npm test
```

MVPの5テストは、上記CLIそのものの13段階、引数拒否、import時の無副作用、開始前abort、SIGTERM中断時のcleanupを確認します。通常のnpm test・CIにも含み、MVP scriptをlintの対象に加えています。配送・公平性等の回帰も続けます。補助的なHAB MCPの手動検証は[verify-hab](../.claude/skills/verify-hab/SKILL.md)で行えますが、MVP CLIの合格を別入口の検証だけで代用しません。

## 新規導入時の依存確認

2026-10-24のクリーン導入で既存lockfileの脆弱性通知を確認し、Zodを4.6.7、body-parserを2.4.0、fast-uriを3.1.9、ip-addressを10.7.4へ更新しました。[Zodの上限検証修正](https://github.com/colinhacks/zod/commit/a0ebf970f2d752e5f58527cd2942ff48be4f46bd)、[body-parserの修正対象](https://github.com/expressjs/body-parser/security/advisories/GHSA-27r3-jxmh-p828)を確認しています。

2026-11-12にMiniflare・D1・Drizzle・esbuildを依存から外したため、Undiciのoverrideも削除しました。依存監査は実個体接続の受入れやplatform全体の安全性の証明には使いません。

## 未検証ゲートと実接続の条件

このMVPの各アドレスは、自分だけが所属する認証グループで接続します。実接続では[認証グループ設計](auth-groups.md)に従い、本人が承認したグループ単位の認証とアドレス単位の配送名義を確認します。共有認証によるグループ内のBot専有性は保証しません。

| 対象 | 次に確認／承認が必要な内容 |
| --- | --- |
| G0 実Grok・Dots・Hermesの各個体 | 認証済み接続／グループと所属アドレス、選択名義の固定、送信前の永続保存、再送契機、受信inbox、poll／wakeの実能力。共有subjectや選択名義をBot本人の専有実行の証明にはしない |
| 本番host入口 | 接続先URL・port／path、公開の有無、認証issuer／audience、認証済みclient／connectionとグループ／アドレスの対応、proxyのheader保持を確定。MVPの一時portや模擬tokenは転用しない |
| 最初の実通信 | 対象の個体と相手を特定し、無害な固定テキストのquestion／answer各1通、resolve／submit／status／poll／ackだけの権限、停止条件・保存場所を確認して承認 |
| 新規認証・永続起動 | credential／OAuthの発行・scope、保存先・有効期限、実daemonやcron、既存設定変更は個別確認。MVP実行の承認から引き継がない |
| G1全体・運用 | 全hostの整合backup／restore、運用policy・監視・実負荷・全入口のowner適用。既存部品のテスト合格と運用受入れを分ける |

この一覧の未確定値を推測して接続・credential発行・課金・公開へ進めません。現在の完了は、ローカルMVPの再現手順・模擬往復・再起動確認と、その検証済みコードです。
