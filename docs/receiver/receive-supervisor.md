# 共通受信supervisor（host port v1）

[有限host](adapter-host.md) · [共通MCP接続](../common-mcp-connection.md)

**配置（[ADR-017](../hab-decisions.md)）：** `ReceiveSupervisor`は`src/agent-sdk/receive-supervisor.ts`にあります。標準の受信hostは`src/agent-sdk/receive-host.ts`の`ReceiveHost`で、control・durable inbox・transportと任意のprocess owner（`SQLiteHostOwner`）だけで構成でき、送信outbox・返信budget・Task部品を必要としません。送信や回答も行う`src/adapter-host`の`AdapterHostCycle`も同じ`HostCore`の上にあり、同じように渡せます。

`ReceiveSupervisor` は、構成済みhost（`ReceiveHost`または`AdapterHostCycle`）の `receive` だけを反復する
model-freeのスケジューラーです。製品名、認証値、URL、メッセージ本文を判断材料に
しません。MCPの登録とは別に、hostを起動する明示的な構成が必要です。

## 共通契約と運用境界

起動側は `ReceiveSupervisorPort` version 1へ、構成済みhostと認可contextを渡します。
hostは同じ個体のdurable inbox、control、process-lifetime owner、固定transportを持ち、
操作者の明示resumeを済ませている必要があります。owner未設定・喪失、pause、host側の認可失敗は
停止します。supervisorはpause解除、owner取得・解放、credential生成、ログイン、grant更新、
Task受付、返信、モデル起動を行いません。

```ts
const supervisor = new ReceiveSupervisor(
  { version: 1, host, context },
  {
    interval_ms: 30000,
    retry_base_ms: 1000,
    retry_cap_ms: 300000,
    drain_timeout_ms: 30000,
  },
);
const result = await supervisor.run(stopController.signal);
```

この例はAPIの構成例です。実hostの設定やLaunchAgentを自動登録するコマンドではありません。
間隔は明示設定で1秒〜1時間、drain待機は最大60秒です。頻度は製品側の運用・容量に合わせて
決定します。本文を設定、コマンド、認証情報、起動指示として読み替えません。

## 保存、失敗、停止

- 各周期は既存hostの `receive` 1回。durable inboxへの保存とACK照合は既存実装が担います。
  poll、保存前の妥当性確認、保存、元のACK requestによる再確認の契約を置き換えません。
- poll/ACK通信失敗だけを指数backoffの対象にします。成功後は通常間隔へ戻ります。
  認証更新は既存transport/hostの責務です。認可失敗をno-authや別credentialで迂回しません。
  遠隔HTTP 401/403やwireの文字列だけから更新不能とは判定しません。信頼済みnative providerが
  型付きの復旧理由を返した場合は通信retryにせず、下記のgateで待機（gateなしなら理由付き停止）
  します。ログインや権限追加は始めません。
  inbox容量超過等の未知の保存失敗は停止し、未処理本文を自動削除して容量を空けません。
- 1 instanceの重複runを拒否し、process間ではhostの既存SQLite ownerを必須にします。
  未完了のtransportを発見したら新しいreceiveを始めず、有限時間drainします。
- 停止signalで次の周期を始めず、進行中のreceiveは既存の有限RPC契約に従って終了を待ちます。
  停止は送信済みRPCの取消しでも、接続・参加承認・tokenの失効でもありません。
- 結果の `drained: false` は、DB/ownerを安全に閉じられると確認できなかったことを示します。
  supervisorはownerを解放しません。起動側は通信のsettle確認まで保持するか、明示的なprocess
  終了と次のprocessでのdurable照合に任せます。旧snapshotへ戻してACKを消さないでください。
- 例外本文、受信本文、lease token、認証値を結果やログへ出しません。固定reasonと件数だけを返します。

`receive_steps` はreceive呼出しが返った回数で、メッセージ件数・ACK成功件数ではありません。
受信本文はdurable inboxに留め、モデルやTaskへの自動受渡しは行いません。受信側callerはhostがidleのとき、別のsource別読取り権限で[明示的なinbox_read](adapter-host.md#保存済み本文を明示的に読む)を呼べます。読取りから実行・返信・ACK確認を始めず、内容判断と必要な承認は受信エージェント側に残します。

## 再起動と本番への配線

process終了時にOSがowner lockを解放します。新しいprocessは同じowner/control/inboxを開き、
同じ個体・鍵・policy・schemaを検証してownerを取得します。pause状態を尊重し、既存ACKを
新しいrequest IDで作り直さず照合してからpollします。tokenは既存hostの保存先とrefresh fenceを
使い、supervisor独自のtoken cacheや更新方式を追加しません。

この変更には製品hostとのtransport composition、credential broker、foreground CLI、
LaunchAgent登録は含まれません。既存native MCP clientが返すdelivery/ACKを共通hostへ安全に
渡す配線を先に確定してください。そこを省いてMCP discoveryだけで常駐受信とは扱いません。
実環境への適用時は、release、起動コマンド、本人限定のinbox/control/owner/鍵の保存先、
停止・再開手順、受信頻度、認証更新の所有者を確認します。

`node --test test/receive-supervisor.test.js` は合成認証と既存SQLite/MCP gatewayで、保存後ACK、
ACK応答消失の照合、backoff、重複起動拒否、停止、失効、owner必須、drain上限を確認します。
実issuer更新、実hostの常駐job、実エージェントへの引渡しの受入れ試験は別です。

## 認証失効時の待機と検証後の再開

`AuthenticationRecoveryGate` は任意の**信頼済み起動側**のin-memory gateです。
認証機能やcredential brokerではありません。`ReceiveSupervisorPort.authentication` に渡すと、
blockedの間はreceive、poll、ACKを始めず、設定した通常間隔でローカル状態だけ確認します。
`authenticationChanged` は固定の `state`・`reason`・`revision` だけを受け取る同期ローカルsinkです。
状態/理由の変化ごとに1回通知し、identity・token・例外本文・URLを含めません。
sinkにログイン、通信、async処理を置かないでください。例外/非voidの戻り値は停止します。
人への通知を別経路に出す製品側は宛先・権限・重複抑制を自分で管理します。

| reason | 起動側が提示する対応 |
| --- | --- |
| `verification_required` | 既存の承認済み個体との一致を検証中。まだ受信しない |
| `reauthentication_required` | native OAuthが更新不能と確認した。本人に[同じprofile/serverでの再認証](../operations/auth0-recovery.md)を案内 |
| `identity_mismatch` | 元の主体と異なる。停止を維持し正しい本人アカウントを確認。自動登録・付替えをしない |
| `participation_inactive` | HAB参加承認が無効。本人/管理者の既存手順で確認。OAuthログインだけで回復扱いにしない |
| `authentication_uncertain` | 更新結果が不明など。古いRTの再試行を増やさずnative側で照合 |

通常のAT期限切れはnative OAuthの既存refresh/fence/atomic saveが処理します。
その結果が確定してから、信頼済みproviderだけが `AuthenticationRecoveryError` を生成できます。
例えばissuerの確認済み `invalid_grant` は `reauthentication_required` へ変換できますが、
任意の例外の `code`、HTTP status、未検証JWTだけでは変換できません。
`RelayMcpClient` はcredential providerからの型付き信号のみを保存し、fetch/遠隔レスポンスからは
昇格させません。native `HostManagedTransport` 側も同じ契約と既存operation guardに従います。
refresh/discovery/loginをsupervisor側に移してguardを迂回してはいけません。

起動側の概念的な構成は次のとおりです。`approvedIdentity` と `verifiedIdentity` はtokenではなく、
`issuer`・`resource`・`subject`・`client_id`・`connection_id`・`agent_id` の6値です。
既存の信頼済み設定をexpectedに使い、観測したidentityでexpectedを上書きしません。

```ts
const authentication = new AuthenticationRecoveryGate(approvedIdentity);
const supervisor = new ReceiveSupervisor(
  { version: 1, host, context, authentication,
    authenticationChanged: (status) => { localStatusSink(status); } },
  receivePolicy,
);
// 以下は既存native OAuthの処理がsettleした後、信頼済み起動側が実行する。
const ticket = authentication.beginVerification();
// 製品側の署名/claim検証と既存HAB identity照合を、既存の認可/operation境界内で行う。
const verifiedIdentity = await verifyExistingIdentity();
authentication.confirmVerified(ticket, verifiedIdentity);
```

これは実装済みCLIではなくcompositionの例です。`verifyExistingIdentity` は製品側で必要です。
署名/issuer/audience/期限/既存HAB承認と本人主体を検証した結果だけを渡してください。
ログイン成功、credentialファイルの更新時刻、tools/list成功、単なるJWT decodeは証拠になりません。
検証失敗時はgateをblockedのまま保ちます。`beginVerification` が返すticketはgate固有・一回限りで、
新たな検証やblockが起きると旧ticketでは再開できません。異なる6値では `identity_mismatch` です。

gateはprocess再起動ごとに `verification_required` から始まり、readyをdiskへ保存しません。
受信待機中に同一主体の検証が通れば次の周期で受信へ戻れますが、pause解除・owner取得・Task受付・
返信・モデル起動はしません。通知直後にもpause/owner/drainingを再確認します。credentialが別主体へ
変わった時点で起動側はgateをblockし、全native操作も `assertReady` と既存の認可境界で拒否します。
gateだけで署名検証/認可を代用することはできません。

ACK中の失効では保存済み本文と元のACK requestを残し、復帰後に既存journalで照合します。
送信側もclaimをdeferしてから理由を伝え、失効だけでquarantineや新規messageを作りません。
時刻/回数/保持期間の既存上限を延長しないため、長時間の停止でhorizonを超えたものは別途照合が必要です。

`test/authentication-recovery.test.js` は合成providerと隔離SQLite（配送storeを含む）で、理由の境界、
全identity欄の不一致、stale ticket、pause優先、同じACKの復帰、待機中無通信を検証します。
この追加だけでは実Hermesとの配線や自動通知は有効になりません。実環境の適用では
[復旧runbookの受入れ条件](../operations/auth0-recovery.md)を満たし、自然AT期限越えを別途確認してください。
