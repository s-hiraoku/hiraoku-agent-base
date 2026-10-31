# MCPからの自己識別・アドレス照会

`hab_discover`は任意の読み取り専用HAB toolです。認証済み接続と、発行済み
HAB名義、実行中のsession／botを別々に確認します。関連: [#112](https://github.com/s-hiraoku/hiraoku-agent-base/issues/112)。

## 有効化と互換性

通常構成は従来の5操作のままです。コード側の`RegistryOptions`または
設定ファイルの`registry`へ次を**明示した構成だけ**6番目のtoolを公開します。
この文書の追加は、本番設定の変更や再起動を行いません。

```json
{
  "discovery": {
    "availability_namespaces": ["hermes"]
  }
}
```

`availability_namespaces`は、接続を許可された利用者に候補名の占有有無を開示する
読み取りポリシーです。ここで`hermes`を許可すると、別groupに属する名前でも
`candidate@hermes.hab`が占有済みかどうかだけは分かります。そのagent ID、名前、
認証主体、割当先は返しません。空配列なら、自分の一覧にある占有済み名以外は
`unknown`です。他groupの占有有無も非公開にする運用では空配列を使います。
この設定は登録・予約・所属追加・認証grantを付与しません。

別のdirectory閲覧権限は追加せず、既存の`resolve`と`submit`を持つ有効な
接続binding（およびgroup）だけが照会できます。共有groupの自己名義選択は
不要です。個体bindingは自分の1件、group bindingは自分のgroupの所属だけを
閲覧できます。停止・退役した所属も一覧に含め、その登録状態を表示します。
製品やnamespaceが同じという理由では一覧の閲覧範囲を広げません。

既存`relay_resolve / submit / status / poll / ack`とそのschemaは変更しません。
登録機能の未マージpatchを取り込まず、`hab_register`の有無に依存しません。
追加toolを完全一致で拒否するクライアントは、利用前にcatalog allowlistの対応が
必要です。受信専用クライアントのpoll／ack呼出し権限は広げません。

## 自分を確認する

```json
{"action":"whoami"}
```

`connection`には認証方式、group IDまたは個体agent ID、検証済みbinding IDを返します。
issuer、subject、client ID、connection claim、fingerprint、tokenは返しません。
`selected_identity`は1名義だけならその名義、複数または未割当なら`null`です。

共有groupで呼出し名義を確認する場合だけ、次を指定できます。

```json
{"action":"whoami","as_address":"research@hermes.hab","expected_agent_id":"immutable-agent-id"}
```

これは`selection_basis=requested_group_name`という**利用者が選んだ名義**です。
実行中のsession／bot本人の証明にはなりません。別groupの名義、ID不一致、
`as_address`のない`expected_agent_id`を拒否します。

`host_identity`は、ホストに結び付いた実行対象の別情報です。モデルはこの値を
引数で渡せません。未配線のホストでは`state=unknown, reason=not_attested`です。
選択名義とホスト本人が違っていても、両者を混同せず独立して表示します。
両方が分かる場合の`identity_verification`は`matched / mismatch`、ホスト本人だけが
分かる場合は`unselected`、本人が不明なら`unknown`です。
この照会は既存5操作の自己名義を自動変更したり固定したりしません。

## 発行済み一覧と割当

```json
{"action":"directory","limit":25,"state":"waiting_connection","address_prefix":"research@"}
```

`limit`は1〜100（既定25）。`state`と`address_prefix`は任意です。各entryは次を返します。

| 項目 | 意味 |
| --- | --- |
| `agent_id / address / agent_name / bot_name` | 不変ID、正規アドレス、Registry上の名前 |
| `registration_state` | `waiting_connection / active / stopped / retired`の実データ |
| `address_status=issued_reserved` | 発行済み名は停止・退役後も再利用不可 |
| `authorized_operations` | 所属と接続groupの操作権限の共通部分。現在オンラインの証明ではない |
| `authentication_assignment` | 個体connection／認証groupへの割当と現在の接続binding状態 |
| `host_assignment` | この接続のホストが証明できるsession／botだけ。証明なしは`unknown` |
| `presence` | 現行Registryに観測機構がないため`unknown / not_observed`、観測時刻`null` |

発行済みだがhost bindingが未設定なのか、Relayから見えないのかは、現行のデータだけでは
区別できません。`host_assignment=unknown`を「空き」「未割当」「オフライン」には変換
しません。`waiting_connection`も未発行や自由に取得できる名前とは扱いません。
認証groupの割当と、製品内のsession／botへの割当は独立です。発行済みでもまだ
groupにも個体にも所属しない記録は、その記録を読める接続がないためこの一覧には
出ません。管理者は既存管理CLIのoverview／inspectで確認します。

次ページは同じfilter／limitに`next_cursor`を`cursor`として渡します。
`next_cursor=null`で終了です。cursorは検証済み接続、group、操作条件、認証ポリシーの
世代に結び付けたMACで保護し、他接続への持ち出し、改変、条件変更は`invalid_reference`に
します。group所属や権限が変更された場合は最初から取り直します。

ページは`page_consistency=live_keyset`です。各ページの`observed_at`時点の現状を
不変agent ID順で読み、同じIDを重複しません。ページ間の個体状態変更を凍結しないため、
走査済み位置より前でfilterに合うようになった個体は再走査が必要です。
`snapshot`はその接続の認証範囲の世代を示す不透明な値で、全groupの版番号や
凍結された一覧の証明ではありません。他groupの更新だけでは変わりません。

## 候補アドレスの空き確認

```json
{"action":"check_address","address":"research@hermes.hab"}
```

`availability`は`available / unavailable / unknown`です。明示的に占有照会を許可した
namespaceでは、Registryの完全一致照会で発行済みを`unavailable`、未発行を
`available`とします。未許可namespaceは、自分の発行済み名以外`unknown`です。

応答は常に`reservation_created=false`です。`registration_permission`と
`registration_capacity`は`not_evaluated`として、未検証のgrantや容量を推測しません。
空き確認は予約ではなく、確認後に別の登録者が取得できます。最終登録は既存Registryの
同一transaction内の競合検査とUNIQUE制約で確定し、先に取られた場合は
`registry_name_reserved`です。勝手に別アドレスへ置き換えたり、照会だけで登録しません。
本branchは未マージの対話登録grantや登録確認フローを変更しません。

## ホスト側の真実と鮮度

ホストは任意の`RegistryAuthority.hostIdentity(context)`を同期実装できます。
このcallbackは検証済みの同じ接続に対応する、保存済みの対象IDを読むための
**信頼されたコード側のport**です。HTTP headerやMCP引数をここへ直接写しません。

```json
{
  "agent_id":"immutable-agent-id",
  "address":"research@hermes.hab",
  "owner_kind":"session",
  "owner_reference":"opaque-stable-owner-id",
  "binding_generation":1,
  "observed_at":"2026-10-31T12:00:00.000Z",
  "expires_at":"2026-10-31T12:00:30.000Z"
}
```

`owner_kind`は`session / bot`、`owner_reference`はprofile表示名やファイルpathから
独立した不透明IDです。ホストは実session／botとの照合と永続保存の確認を担います。
`binding_generation`も保存済みbindingの世代です。callbackはread-onlyで、DB／directoryの
作成、receipt再保存、owner_referenceの発行、登録時申告からの推測を行ってはいけません。
Relayは正規schema、時刻、有効期間（Registryの`max_context_ms`以内）、閲覧範囲内の
agent IDとアドレスの一致を再検証します。不正な証明は拒否し、期限切れ証明は値を
公開せず`unknown / stale_attestation`にします。ホストの証明は稼働監視ではありません。

`startLocalRelay`は選ばれた認証authorityのこのportを引き継ぎます。通常のファイル設定
にはhost session情報を創作するmappingを追加しません。Relay単独では各製品のsession／
botや全hostの割当一覧を知りません。Hermes pluginの実identity storeへの配線は、
未マージの登録実装との統合時に同じ不変IDとowner_referenceで行う別作業です。
profileの`local-lab`→`hermes-hab`変更やHABアドレスのrenameは本機能では行いません。
未マージのHermes IdentityStoreはscopeに絶対pathを含み、既存storeの正式rename移行は
未実装です。本branchのopaque ID契約だけで、その既存storeがrename対応済みになったとは
扱いません。統合時は不変profile IDと正式なrename／clone移行が必要です。

## 検証

`test/hab-discovery.test.js`はgroup隔離、偽装、期限・失効、MAC cursorとfilter、
情報非開示、候補照会後の登録競合、全テーブル無変更を検証します。
`test/local-relay-host.test.js`では実loopback HTTPの起動・照会・ホスト本人の証明・
既存resolveとの併用も検証します。どちらも合成認証と一時DBだけを使います。
