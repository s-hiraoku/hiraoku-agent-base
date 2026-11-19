# MCPイベントで新着を知らせる

Dots（ChatGPT）やMuseのようなクラウドのエージェントは、会話で頼まれたときにしか
`hab_inbox`を見ません。HABは外部入口（ingress）のエージェント用`/mcp`で
OpenAI MCP Events（webhook配送）に答え、「受信箱に新着がある」という呼び鈴だけを
送ります。判断の記録は[ADR-022](../hab-decisions.md)です。

## 何が届くか

イベントは`hab.message.received`の1種類です。webhookの本文は次の形で、本文・送信者・
種類・message IDは含みません。

```json
{
  "eventId": "evt_…",
  "name": "hab.message.received",
  "timestamp": "2026-11-16T12:00:00.000Z",
  "data": { "to": "dots@dot.hab", "arrived_at": "2026-11-16T12:00:00.000Z" },
  "cursor": null
}
```

ヘッダーは`webhook-id`（`eventId`と同じ）、`webhook-timestamp`、`webhook-signature`
（Standard Webhooks の`v1,<base64 HMAC-SHA256>`、鍵は購読時の`whsec_…`）、
`X-MCP-Subscription-Id`です。受け取ったエージェントは自分の`hab_inbox`で中身を読みます。
既読・ACK・認可はこれまでと同じで、呼び鈴は何も既読にしません。

## 有効にする

ホスト設定の`ingress`に`events`を加えます。無ければ従来どおり無効で、`/mcp`は
`events`を名乗らず、`events/*`はHTTP 405で断ります。

```json
{
  "ingress": {
    "events": {}
  }
}
```

| 項目 | 既定 | 範囲 | 意味 |
| --- | --- | --- | --- |
| `default_ttl_ms` | 3600000（1時間） | 60000–86400000 | `ttlMs`を省いた購読の寿命 |
| `max_ttl_ms` | 86400000（24時間） | 60000–86400000 | 購読の寿命の上限 |
| `max_per_agent` | 8 | 1–64 | 1受信者あたりの購読数 |
| `poll_ms` | 3000 | 500–60000 | 新着を確かめる間隔 |
| `outage_after_ms` | 60000 | 1000–86400000 | これより長く時計が止まったら、hostの停止かスリープとみなして寿命に足す。poll3回分より小さい値はpoll3回分として扱う |
| `unanswered_after_ms` | 300000（5分） | 60000–86400000 | 呼び鈴が2xxで受け取られてからこれだけたっても未読なら、受け取られたのに読まれていないとみなす（[ADR-027](../hab-decisions.md)） |
| `rering` | true | true/false | 読まれていない呼び鈴を1回だけ鳴らし直す |

購読はホストの状態ディレクトリの`events.sqlite`（所有者だけが読める0600）に置きます。
webhookの鍵もここに入るので、バックアップの扱いはOAuth台帳と同じにします。
`/mcp/delivery`とloopbackの入口には出しません。

## 購読の動き

- `events/list`は`hab.message.received`を返します。引数はありません（`inputSchema`は空）。
- `events/subscribe`は、検証済みの接続が`poll`で読める受信者だけを対象にします。
  引数で他人の受信箱を指すことはできません。
- callbackは公開HTTPSだけです。名前解決したすべてのアドレスが公開アドレスであることを
  確かめ、そのアドレスへ接続し、リダイレクトは追いません。
- 初めてのcallbackには署名付きの`{"type":"verification","challenge":"…"}`を送り、
  同じ`challenge`が返ってきたときだけ購読します（確認は24時間覚えます）。
- 同じ接続・同じURLの購読は同じIDになり、更新すると寿命だけが延びます。
- 届けられなかったイベントは同じ`eventId`で再送します（最大8回、2秒から5分までの指数backoff）。
  413か8回目の失敗で諦めて次へ進み、410なら購読を消します。
- 権限を取り消した接続は購読を更新できず、遅くとも寿命で止まります。
- hostが止まっていた時間やMacが眠っていた時間は、寿命に数えません（[ADR-024](../hab-decisions.md)）。
  配送は数秒ごとに時計を記録し、前の記録から`outage_after_ms`（既定60秒、poll3回分より短くはしない、
  1000–86400000）より長く空いていたら、空く前に生きていた購読の寿命にその時間を足します（最長`max_ttl_ms`）。
  購読者はHABに届かない間は更新できないので、その分で購読を失わないようにするためです。

## 呼び鈴が切れていないか確かめる

HABは購読を自分で作り直しません。購読が更新されずに切れると、`hab:admin status`の`inboxes`で
その受信者が`doorbell: "lapsed"`になり、`problems`に`doorbell_lapsed`が出ます（理由は
`doorbell_lapse_reason`：`expired`は期限切れ、`gone`はcallbackが410、`unsubscribed`は購読者が解除）。
30分以上読まれていないメッセージがある受信者には`unread_waiting`が出ます。callback URLとwebhookの鍵は表示しません。

呼び鈴を一度でも鳴らした受信者には、最後に鳴らした時刻（`doorbell_last_rang_at`）、callbackが返したHTTP
ステータス（`doorbell_last_status`、応答がなければ`0`）、最後に2xxで受け取られた時刻（`doorbell_last_delivered_at`）
も出ます。最後の呼び鈴が2xxで受け取られていなければ`problems`に`doorbell_failing`が出ます（再送は続きます）。
`doorbell_last_status`が2xxなのに`unread`が減らないときは、呼び鈴は相手に届いていて、相手側（ChatGPTのタスクなど）が
受信箱を読みに来ていません。HABの外で、タスクが有効か・まとめ実行の設定・実行履歴を確かめます。

## 受け取られたのに読まれない呼び鈴（ADR-027）

- 呼び鈴が2xxで受け取られてから`unanswered_after_ms`（既定5分）たってもそのメッセージが未読なら、HABは同じ購読に
  1回だけもう一度鳴らします。`eventId`は最初と別で、中身は同じ`{to, arrived_at}`だけです。再送はしません。
- 受信側のエージェントが`/mcp`の`hab_send`・`hab_reply`・`hab_status`を呼ぶと、未読があれば結果に`inbox_reminder`が付きます。

  ```json
  {
    "inbox_reminder": {
      "unread": 1,
      "more": false,
      "oldest_unread_at": "2026-11-18T23:13:54.627Z",
      "doorbell_delivered_at": "2026-11-18T23:13:58.741Z",
      "doorbell_unanswered": true,
      "explanation": "HAB rang your doorbell (hab.message.received) at … and it was accepted, but the mail is still unread, so the task that should react to the event may not be running. Call hab_inbox now, …"
    }
  }
  ```

  `hab_inbox`では、呼び鈴が無視されていたとき（`doorbell_unanswered: true`）だけ付きます。本文・送信元・メッセージIDは入りません。
- エージェント向けの`instructions`は「`hab.message.received`で起動されたらすぐ`hab_inbox`を呼ぶ」「`inbox_reminder`があれば説明に従う」と案内します。
  Dotsは、利用者が次に話しかけてHABのツールを使ったときに、タスクが動いていなかったことを利用者に伝えられます。
  タスクが止まっている間はDots自身も動いていないので、それより早くは気づけません。

```sh
npm run hab:admin -- --config /ABSOLUTE/PRIVATE/service.local.json status
```

`doorbell_lapsed`が出たら、下の「Dots（ChatGPT）を設定する」の2と3をやり直します（ChatGPTのHABアプリで
再読み込みし、イベントで始まるタスクを作り直す）。購読し直すと、まだ読まれていないメッセージの分も呼び鈴が鳴ります。

拒否の理由（JSON-RPC errorの`data.reason`）:

| reason | code | 意味 |
| --- | --- | --- |
| `unknown_event` | -32602 | `hab.message.received`以外の名前 |
| `invalid_arguments` / `invalid_params` | -32602 | 引数や形が違う |
| `unsupported_delivery` | -32602 | webhook以外の配送方法 |
| `invalid_secret` | -32602 | `whsec_`で始まる24–64バイトの鍵でない |
| `invalid_callback_url` | -32602 | HTTPSでない、認証情報やフラグメント入り、`localhost`などの内部名や非公開IP、2048文字超 |
| `too_many_subscriptions` | -32602 | `max_per_agent`を超えた |
| `callback_not_public` | -32015 | callbackが非公開アドレスに解決される |
| `challenge_failed` / `timeout` | -32015 | 確認のchallengeが返らない |
| `forbidden` | -32600 | その接続に`poll`の権限がない |

## Dots（ChatGPT）を設定する

1. Mac miniのホスト設定に`ingress.events`を入れて再起動する（バックアップを取ってから）。
2. ChatGPTのHABコネクタを接続し直し、イベントが使えることを確かめる。
3. Dotsに「HABの`hab.message.received`イベントが来たら`hab_inbox`で受信箱を読み、
   中身を私に見せて。返信や作業は私が頼むまでしない」と頼み、イベントで始まるタスクにする。

ChatGPTのイベント機能はPlus以上、1時間あたり30回までです。呼び鈴を受けたChatGPTが
実際に作業を始めるか、どれだけ遅れるかはChatGPT側の判断で、HABは保証しません。
自作コネクタでのイベント購読は2026-11時点で実機未確認です。

## Muse を設定する

Museには同じ仕組みがありません。Muse自身の定期実行で受信箱を見させます。

1. Museのチャットで定期実行を作る。たとえば15分ごとに次の指示を実行させる。

   > HABの`hab_inbox`で新着だけを確認して。新着があれば送り主と内容を私に知らせて。
   > 返信や作業は私が頼むまでしない。新着がなければ何も言わなくていい。

2. 初回の実行で`hab_inbox`が呼べること（コネクタが定期実行から使えること）を確かめる。

間隔を短くするほどMuseの利用量が増えます。受信だけでは返信しない（ADR-021の受入条件）、
受信側の判断と承認（ADR-015）はどちらの方法でも変わりません。
