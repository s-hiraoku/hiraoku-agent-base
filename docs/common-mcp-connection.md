# 共通MCPによるエージェント接続

HABはメッセージを預かる通信基盤です。各エージェントが自分の標準MCP
クライアントからRelayを呼びます。HABが相手の実行APIを呼んで起動することを
前提にしません。製品名による配送分岐や製品専用Adapterは追加しません。
製品ごとの設定書式は、その製品の既存MCP機能に合わせます。

## 採用済みの認証境界と現行実装

2026-10-25に[認証グループとアドレスの分離](relay-auth-groups.md)を採用しました。
認証済みグループに一つまたは複数のアドレスを紐付け、同じグループ内のBotは認証を
共有できます。別グループの名義使用・受信箱操作を拒否します。基本5操作の名義選択v1と通常サービスの明示opt-inを実装済みです。複数名義の場合、
各toolに自分側の`as_address`を指定します。任意の`expected_agent_id`を組み合わせると
不変IDとの一致も配送前に確認します。相手の宛先`address`とは別のfieldです。
以下の設定例は1対1 bindingと15分の有限試験の手順であり、常用token更新や稼働設定への
適用は含みません。MCP登録・認証だけで自動受信が起動したとは扱いません。

## 接続前に決めること

- 実際にMCPを実行する環境と、そこから到達できるRelayの正規resource URL。
  Macのloopbackはクラウド実行環境から直接到達できません。Macが接続済みでも
  リモート経路ができたことにはなりません。公開・トンネル・ネットワーク変更や
  プラグイン登録は、接続先と認証方式を具体化して別途承認します。
- 人間が選ぶ変更不可の`<bot_name>@<agent_name>.hab`と、Registryの`agent_id`。
  その名前を認証の代用にせず、検証済み個体の正確なbindingを登録します。
- 個体認証の権限、保存先、所有者と読める範囲、期限、失効・削除手順。
  既存の別サービスや旧Task MCPの資格情報を流用しません。
- 受信を開始する契機、永続inbox/outboxの所有者、停止時の扱い。
  MCPの登録だけで常時受信・自動返信・復旧保証が成立するとは扱いません。

ローカルサービスのbearerは[個体verifier](local-relay-service.md#individual-verifier)
の形式で最大15分です。認証ファイルの更新とRegistryの登録・binding・権限付与は
別々の操作です。Registryの登録・binding・権限付与・失効は
`npm run relay:admin`（[管理CLI](local-relay-service.md#operator-management-cli)）で
行い、試験ごとの自作スクリプトでRegistry APIを呼ぶ必要はありません。未接続は全拒否のままにします。
MCPのURLは`http://127.0.0.1:<port>/mcp`と完全一致させます。`localhost`はHost不一致で403です。権限は`resolve / submit / status /
poll / ack`だけで、Task管理や任意実行の権限には広げません。送信者と受信権限は
検証済み主体から決まり、ツール引数のエージェント名では決まりません。

## 送受信の順序と共通Adapterの境界

1. 送信側が`relay_resolve`で宛先を確認し、共通outboxへメッセージを保存します。
2. 同じmessage IDと本文で`relay_submit`を呼びます。不確実な送信は新しいIDを
   作らず、共通の再送・重複排除契約に従います。必要に応じて`relay_status`で照合します。
3. 受信側が自分の起動契機で`relay_poll`を呼びます。受信側の共通Adapterは
   `(sender_id, message_id)`で重複を排除し、本文とACK再送状態を永続保存します。
4. 永続保存が成功してから`relay_ack`を呼び、ACK receiptも保存します。
   ACKは受信保存の確認で、内容への同意や作業完了ではありません。
5. 返信するか・いつ返信するかは受信側が決めます。返信する場合は元のメッセージに
   対応する`in_reply_to`を付けて自分の共通outboxから送ります。相手も同じ受信手順を使います。

既存の`DurableReceiver`と`SQLiteInbox`は保存後ACKとACK照合を担います。
送信側の共通outboxと合わせ、能力・versioned interfaceに基づく共通Adapterの
責務です。MCPクライアント自身やLLMの会話記憶が永続inboxを提供するとは限りません。
未配線のホストでは保存先と呼出し位置を先に決め、`poll → 即ACK`で代用しません。
受信後の内容判断やガードレールは受信側に残ります。

## Hermesの既存MCP設定例

Hermesの[確認済みsource](https://github.com/NousResearch/hermes-agent/blob/f97608f178d1ffeca59860195ab7da295f7c8e5f/website/docs/user-guide/features/mcp.md)
（commit `f97608f178d1ffeca59860195ab7da295f7c8e5f`）では、HTTP MCP、headerの環境変数展開、
サーバー名によるdiscovery限定、`tools.include`が実装されています。
設定例は製品専用の配送コードではありません。導入先のversionでも仕様を確認してください。

承認後、選択したprofileの`config.yaml`へ既存設定を保持して追加する例です。
URLはローカル接続用の例で、実際の承認済みRelayと一致させます。

```yaml
mcp_servers:
  hab_relay:
    url: "http://127.0.0.1:8792/mcp"
    headers:
      Authorization: "Bearer ${HAB_RELAY_INDIVIDUAL_TOKEN}"
    enabled: true
    tools:
      include:
        - relay_resolve
        - relay_submit
        - relay_status
        - relay_poll
        - relay_ack
```

秘密値はYAMLや公開repoへ直接書きません。profileの`.env`を使う場合は事前に
保存先と閲覧範囲を承認し、ファイル0600・親ディレクトリ0700にします。
同じOSユーザーとprofileの別セッションからも読めるため、これは会話単位の隔離では
ありません。環境変数参照は保存先を安全にする仕組みとは別です。
OAuth設定・loginを追加せず、上例は明示headerの期限付きbearerを使用します。
loopback宛ての実通信がプロキシへ転送されないことも秘密を送る前に確認します。

新しい有限セッションで`hab_relay`だけをdiscovery対象にし、他のMCPを起動しない
ようにします。この選択はHermesの組込みツール、記憶、個人文脈まで無効にする保証では
ありません。モデルを使う試験ではそれらの実効設定を別に確認します。
既存Desktop・cronを再起動したり、受信スケジューラーを自動追加したりしません。

試験終了時は個体mappingの削除とRegistry bindingの失効を確認し、有限セッションを
終了します。試験だけの秘密値を削除し、MCP定義を残すなら無効化します。
15分の期限を更新して常用資格情報に切り替えることは、この手順には含めません。
本文・lease token・認証header・実運用設定を公開Issueや実行証跡に含めません。

## 完了と呼べる範囲

| 確認 | 証明すること | まだ証明しないこと |
| --- | --- | --- |
| loopbackの401/403 | 未認証・不正Hostの拒否 | 個体登録や送受信 |
| native MCPのdiscovery/call | その製品のMCPクライアントとRelayの互換性 | エージェントが内容を判断して応答したこと |
| 模擬送信者との往復 | 指定した試験経路の配送 | 実Dotsとの接続 |
| 実Codexと実Hermesの有限往復 | 両者のnative MCP送受信・host保存後ACK・対応する返信 | 常時受信、製品内の汎用的な永続連携、実Dots接続 |
| 実Dotsと実Hermesの往復 | 両者の共通MCP送信・保存後ACK・対応する返信受信 | 常時受信や任意作業の自動実行 |

2026-10-25のCodex / Hermes有限試験は成功し、失効・設定復元・試験Relay停止まで
確認済みです。[再現手順・host補助・検証限界](finite-mcp-trial.md)を参照してください。

実往復では両個体・実クライアント経路・無害な固定テスト文・送信/返信message ID・
`in_reply_to`・双方のACKを秘密なしで確認します。人間による操作とエージェント自身の
操作も区別します。接続未承認・到達経路未確定・永続保存未配線はそのまま未完了と
報告し、モデル単体や模擬試験の成功で置き換えません。
