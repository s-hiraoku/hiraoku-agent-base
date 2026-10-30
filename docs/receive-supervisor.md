# 共通受信supervisor（host port v1）

[有限host](adapter-host.md) · [共通MCP接続](common-mcp-connection.md)

`ReceiveSupervisor` は、既存の `AdapterHostCycle` の `receive` だけを反復する
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
  遠隔の認証拒否がtransport失敗として返る場合もbackoffし、ログインや権限追加を始めません。
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
受信本文はdurable inboxに留め、モデルやTaskへの自動受渡しは別の明示契約とします。

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
