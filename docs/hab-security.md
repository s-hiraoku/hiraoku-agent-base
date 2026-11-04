# HABのセキュリティ境界

[READMEへ](../README.md) · [Auth0詳細](auth0-boundary.md) · [受入れゲート](mvp-acceptance.md)

標準通信では[共通MCP接続](common-mcp-connection.md)の認証・配送権限を適用し、内容判断・実行と既存の承認は受信エージェント側が担当する。[受信側承認・実行境界](generic-agent-async-design.md#4-通信許可と実行承認の責任)の追加設計は任意Task連携の契約であり、HAB独自の製品別承認機構を標準接続に必須化しない。送信者の申告を受信側所有者の承認に代用しない。

## 認証と操作権限

Hubはfail-closedです。認証部品が未接続でも匿名公開へ切り替わりません。Auth0 resource-server部品は署名、固定issuer/audience、expiry、subject/client bindingとscopeを検証します。本番tenant/API/client登録、主体の登録、account状態の確認、entrypoint配線は未完です。

初期Dots/Grok診断には`hub:ping_submit / hub:ping_get / hub:ping_reply / hub:ping_pending`だけを使い、task worker権限を与えません。inventory requesterには`hub:submit / hub:get`、workerには必要なclaim/heartbeat/complete/getを別policyで与えます。実agent名や自然言語では権限を付与しません。共有accountの接続は特定Botの独占主体を証明しません。

## Tailscaleと公開入口

既存の別MCPはTailscale FunnelとGrokから動作したとの本人報告があります。HAB Hubではなく、既存認証方式もHubのAuth0と同一とはみなしません。既存routeとcredentialを維持し、Hub追加path/portは未決定・公開未承認です。

Serveはtailnet向け、Funnelは一般internet向けです。Funnelは443/8443/10000をサポートしますが、同じpublic listenerの別pathはprivate領域にはなりません。認証はHub側でも必須です。[Tailscale公式](https://tailscale.com/docs/features/tailscale-funnel)

現行コードのOAuth resourceはHTTPS・標準port・exact `/mcp`だけを許可します。同host別pathにはresource pathと専用protected-resource metadata、8443にはresource portの限定対応が必要です。共有root metadataや既存`/mcp`を上書きしません。Grokの非標準port受入れ、OAuth callback、resource/audience、streaming/reconnectは実clientで未検証です。公開endpoint、Host/Origin制約、request/rate limit、保存期間も接続前に確定します。

Cloudflare Tunnelや独自domainは必須ではありません。既存Tailscale再利用を優先検討しますが、公開経路の承認を省略しません。Auth0のauthorization discoveryはissuer側、Hubのprotected-resource discoveryはresource側で分けます。

## 秘密と個人データ

公開repoに置くのはcode、一般化した設計・手順、ダミー設定、testです。token、OAuth/API key、tenant/client/subjectの実運用値、メール・予定・記憶・会話、実DB、接続hostname、個人のlocal path、運用出力を入れません。`runtime/`、`secrets/`、`logs/`、DB、`.env*`とlocal configはgitignore対象です。ignoreだけに頼らず、commit差分を確認します。

Hub用Auth0 token、モデルaccount認証、Hermes loopback API keyは別の秘密です。既存Desktopのtokenを読んで流用しません。[一時キーhelper](local-hermes-key.md)は最大120秒のlocal lifecycleとfingerprint記録を提供しますが、token自体に暗号学的TTL/scopeはありません。停止失敗は`stop_failed`として残し、失効成功と主張しません。

## 実行の隔離と停止

今回のHermes inventory候補は専用profile、固定source/dependency/runtime、`-I -S`、一つのmetadata tool、無効なmemory/history、並列1と一件上限を前提にします。測定hashは内容の証拠で、実PID/listener/実効toolや起動権限の証明ではありません。管理環境のEPERMを成功に置換・迂回しません。fresh Inspectorと私的なmanifest/credential/store bindingが必要です。

永続subject/client stopとfenceで新admission・古いackを拒否します。送信済みbytesやremote実行は撤回できず、停止と照合を分けます。通知先は固定許可、HTTPS、接続時DNS/IP検証、redirect拒否、有限retryを必要とします。任意callbackや通知からの再依頼を許可しません。

## 費用も許可範囲

Auth0の無料条件は本人accountで確認し、trial-only featureを採用根拠にしません。モデル枠の残量・追加credit・API料金routeが未確認なら起動しません。新subscriptionや有料fallbackは別承認です。文書整備やsource公開は接続・課金・常駐の許可ではありません。
