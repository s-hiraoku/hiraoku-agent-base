# 共通RelayのOAuth公開入口

この入口は既存の5操作をHTTPS reverse proxyから受けるための任意設定です。
製品名による分岐、実行API、Task、model、受信schedulerは追加しません。
ローカルMCPと公開用MCPは、同じprocess owner・Registry・Relay DBを使います。
外部TLS終端・公開path・OAuth client・同意・鍵取得・個体登録は自動で行いません。

## 明示的な設定

[ローカルサービス](local-relay-service.md)の非公開`service.local.json`へ追加する形です。
既存の設定・保管鍵・DBを保持します。以下は承認済みendpointではない例です。

```json
{
  "ingress": {
    "port": 8793,
    "resource_url": "https://relay.example/hab/mcp",
    "oauth_file": "/ABSOLUTE/PRIVATE/remote-auth.local.json",
    "allowed_origins": ["https://relay.example"]
  }
}
```

`ingress`省略時の動作は従来どおりです。指定時も追加listenerは`127.0.0.1`だけに
bindし、外部公開は別操作です。port競合は両listenerを閉じてownerを解放します。
通常停止も両listenerを閉じます。proxyは正規Hostとpathを保ち、Authorizationを
そのまま転送する必要があります。転送ヘッダーで主体や正規URLを上書きしません。
別の`/mcp`や共有root metadataをこの入口へ転送しません。

OAuthファイルは既存readerと同じcanonical・本人所有・0600・単一hardlinkの
`*.local.json`で、公開repoの外へ保存します。[空の例](../config/relay-oauth.example.json)
は`enabled:false`・鍵0件・接続0件です。listenerと固定metadataだけを準備でき、
MCP操作はすべて拒否します。欠損・不正設定を匿名接続へ切り替えることはありません。

## 検証済み接続を許可する前に

- `issuer`は承認済みAuth0 tenantの正確なHTTPS URL、`resource`は公開MCP URLと完全一致。
- `keys`はそのissuerから別途確認した公開RSA鍵だけをpinします。形式は
  `kty:RSA / alg:RS256 / use:sig / kid / n / e`です。2048 bit未満や秘密鍵の項目は拒否。
  runtimeはJWKSを取得・自動更新しません。鍵が変わった場合はfail-closedで止め、
  operatorが正しい公開鍵を確認して非公開設定を更新します。
- `connections`は`subject / client_id / connection_id / issued_at / expires_at`。
  この接続の有効期間も最大15分です。timestampはcanonical UTC ISO形式を使い、
  JWTの秒単位`iat`と整合させるため、試験開始・終了は秒境界で設定します。
  tokenの`iat`から`exp`までが許可窓内に収まる必要があります。例えば許可窓15分・
  token TTL5分とし、両側の準備完了後に窓を開きます。窓の終了直前に発行したtokenは
  残り時間を超えるため拒否されます。自動延長はしません。
- `subject`とclientは実OAuth結果から検証し、専用接続の`connection_id`へ対応させます。
  clientごとの接続は一意とし、同一subject/clientの二重登録を拒否します。
  JWT・MCP引数のagent名やconnection名を採用しません。
  **同じ所有者・同じOAuth clientを共有する別Dotは、このJWTだけでは区別できません。**
  専用client/接続が対象個体に排他的であるホスト側証拠を確認するまで、許可一覧は空または
  無効のままにします。設定上のconnection名だけで仕様G0を達成済みとしません。
- 検証済み接続をRegistryの個体へ別途bindingし、必要な操作を有効にします。
  tokenだけでは未登録のメールボックスを利用できません。OAuthユーザーの識別と、
  特定エージェント専用接続の証明を混同しません。

全MCP操作に`relay:resolve relay:submit relay:status relay:poll relay:ack`の5 scopeを
要求します。これは今回の小さい接続権限の単位です。Task権限を含みません。
`iss / aud / sub / azp（またはclient_id）/ iat / exp / nbf / scope`と署名を検証し、
JWTの有効期間を最大15分に制限します。`aud`は固定resourceの文字列を要求します。
userinfo等を含む配列audienceを受け入れる対応はこの入口には含めません。

設定の無効化・接続削除・変更・期限切れは、認証済みopaque contextの操作前再検証でも
拒否します。config変更中の署名検証も旧contextを発行しません。tokenを発行・保存・
refreshするコードはありません。元JWT・header・claims・本文を監査ログへ書きません。

## 親側プラグインの準備

公開resourceに対し、専用の非公開MCP接続を用意します。既存Task pluginを改変しません。
provided public OAuth client方式では実clientIdと上記scopeが必要です。
正確なredirect URIは実際の接続管理画面から取得し、推測URIやwildcardを登録しません。
登録・grant・`resource`から`aud`への対応とtoken lifetimeはAuth0側で確認します。
[OpenAIの認証仕様](https://developers.openai.com/plugins/build/auth)を参照してください。

公開用listenerの未認証401は専用`resource_metadata` URLを案内します。
そのpathだけGETを認め、正規resource・issuer・5 scopeを返します。Host・Origin・raw path・
query別名・重複header・request/rate/deadline制限は既存HTTP境界で検査します。
5ツールのcatalogにもOAuth scopeを宣言します。tokenをplugin packageへ埋め込みません。

## 固定文1件の保存後ACK

親側にtransactional inboxがない場合でも、限定試験では次の順序を確認します。
これは共通Adapterの復旧・同時実行・exactly-once保証の代わりではありません。

1. 個体専用の非公開永続ストアへ、送信者ID・message ID・完全な受信envelope・
   generation・lease token・lease期限・確定したACK request IDを保存する。
2. 保存結果を別読取りで再取得し、同じIDと本文とACK要求であることを確認する。
   同じ送信者/message IDの本文違いは拒否する。確認できなければACKしない。
3. 保存済み要求そのものでACKし、receiptも保存する。応答不明時は新request IDや
   新本文を作らず、同じACK要求で照合する。再pollの世代違いを上書きで隠さない。
4. 1件・単一consumer・有限セッションに限定する。返信は元IDへの`in_reply_to`を持ち、
   送信前にも固定envelopeを保存する。私的な会話・認証値・lease tokenを公開記録へ出さない。

MCP接続だけでは永続保存の場所や実行主体は決まりません。実際の親側ストアと
再読手段を先に確認します。LLMの会話記憶だけで保存成功としません。

## 検証と撤回

`node --test test/relay-oauth-auth.test.js test/local-relay-oauth.test.js test/local-relay-service.test.js`
は合成署名・一時DB・loopbackだけを使います。2入口間の送信・返信・保存後ACK・
再起動照合・認証拒否・port競合cleanupを確認し、実Dots/Hermesの成功とは区別します。

公開前には候補releaseを検証し、既存設定との互換性、未認証拒否、正しいmetadata、
不正token/Host/Origin拒否を確認します。後日のschema変更を未適用なのに適用済みと
扱いません。承認された2つの公開pathだけを追加・撤回し、他サービスを維持します。
終了時は専用接続/ grant、個体binding、試験tokenを失効し、秘密値削除とMCP無効化を
確認します。DBと保管鍵は残し、実エージェント往復の未完了条件を報告します。
