# 常用MCP接続：参加承認と短命token

常用接続は設定・接続・grantを保存して使い続けます。送受信の確認後に自動で削除しません。
access tokenの期限をなくすことや、認証失敗を匿名接続へ切り替えることではありません。
Relayは更新資格情報を保管・発行せず、各hostの標準OAuthクライアントが更新を担います。
配送は引き続き共通MCPの5操作です。外部実行APIや製品名による配送分岐を追加しません。

## 明示的な常用設定

既存OAuthファイルの`version:1`は、tokenも接続窓も最大15分という有限試験の契約を維持します。
自動移行や期間の自動延長はしません。[常用設定の例](../config/relay-oauth-persistent.example.json)は
`version:2 / mode:persistent`を明記し、未設定時は無効・全拒否です。

```json
{
  "version": 2,
  "mode": "persistent",
  "enabled": false,
  "issuer": "https://example-tenant.jp.auth0.com/",
  "resource": "https://relay.example/hab/mcp",
  "max_access_token_lifetime_seconds": 600,
  "keys": [],
  "connections": [{
    "subject": "verified-owner",
    "client_id": "verified-public-client",
    "connection_id": "approved-connection",
    "approved_at": "2030-01-01T00:00:00.000Z",
    "approved_until": "2030-01-31T00:00:00.000Z",
    "state": "active"
  }]
}
```

日時・主体は説明用です。本番へコピーせず、人間が承認した実値を設定します。
公開RSA鍵のpin、正規resource、本人所有・0600・canonical pathなどのファイル境界は
[OAuth入口](relay-oauth-ingress.md)と同じです。AT/RTやclient secretはこの台帳に置きません。

| 対象 | コードの契約 | 本番値の選択 |
| --- | --- | --- |
| 参加承認 | 明示した`approved_at <= now < approved_until`だけ有効。有限で終了が開始より後 | 初期案は30日。1日・7日・365日なども設定可能で、30日が強制上限ではない。実値は別途承認 |
| access token | 署名・issuer・単一audience・主体/client・5scope・iat/nbf/expを検証 | 既存600秒を推奨。設定値は1〜900秒で、900秒超や無期限は拒否 |
| refresh token | Relayは受け取らず、hostとissuerが保管・回転・更新を担当 | 初期案は回転あり・絶対30日・未更新7日。issuer/client/hostの実対応と具体承認が必要 |

表は推奨案と設定能力の区別です。設定例やテストの30日を、ユーザーが本番期間として
承認したとは扱いません。参加期間終了後も接続設定は残ります。人間が再承認しない限り
利用を拒否し、refreshで参加期間を自動延長しません。

参加期間中は、開始15分後を過ぎても新しい短命ATを同じ接続/グループへ解決します。
旧ATは期限切れで拒否します。参加終了直前のATが参加終了を越えていても、context期限を
`min(token.exp, approved_until)`へ切り詰め、参加終了時に必ず拒否します。
新ATの`iat`は参加開始以降である必要があります。署名検証のawait中の設定変更も拒否します。
観測済みの取消後に元の設定内容へ戻しても、以前のopaque contextは復活しません。

## 登録・状態確認・明示的な失効

操作者が検証した主体を参加descriptorへ設定し、既存`relay:admin connect`で承認した
アドレスへbindingします。JWT更新ごとにアドレス・connection ID・bindingを作り直しません。
同じ認証を共有するBotはグループ内の信頼境界を共有し、グループ外の名義・受信・ACKは拒否します。

`relay:admin status`はv2で`participation`の開始/終了/状態/残秒と
`max_access_token_lifetime_seconds`を分けて表示します。ATを読まない管理CLIは、
実ATの期限やrefreshの成功を知りません。v1/localの`expires_in_seconds`表示は従来どおりです。
`participation_expired / participation_not_yet_active / participation_revoked`を別に診断し、
その状態のv2 descriptorによる`connect`は拒否します。

停止や漏洩時は次のように明示的に失効します。これは通常の送受信確認後の自動cleanupではありません。

1. 参加descriptorの`state:revoked`または入口の無効化で、新規認証と既存contextを止める。
2. 保管鍵を保持して公式`relay:admin disconnect`を実行し、Registryのbindingを失効する。
   mappingがなくても実行可能。同じグループの全memberへ影響するので対象を確認する。
3. 対象hostの接続とissuerのRT/grantも取り消す。RT取消だけでは発行済みATの即時拒否を保証しない。
4. 設定・DB・失効予約・監査を保持する。失効済みconnection IDで再bindingしない。
   再参加は人間の承認後に新IDを発行・bindingする。無関係な接続/秘密/サービスは削除しない。

## 保存・再起動・移行

OAuthファイルのversionとRegistry DBのversionは別です。OAuth v2自体に新しいDB schemaは
ありません。既存の接続fingerprint/アドレス/ACK receiptをそのまま使います。
認証グループを有効にする場合だけ既存Registryの明示v1→v2移行が必要です。
再起動後は保存済み参加設定を再検証し、古いopaque contextを引き継ぎません。AT/RTの
永続保管と再起動後の更新はhost側の受入れ項目です。

既存runtimeへ反映する前に、停止したDBと対応する鍵・設定・releaseを整合した一組として
backupし、`store.agent_capacity`と起動パスを照合します。新しい仕事を受け入れる前なら
停止backupからDBと元設定を一緒に復元できます。Registry v2を旧binaryへ直接開かせたり、
schema番号だけを戻したりしません。新規受付後に古いbackupを上書きし、受領/失効履歴を
失うrollbackはしません。保全して照合またはforward fixします。

時計逆行は同一authorityの新規認証・context再検証を拒否します。再起動を越えた信頼できる
壁時計の保証をこの変更は追加しません。hostの時計管理・鍵の更新運用は別途確認します。

## Dots / Hermesの常用接続を適用する前に

| 対象 | 具体化して承認する差分 | 保管・期間・取り消し |
| --- | --- | --- |
| Dots | 既存公開resourceへの正式クラウドMCP接続。provided public client/none、Relay5scope。refreshを使う場合だけ追加`offline_access`を明示 | ChatGPTの正式接続ストア。実callbackを管理画面で確認。接続/grantは維持し、停止時に対象だけ切断/失効 |
| Hermes | 既存MCP定義を標準OAuthへ変更。loopbackのBearer入口へJWTを送らず、正規OAuth resourceを使用。別グループにするなら別public client | 選択profileの`mcp-tokens/<server>.json`等。親0700/ファイル0600。同じOSユーザーから読める。初回login・RT保存は別承認 |
| Auth0 | 対象clientのRefresh Token grant、APIのAllow Offline Access、回転と絶対/idle期限。既存の権限を広げず5scopeは維持 | token自体をRelay/公開repoへ保存しない。public clientへsecretを追加しない。RT取消とRelay側の失効を組み合わせる |
| Relay | OAuth v2の参加実値、承認済み主体/client、既存group binding、採用releaseと起動設定 | 既存private設定0600。AT更新で書き換えない。停止/明示失効の手順を検証 |

`offline_access`はRT取得のための追加認可で、Relayの配送操作を増やすscopeではありません。
この変更自体はどのgrantも有効化しません。cloud登録フォームは接続用pluginを作成する
場合があり、既存portable packageの更新と区別します。登録IDやcallbackを推測せず、
同一hostでbundled MCPと登録済み接続を二重ロードしません。

Hermesの標準OAuth sourceでは、指定clientと固定`redirect_port`からloopback callbackを
構成できます。実際の選択profile・port・URI・SDKの互換性を適用前に確定します。
MCPの接続/更新だけでは常駐受信になりません。各hostの受信起動、inbox/outbox保存、
保存後ACK、再起動時の照合、費用・頻度・停止条件を別に受け入れます。

## 模擬検証と未検証

```sh
node --test test/relay-oauth-auth.test.js test/relay-oauth-participation.test.js
node --test test/local-relay-participation.test.js test/local-relay-admin.test.js
```

合成署名JWTで20分後の更新、期限境界、取消、署名鍵変更、設定競合と時計逆行を検証します。
configured Relay/公式管理処理と共通MCP clientを使うloopback試験では、共有グループ、
期限切れATから新ATへの切替え、往復・双方の保存後ACK、再起動後のreceipt/アドレス保持、
失効の保持、停止backupからの受付前復元を確認します。既存サービスや認証は使いません。

これは実Auth0のRT発行/回転、実Dotsのtools露出、実Hermesとの往復、常駐/自動復旧の
完了を証明しません。実機の本番設定・grant・接続作成・deployは別の具体承認後に行います。
実機で接続できた後は常用構成を残します。

## 一次資料

- [Auth0: refresh tokenの取得条件とpublic client](https://auth0.com/docs/secure/tokens/refresh-tokens/get-refresh-tokens)
- [Auth0: rotationの設定](https://auth0.com/docs/secure/tokens/refresh-tokens/configure-refresh-token-rotation)
- [Auth0: 絶対/idle期限の設定](https://auth0.com/docs/secure/tokens/refresh-tokens/configure-refresh-token-expiration)
- [OpenAI: クラウドMCP接続と検証](https://developers.openai.com/plugins/deploy/connect-chatgpt)
