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
  "data": {
    "to": "dots@dot.hab",
    "session": "stallone",
    "arrived_at": "2026-11-16T12:00:00.000Z"
  },
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

| 項目                  | 既定               | 範囲           | 意味                                                                                                                            |
| --------------------- | ------------------ | -------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `default_ttl_ms`      | 3600000（1時間）   | 60000–86400000 | `ttlMs`を省いた購読の寿命                                                                                                       |
| `max_ttl_ms`          | 86400000（24時間） | 60000–86400000 | 購読の寿命の上限                                                                                                                |
| `max_per_agent`       | 8                  | 1–64           | 1受信者あたりの購読数                                                                                                           |
| `poll_ms`             | 3000               | 500–60000      | 新着を確かめる間隔                                                                                                              |
| `outage_after_ms`     | 60000              | 1000–86400000  | これより長く時計が止まったら、hostの停止かスリープとみなして寿命に足す。poll3回分より小さい値はpoll3回分として扱う              |
| `unanswered_after_ms` | 300000（5分）      | 60000–86400000 | 呼び鈴が2xxで受け取られてからこれだけたっても未読なら、受け取られたのに読まれていないとみなす（[ADR-027](../hab-decisions.md)） |
| `rering`              | true               | true/false     | 読まれていない呼び鈴を1回だけ鳴らし直す                                                                                         |
| `quiet`               | true               | true/false     | 受け取られた呼び鈴のメールが未読の間（最長`unanswered_after_ms`）、新着で鳴らさない（[ADR-030](../hab-decisions.md)）           |

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
  1回だけもう一度鳴らします。`eventId`は最初と別で、中身は同じ`{to, session, arrived_at}`だけです。再送はしません。
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

## 未読の間は新着で鳴らさない（ADR-030）

- 購読ごとに、最後に2xxで受け取られた呼び鈴を覚えます。それから`unanswered_after_ms`（既定5分）以内で、そのメールがまだ未読なら、
  新しく届いたメールでは鳴らしません。受信箱を読めば新しいメールも一緒に読めるからです。
- 鳴らさなかったメールは飛ばさずに待たせます。読まれればそのまま鳴りません。静かな時間が終わってもまだ未読なら、そのときに鳴ります。
  鳴らしたメールだけが読まれた場合は、すぐ次の配送で鳴ります。
- 鳴らし直し（ADR-027）が先に鳴り、そこから静かな時間がもう一度始まります。読まれないままなら、呼び鈴はおよそ5分に1回です。
- 2xxで受け取られなかった呼び鈴は静かな時間を始めません。`quiet: false`で1通ごとに鳴らします。

```sh
npm run hab:admin -- --config /ABSOLUTE/PRIVATE/service.local.json status
```

`doorbell_lapsed`が出たら、下の「Dots（ChatGPT）を設定する」の2と3をやり直します（ChatGPTのHABアプリで
再読み込みし、イベントで始まるタスクを作り直す）。購読し直すと、まだ読まれていないメッセージの分も呼び鈴が鳴ります。

拒否の理由（JSON-RPC errorの`data.reason`）:

| reason                                 | code   | 意味                                                                                   |
| -------------------------------------- | ------ | -------------------------------------------------------------------------------------- |
| `unknown_event`                        | -32602 | `hab.message.received`以外の名前                                                       |
| `invalid_arguments` / `invalid_params` | -32602 | 引数や形が違う                                                                         |
| `unsupported_delivery`                 | -32602 | webhook以外の配送方法                                                                  |
| `invalid_secret`                       | -32602 | `whsec_`で始まる24–64バイトの鍵でない                                                  |
| `invalid_callback_url`                 | -32602 | HTTPSでない、認証情報やフラグメント入り、`localhost`などの内部名や非公開IP、2048文字超 |
| `too_many_subscriptions`               | -32602 | `max_per_agent`を超えた                                                                |
| `callback_not_public`                  | -32015 | callbackが非公開アドレスに解決される                                                   |
| `challenge_failed` / `timeout`         | -32015 | 確認のchallengeが返らない                                                              |
| `forbidden`                            | -32600 | その接続に`poll`の権限がない                                                           |

## 運用者が登録する呼び鈴（ADR-029）

自分でイベントを購読できないエージェント（Webhookで起きるroutineを持つGrok Botなど）には、
運用者がhost設定でアドレスごとに呼び鈴の宛先を登録します。

```json
"ingress": {
  "events": {
    "doorbells": [
      {
        "address": "grok@grok-bot.hab",
        "url": "https://<routineのWebhook URL>",
        "secret_file": "/ABSOLUTE/PRIVATE/grok-doorbell.secret"
      }
    ]
  }
}
```

- `secret_file`は所有者だけが読める（`chmod 600`）1KiB以下のファイルで、中身は鍵1行です。
  `whsec_…`ならStandard Webhooksの署名ヘッダ、それ以外（16〜512文字のtoken）は
  `Authorization: Bearer <token>`で送ります。鍵をチャットや設定ファイルに貼らないでください。
- 中身は購読の呼び鈴と同じ`{to, session, arrived_at}`だけです。失敗時の再送、5分後の鳴らし直し（ADR-027）も同じです。
- 期限はなく、challengeも送りません。設定から消してhostを再起動すると外れます。
  登録した時点で待っているメールでは鳴りません。
- `hab:admin status`では`doorbell: "live"`と`doorbell_operator: 1`のように見えます。
- 同じ Mac の notifier（Hermes など）を起こす場合だけ、`url`に`http://127.0.0.1:<port>/…`
  （または`http://[::1]:<port>/…`）を書けます（ADR-032）。ポートの指定が必要で、`localhost`などの名前、
  ほかの非公開アドレス、認証情報やフラグメント入りの URL は起動時に拒否します。鍵は`whsec_`にして、
  notifier の`wake.secret_file`と同じものを使います。エージェントが`events/subscribe`で指定する宛先は
  今までどおり公開 HTTPS だけです。

## 相手のセッションが終わったとき（ADR-032）

呼び鈴を受けた製品は、通知の`to`に当たるセッションがもうないとき、HTTP `410`と本文
`{"reason":"session_gone"}`で答えます。HAB はこの答えだけを数えます。

- 同じアドレスで続けて 3 回（`ingress.events.absent_after`で変えられる）この答えが返ると、そのアドレスを
  「相手がいない」にします。`hab_send`はそのアドレスへの送信を`recipient_absent`で断り、
  `hab:admin status`の`problems`に`recipient_absent`、`inboxes[].recipient_absent_since`に時刻が出ます。
- 応答なし、5xx、そのほかの 4xx、理由のない`410`は数えません。理由のない`410`は今までどおり購読の終わりです。
- 製品がそのアドレスの呼び鈴を 2xx で受け取るか、新しく購読すると（更新ではなく）、元に戻ります。
  運用者が登録する呼び鈴（ADR-029）を新しい URL で登録し直したときも元に戻ります。同じ呼び鈴のままの再起動では戻りません。
- 改名後の猶予期間中の旧アドレスも同じ相手として扱い、同じく断ります。
- 未読のメールはそのまま残り、7 日で期限切れになります（今は消さず、不達の知らせも送りません）。

## 製品側の定期確認と遅れの表示（ADR-032）

HAB から時間で呼び鈴を鳴らす定期確認（ADR-031）は、ADR-032 でやめました。呼び鈴は新着で 1 回、
読まれなければ 5 分後にもう 1 回（ADR-027）だけ鳴ります。古い設定に`ingress.events.inbox_check`が
残っていても host は起動し、起動時の`ready`の行に`"ignored_config":["ingress.events.inbox_check"]`と
1 回だけ出します。

決まった間隔で受信箱を見るのは製品の側です。運用者は、その製品の受け方を台帳に書きます。

```sh
npm run hab:admin -- --config <service.local.json> receive --agent-name muse --mode poll --interval-ms 900000 --request-id muse-poll-1
```

- 受け方が`poll`の製品のアドレスが、間隔の 2 倍を過ぎても`hab_inbox`を呼ばないと、
  `hab:admin status`の`problems`に`poll_overdue`が出ます。数え始めは、最後に`hab_inbox`を呼んだ時刻か、
  受け方を設定した時刻の新しいほうです。
- `inboxes[].last_inbox_read_at`に、そのアドレスが最後に`hab_inbox`を呼んだ時刻が出ます
  （MCP イベントを有効にした host だけ）。

呼び鈴を持たないエージェント（Museなど）は、下の「Museを設定する」のように製品自身の
定期実行で`hab_inbox`を呼ばせます。購読が切れた（`doorbell_lapsed`）ときも鳴らせないので、
ChatGPTでも定期タスクを併用できるならそれが保険になります。受信通知アダプタ（`hab:notify`）を
使うエージェントは、`interval_ms`（既定15秒）ごとにすでに受信箱を確かめています。

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

1. Museのチャットで定期実行を作る。たとえば15分ごとに次の指示を実行させる。運用者は`hab:admin receive`で
   Muse の受け方を`poll`と同じ間隔にしておくと、止まったときに`poll_overdue`で気づけます。

   > HABの`hab_inbox`で新着だけを確認して。新着があれば送り主と内容を私に知らせて。
   > 返信や作業は私が頼むまでしない。新着がなければ何も言わなくていい。

2. 初回の実行で`hab_inbox`が呼べること（コネクタが定期実行から使えること）を確かめる。

間隔を短くするほどMuseの利用量が増えます。受信だけでは返信しない（ADR-021の受入条件）、
受信側の判断と承認（ADR-015）はどちらの方法でも変わりません。
