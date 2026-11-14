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
| paused-by-default | 各hostはowner取得後もpaused。送信を開始しない |
| ambiguous-send | delivery commit後に送信応答を失わせ、senderは不明結果を保持。sender statusは受付済み |
| ambiguous-ack | inbox保存後、server ACK commit後の応答を失わせ、未確認の元ACKを保持 |
| cold-start | 全host・host／registry／enrollment DB・listenerを閉じて再構成。同じ個体、保存済みpaused、ownerを確認 |
| same-id-recovery | 明示resume後、同じ送信ID・receipt・元ACKで復旧。追加配送を作らない |
| reply-intent-restart | 質問への回答を先に保存して原質問本文をrelease。返信journalを開き直し、未確認一覧の元ID・本文・期限でoutboxへ引渡し |
| reply-roundtrip | 元質問への回答をMCPで送信し、相手のdurable inbox保存・ACKとsender statusで確認 |
| offline-store-forward | 受信hostがpausedでもhostへ蓄積。resume後に受領・ACK |
| execution-request-inert | execution_requestを配送・保存・ACKしても受信hostは実行しない。本文は受信者のinboxに残り、送信者のstatusはacked |
| loop-denial | 受け取った回答への自動answerを拒否し、追加intentを作らない。質問にshell要求の文字が含まれても本文を実行しない |
| stopped | 全hostをpauseし、未完了workがないことを確認してownerを解放 |

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

mcp_toolsにはhab_resolve／submit／status／poll／ackの5種が並び、auditには固定categoryの件数だけを返します。本文・指紋・token・実行パスは出力しません。4配送は質問・回答・不在時通知・実行依頼です。MCPの双方の状態と、最後のDBの配送／ACK receipt件数を照合します。

## 保存と再開の境界

各個体は同じIDへbindingした専用owner、control、inbox、outbox、共通返信budget、質問返信intentを使います。ownerの取得はresumeの許可を兼ねません。

reopen時は新しいDB handle・host・clientを作り、登録checkpoint、永続停止状態、未確認ACK／送信、質問返信のpendingを読み直します。回答本文を会話contextから作り直して渡しません。

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

この一覧の未確定値を推測して接続・credential発行・課金・公開へ進めません。現在の完了は、ローカルMVPの再現手順・模擬往復・失敗復旧と、その検証済みコードです。

新規question／notice／execution_requestの投入も、共通hostの明示的な `message_enqueue` を通します。デモからoutboxへ直接投入せず、認可・停止・所有権を確認した保存と、別のsend命令によるHTTP送信を分けて検証します。返信は従来のsource別intent／budgetを使います。
