# Auth0 / Hermes 接続の復旧手順

既存の承認済みMCP接続を復旧する操作者向け手順です。
[常用MCP接続](persistent-mcp-auth.md)の参加承認・短命token・host側更新の分離を維持します。
新しい主体の登録、scope追加、参加期間延長、匿名接続、常駐の自律返信を有効にする手順ではありません。
実環境の識別子・token・ログ本文はこの文書や公開issueへ貼りません。

## 何が切れたかを先に分ける

| 対象 | 期限・拒否の意味 | 復旧の担当 |
| --- | --- | --- |
| access token (AT) | JWTの`exp`まで。Relayの設定上限と実`iat/exp`を別々に確認する | Hermesの標準OAuth clientがrefresh可能なら新ATを取得する |
| refresh token (RT) | issuerの最大・idle期限、取消、rotation/reuse検知など。ATの`exp`やRTファイルの存在から有効期限は分からない | 元のissuer/clientで更新。更新資格が使えない場合は本人が再認証 |
| ブラウザーのログインsession | Auth0や上流IdPへの再ログイン要否。AT/RTやHAB参加期間とは別 | 本人が既存アカウントでログイン |
| HAB参加承認・binding | `approved_at / approved_until / state`とRegistryの現在状態。RT更新で延長・復活しない | 正規の管理画面・CLIで確認。変更が必要なら別途承認 |
| receiver process | `running`やLISTENは認証・受信成功の証拠ではない | native whoami、実受信保存・ACKで確認 |

有効期限内のATを送っても401になる場合、単なる期限切れと決めつけません。
Relayは署名・issuer・resource・scope・時刻・主体/client・参加承認を検査します。
同じメールアドレス、同じclient、同じ表示名だけでは`subject`の一致を証明できません。

## 1. 送信を止め、既存の一件を保全する

送信前のintent、受理receipt、受信inbox、未確認ACKを元のID・本文・宛先・期限とともに保持します。
認証復旧のたびに新しいmessage IDを作って再送しません。受理済みならstatusから照合します。
未確認ACKは保存済みの要求とreceiptを照合し、期限切れのleaseを新しい要求と混同しません。
未送信intent自体の期限が過ぎた場合だけ、未送信を確認して新たな一件を準備します。
submitを試みた後のtimeoutやreceipt欠落は「未送信」ではなく結果不明です。
送信attempt journalと同じIDのstatus・元の要求を照合するまで、新IDへ置き換えません。
HABのDB、鍵、接続設定、token cacheを一括削除してやり直す方法は使いません。

### 新しい試験intentの生成と送信前検査

試験producerは時刻を一度だけ確定し、その同じ`first_sent_at`を既存の
`makeReplayBoundMessageId`へ渡します。別のclock読取りでIDや期限を組み立てません。
`rm1`の時刻が1ミリ秒でもずれると`parseSubmission`が拒否します。この契約を緩めません。
専用のoffline CLIは、operatorが選んだ非秘密のJSONと明示した契約limitsだけを読みます。

```sh
# fresh-template.jsonはrecipient_id/kind/body/thread_id/in_reply_toの5項目だけ。
# 既存のID・時刻・期限を含むintentをprepareへ渡して修復しない。
node scripts/native-trial-message.ts prepare fresh-template.json contract-limits.json new-message.json
# journalへ保存・独立再読した、送信に使う原本を直前に検査する。
node scripts/native-trial-message.ts check new-message.json contract-limits.json
```

prepareは新しい出力先だけを0600で作成し、既存ファイルを上書きしません。
checkは原本を書き換えずに`parseSubmission`と期限を検査し、不一致・期限切れで非0終了します。
失敗時はsubmitしません。成功も本人認証・権限・serverの受理を証明せず、CLI自体は送信しません。
過去のintent・journal・ID・期限を変更して再送可能にする方法には使いません。

## 2. 秘密を出さない接続診断

既存profile・server・resource・client・callbackを固定し、現在の設定を確認します。
native OAuthでinitialize、tools/list、`hab_discover(action=whoami)`を順に確認し、
選択したaddress・immutable agent ID・認証group/bindingが既存登録と一致することを確かめます。
whoamiが返すunknownなhost/session attestationやpresenceを成功へ読み替えません。

診断に保存するのは、tokenロード成否、残TTL、refresh有無、cache更新の有無、HTTP status、
公開endpoint、既存登録との一致/不一致、参加状態、transport終了結果だけです。
AT/RT、Authorizationヘッダー、callback code/state、client secret、実subjectの値や
JWTの復号全文を出力しません。未検証JWTのクレームは診断材料であり、本人認証の証明にはしません。
HTTP計測はnative SDKが実使用するclientを観測し、空の計測結果を無通信の証拠にしません。

| 観測 | 次の分岐 |
| --- | --- |
| AT期限切れ、native refresh成功、whoami一致 | 通常更新として再開。HAB側の登録変更は不要 |
| RT欠落、または`invalid_grant`など更新資格の恒久拒否 | 理由を記録して同じ既存接続の対話的再認証へ。RTの存在だけで利用可能と判断しない |
| `invalid_client`、issuer/client/resource不一致 | 既存設定・登録の整合性を調べるまで停止。別client/issuerへの切替えで回避しない |
| 429、5xx、接続timeoutなどの一時障害 | token cacheを維持し、既存clientの有限retryとbackoffで扱う。loginやRT再使用の手動ループへ切り替えない |
| 期限内ATを付けたresource requestが401 | issuer/audience/scope/時刻/鍵/subject/client/参加状態を照合。refresh失敗と断定しない |
| subject/client不一致 | 本人が正規管理画面でAuth0 User IDと既存connectionの主体を照合するまで停止 |
| 参加期限切れ・取消済み | OAuth再loginで回避しない。参加承認・取消の正式手順へ |
| callback timeout、port使用中、ブラウザー操作不能 | そのflowと待受けの終了を確認し、操作可能になってから一つだけ新flowを開始 |

subject不一致は別人やアカウント選択ミスを必ずしも意味しません。
同一人物の別Auth0 identity、account linkingや移行、既存登録との差もあり得ます。
メール一致で自動的に本人を同一視せず、現在のATへbindingを書き換えて通過させません。
本人・権限境界が変わる登録変更は対象・影響・期間を示して別途承認します。
例えば同じメールのdatabase/password identityとGoogle identityは別の`subject`です。
既存登録が前者なら、Googleで再ログインしても一致しません。本人対応を確認したうえで、
既存の正しいログイン方法を選びます。ユーザーの新規作成やaccount linkingで回避しません。

## 3. 通常の短命AT更新

選択profileの標準OAuth storageをそのまま使い、hostに通常の更新を行わせます。
tokenを別profileへコピーしたり、RTを手動でcurlへ渡したりしません。
issuerのrotation設定では古いRTの再使用がfamily全体の失効を招くことがあるため、
更新を行う各processが同じ正規storageとnativeのrefresh fenceを使うことを確認します。
native外で同じRTを使う更新処理を追加しません。

更新後は新ATの期限だけでなく、同じ既存接続としてnative whoamiが通ることを確認します。
fileのmtime更新は、どのflowが成功したか、Relayが本人を認可したかの証拠にはなりません。
期限内ATへの401でSDKが対話flowへ進むこともあり、対話要求だけではRT失効は断定できません。
Auth0の正規ログで対象client・時刻を限定し、refresh exchange成功/拒否、reuse検知、
最大/idle期限、取消や設定変更を区別します。ログ全文やtokenを公開成果物へ移しません。

## 4. 更新不能時の再認証

既存接続の再認証とprivate cache更新が承認済みであることを確認します。
既存issuer/resource/client/scope/callbackを維持し、本人が登録済みidentityとの対応を確認します。
新しいclient登録、scope追加、参加延長、別subjectへの権限付与が必要なら停止して別途承認します。

既存のHermesインストールを使う操作者のTerminalでは、対象を一件に固定します。
以下の変数は確認済みの既存値を指定し、tokenは指定しません。

```sh
PROFILE_DIR="/absolute/path/to/approved-profile"
SERVER="existing_server_key"
HERMES_HOME="$PROFILE_DIR" hermes mcp test "$SERVER"
# 通常更新で復旧せず、対話的再認証が必要・承認済みの場合のみ:
HERMES_HOME="$PROFILE_DIR" hermes mcp login "$SERVER"
HERMES_HOME="$PROFILE_DIR" hermes mcp test "$SERVER"
```

調査したHermes実装ではbrowser loginが対象serverのlocal token/client cacheを消して
再probeし、issuer metadataは保持します。事前に同じprofileの更新processと作業を調整し、
既存の固定client設定とcallbackを確認します。`reauth --all`や別serverの削除は使いません。
CLIの完了表示・tools/listだけで完了とせず、native whoamiの既存本人一致まで確認します。
callback待受けが終了した古いタブを完了してもそのflowは復旧しません。
旧flowの終了を確かめ、新flowを開始してから本人が認証を完了します。

## 5. 再起動後の復旧と受信再開

既存private storageから絶対expiryとissuer metadataを読み直して新しいnative sessionを作ります。
保存済み`expires_in`を起動時からの新しい有効期間として使いません。期限切れなら通常refresh、
更新不能なら上の原因別分岐へ進みます。再起動で参加期間、message ID、ACK receiptを作り直しません。
未確認のACKはlease期限が過ぎていても、保存済みの元要求を変えずに先に再照合・再試行します。
サーバーでACK済みで応答だけ失われた場合、同じ要求から元の成功receiptを回収して保存します。
`invalid_ack`などで未成功が判明した場合は、同じmessageの正規再配送をpollし、
新しいgeneration/leaseの本文とACK要求を別に永続保存・再読してからACKします。
pollが空というだけで、未ACKや本文消失を断定しません。

whoami一致後、元のintent/receipt/未確認ACKを照合して受信を再開します。
既存serviceの再起動が必要な場合は対象owner・in-flight処理・停止手順を確認し、
他のサービスを停止したりDBを同時に複数ownerで開いたりしません。
固定した一往復で受信保存→ACK→返信保存→ACK→両sender statusを確認します。
保存・ACKだけの常駐receiverと、モデルを起動して返信する経路は別に検証します。

## 検証と受入れ

HABの既存回帰試験を、pinned Nodeと専用の一時broker/loopback環境で実行します。
実サービス・本番credentialを試験fixtureへ渡しません。

```sh
node --test test/relay-oauth-auth.test.js test/relay-oauth-participation.test.js
node --test test/local-relay-participation.test.js test/local-relay-admin.test.js
node --test test/tools/native-trial-message.test.ts
```

前者は主体/client拒否、短命ATの更新後も同じ参加を使うこと、失効と期限境界を検査します。
2行目は設定済みMCPでの更新後の往復、再起動後のaddress/receipt保持、参加状態を検査します。
3行目は1ミリ秒進むclockでも一度しか読まないproducer、保存済みの1ミリ秒不一致の拒否、
期限境界、既存intentの修復拒否、offline CLIの上書き禁止と原本維持を検査します。
これは実Auth0によるRT発行・回転・失効、実hostの自動更新を証明しません。

Hermes側では、採用したsource revisionの標準test環境と`AGENTS.md`に従い、
`scripts/run_tests.sh`からcold-load-expiry、oauth-manager、issuer-bindingの既存試験を実行します。
本番venvへのpytest追加やraw pip/uvによる修復はせず、必要なら別のdisposable test環境を準備します。
これらのmocked refreshも実Auth0のtoken exchange成功とは分けます。

実環境の完了条件は次を個別に記録します。未実施は未検証のまま残します。

- 同じ既存本人のnative initialize/list-tools/whoami成功。
- AT期限を越えて、本人操作なしの通常refreshとwhoamiが成功。
- RTが利用不能な場合の停止・本人再認証・同じ接続への復帰。
- 既存receiver再起動後の新しい一件の保存・ACK。process runningだけで閉じない。
- 常駐モデル応答を使う場合は、その起動・権限・費用・停止・重複処理防止を別途受け入れる。

実施時刻、source revision、試験/実運用経路、旧flow終了、既存IDと最終statusをprivate記録に保持します。
この文書自体は特定実環境の復旧完了を示す証拠ではありません。

## 実装・一次資料

- HABの固定主体検証: [oauth-auth.ts](../src/host/oauth-auth.ts)、[参加設計](persistent-mcp-auth.md)。
- 調査したHermes revisionは `6705c8c634d83a2f2918aa5ec45e7f8f20c20dc7`。
  [storage](https://github.com/NousResearch/hermes-agent/blob/6705c8c634d83a2f2918aa5ec45e7f8f20c20dc7/tools/mcp_oauth.py)、
  [provider](https://github.com/NousResearch/hermes-agent/blob/6705c8c634d83a2f2918aa5ec45e7f8f20c20dc7/tools/mcp_oauth_provider.py)、
  [manager](https://github.com/NousResearch/hermes-agent/blob/6705c8c634d83a2f2918aa5ec45e7f8f20c20dc7/tools/mcp_oauth_manager.py)、
  [CLI](https://github.com/NousResearch/hermes-agent/blob/6705c8c634d83a2f2918aa5ec45e7f8f20c20dc7/hermes_cli/mcp_config.py)を採用版で再確認する。
- Auth0: [refresh token](https://auth0.com/docs/secure/tokens/refresh-tokens)、
  [rotation/reuse検知](https://auth0.com/docs/secure/tokens/refresh-tokens/refresh-token-rotation)、
  [最大/idle期限](https://auth0.com/docs/secure/tokens/refresh-tokens/configure-refresh-token-expiration)。

## 共通hostの認証待機gate（製品配線は別）

HAB側には [ReceiveSupervisorの認証復旧契約](receive-supervisor.md#認証失効時の待機と検証後の再開)
があります。信頼済みnative providerが更新不能を型付きで報告した場合、通信retryへ潰さず
再認証待ちに入り、本人再認証後の同一主体と既存HAB参加の検証結果だけで受信再開できます。
これはRT更新や自動ログインの実装ではありません。Hermes標準のrefresh fence/保存責務を維持し、
製品側のidentity照合・ローカルstatus表示と結線して初めて有効になります。
この契約や合成テストの成功を、実機での自然期限越え・再認証・常駐復帰の完了とは扱いません。
