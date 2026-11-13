# 受信側への本文引渡しと実機検証の準備

共通MCPの受信後に内容を判断するのは、受信エージェントである。HABは定期poll、durable保存後ACKと、認証済みcallerによる明示的な本文取得を提供する。製品固有runner、モデル起動や承認機構は追加しない。[設計判断 ADR-015](hab-decisions.md)と[共通MCP接続](common-mcp-connection.md)を基準にする。

## 保存済み本文の取得

既存hostの`inbox`は診断用metadataだけを返す。新しいローカル操作[inbox_read](adapter-host.md#保存済み本文を明示的に読む)は一つのsourceを指定し、現在の認可・pause/epoch・設定済みowner・保存内容のHMACを確認してcopyを返す。共通MCPの5操作や受信supervisorは変更しない。

純粋な読取りは`receipt_confirmed=false`の保存済み本文にも対応する。配送receiptの不確実性を隠さず、読取りと引受け・処理・承認を分けるためである。返信とTaskの既存確認条件は緩めない。別のreader serviceや共通ライフサイクルの抽出は、同じ権限境界を二重化するため今回は追加しなかった。

```sh
NODE_NO_WARNINGS=1 npm run test:communication-boundary
```

新規7ケースは、正確な保存本文・nested JSONのcopy、source別権限、返信権限の分離、ACK応答消失中の読取りと元ACKの照合、missing/released、改ざん、返却前の失効とpauseを検証する。実loopback HTTPの送信→周期受信→保存後ACK→明示的本文取得を通り、受信側driverが別のanswer/send操作を選ぶまでoutboxとTaskが空であることを確認する。

このdriverは合成の受信側判断であり、実製品のモデルや所有者承認を模倣して合格したとは扱わない。周期は注入schedulerで進めるため、実時間の30秒運用を測定した結果でもない。

## 実機受入れに必要な対応関係

| 対象 | 既存の証拠・準備 | 実機で確定すること |
| --- | --- | --- |
| 呼出主体 | hostは検証済みcontextから操作・actor・sourceを確認 | 実製品の認証済みcallerと受信アドレスの対応。表示名・本文のsession IDで選ばない |
| 受信契機 | ReceiveSupervisorはモデルなしでreceiveのみを反復 | その製品hostが提供する正式な定期実行、頻度、停止方法。MCP登録だけで常駐としない |
| MCP transport | 共通clientのloopback HTTPと保存後ACKを検証 | 既存native MCP clientの正式な呼出し位置、認証更新の所有者、同じアドレスへの固定 |
| 保存 | SQLiteInbox・control・owner・元ACK照合を利用可能 | 本人限定の保存先・鍵・容量とrestart時の同一binding。新規認証・保管設定は別途確認 |
| 本文引渡し | source別のinbox_readで保存済み外部データを返す | 実製品の表示／agent入力の正式APIと受信者session binding。存在しないinject/wake APIを仮定しない |
| 内容判断・実行 | HABは実行や承認を行わない | 受信agentの既存policy・権限・承認を通る実際の経路と、不足能力の表示 |
| 返信 | 既存answer intent・budget・outbox・明示sendを利用 | 本文・相手・元ID・期限を固定し、受信側が必要な承認を確認して送信 |
| 停止・復旧 | host pause、owner、drainと同ID照合を模擬確認 | 実起動コマンド・対象release・停止権限と整合backup。close/reopenとkill-9を区別 |

この表は実機接続成功を示すものではない。実製品の正式なcaller/表示/agent入力APIが確認できない場合は、ローカル保存・取得までと明記する。Hermes専用実行系や任意Taskへ置き換えて、この不足を隠さない。

## 適用前にレビューする差分

実稼働へ進む前に、対象製品・承認済みrelease、接続先、所属groupとアドレス、既存MCP transport、保存先、実効権限・承認、受信頻度、起動・停止・復元手順を具体化する。設定値やAPIを推測して新credential、grant、常駐jobを作成しない。

今回の変更は製品に依存しないローカル読取り口と検証準備である。稼働中のサービス・設定、実agent、実モデル、承認UIや本番processへの故障注入は変更・実行していない。

## #143後の実製品接続ゲート

#143のPython MCP SDK 2.3.0による3ケースは、新recipient入口と実SQLite（当時はprivate
JetStreamも併用）を合成policyで接続した互換証拠である。Hermesのnative session、承認UI、
モデルへの本文到達やwakeの証明ではない。2026-10-25の[有限native往復](finite-mcp-trial.md)
は別revisionの基本5操作を使った実製品試験であり、新入口の認可bridgeへ転用しない。

Hermes `6705c8c634d83a2f2918aa5ec45e7f8f20c20dc7` のsource確認では、次を区別する。

- 通常MCP handlerは `tools/mcp_tool_content.py:17–25` の2,000,000文字hard capを
  `tools/mcp_tool_handlers.py:599–617` で適用する。その後のspilloverも含め、transportの
  buffer拡大だけでは本文全体のモデル到達を保証しない。文字数とUTF-8 byte予算は別である。
- plugin `ctx.call_mcp` は通常handlerを呼んだ後、`hermes_cli/plugins.py:502–555` で
  さらに65,536文字を超える結果を切り詰める。末尾markerとtruncated flagが付くが、
  保存本文の完全性やJSON形の維持を保証しない。通常MCP経路の上限と混同しない。
  このplugin経路は別途server allowlistを要求し、この文書は追加grantを許可しない。
- `tools/mcp_tool_handlers.py:505–522` のSDK呼出しはtool名・arguments・任意progressを
  渡し、HABの認証済session／現在source権限の証明を提供していない。
  `tools/mcp_tool_transport.py:367–370` はstdioのidentity_headerを無効として警告する。
  client名、profile名、tool引数、外部本文を認可contextの代用にしない。

### 既存identity契約を再利用できる範囲

`RegistryAuthority.hostIdentity` (`src/hab/registry.ts`) は、検証済connectionに対する
host所有の任意attestationである。`src/hab/discovery.ts` の `HabHostIdentity` は
agent/address、opaqueなowner_reference、session/bot区分、binding_generation、観測時刻と
期限を持つ。Registryは所属・現在address・鮮度を検証してdiscoveryへ返す。
これは既存identity表示契約として再利用候補だが、`HostAuthorization`ではない。
actor_id、操作別権限、正確なsource keyへの現在許可やcommit時の再確認は提供しない。

受信者が管理する信頼境界で、次の入力と責務を確定するまでproduction bridgeは未成立である。

1. 実際に認証済みのrecipient session／botとdurable ownerへの対応、世代、期限、失効。
   名前や共有group内のas_address選択から独立sessionの本人性を推論しない。
2. `HostAuthorization(context, operation, source)` が同期に検証できる現在のactorと
   操作・source別許可。prepareとenqueue/sendを分離し、必要な受信者承認を製品側で適用する。
3. 各操作・commitまでに失効やactor変更を反映し、不明／非同期結果は既存どおり拒否する。
   ネットワークの事前確認をcommit guardの代わりにせず、独自の承認キャッシュを足さない。
4. 本人限定stores、鍵、owner排他、停止とdrain、restart後同一bindingの構成。
   MCP factoryはこれらを受け取れるが、生成・認証・自動resumeするlauncherではない。

これは既存契約間の不足の記録であり、新RPC認可protocol、製品plugin、汎用lifecycle層の
採用ではない。検証済みの入力がなければ固定allow-allで埋めず、接続を保留する。

### private stdioのlaunch bindingを使う場合の条件

wire上のsession証明がないことだけで、すべての接続を不可能とは判断しない。
既存HostAuthorizationは認証済contextを外側の構成から受け取る契約であり、特定製品の
policy export protocolを必須にしていない。所有者が認証済みの起動経路を管理し、専用の
private stdio processとrecipientを一対一に固定できるなら、launch時のcontextを閉じ込め、
受信側hostが現在のscopeを同期検査する構成は候補となる。これは未実証の構成条件である。

- process／pipeに接続できる主体とその信頼範囲、共有profile・複数session・再利用の有無を
  検証する。同一OSユーザーや共有MCP接続の分離を、process名だけで証明しない。
- launch bindingは本人性の入力であり永続的な許可ではない。recipient所有者が明示した
  現在のoperation/source scope、期限、失効を各guardで確認する。外部本文やtool引数で
  更新できず、不明時は拒否する。restart時の旧contextを自動再承認しない。
- host所有policyは配送操作の追加制限にできるが、製品の既存承認を不要にできない。
  標準接続へ全返信の一律承認を追加する必要もない。製品の通常MCP操作承認と、
  source別host許可の両方を実効経路で確認する。
- pull型answer intentはsourceごとに本文・相関・IDを永続固定し、enqueue commitで
  現在のhost許可を再確認する。HostAuthorizationの引数はoperation/sourceであり、
  それだけをexact-envelope人間承認の証明とはしない。個別本文への承認が必要な用途では
  その承認と保存済intentの一致・失効を受信側で確保するまで送信を許可しない。
  push型RecipientMessagePort.withReply/checkReplyの要件を、通常pull通信の追加必須APIへ
  拡大しない一方、pushで必要なexact commit guardを省略することもない。

したがって次の確認対象は、正式に制御できる専用processの起動・共有scope、所有者が許可する
配送操作の範囲、既存製品承認の実効性である。新しい認証protocolや独立承認UIを先に作らない。

Hermesの通常接続はこの専用session条件を自動では満たさない。
`tools/mcp_tool_scope.py:1–14,25–65` ではconnection keyはserver名、または
owner_scope/server名で、同route・credentialsなら別profileによるadoptionもある。
session ID単位の接続ではない。従って通常gatewayのstdioを単一sessionと呼ばず、
専用有限processを選ぶなら共有・他sessionの不在を別途検証する。

### 限定owner policyのローカル準備

`src/adapter-host/single-source-authority.ts` は既存HostAuthorizationのopt-in実装候補である。
検証済みrecipient/operator contextを別参照で受け取り、固定sourceだけのread/prepare/inspect/
enqueueとreceive/sendを既定拒否から明示許可する。認証、expiry timer、承認UI、stdio起動は
実装しない。policyオブジェクトは信頼されたowner構成だけが保持し、モデルに渡さない。

`createSingleSourceHost`は既存stores/transportと取得済みownerを受け、単一AdapterHostCycleを
内部構築する。authorization callbackと別hostへのbindは公開しない。agentはcontrolから導出し、
初期pausedとowner heldを要求する。DBのopen/migrate/acquire/closeは既存構成側に残る。
`updateWhilePaused(operatorContext, expectedEpoch, enabled)`は既存controlへpauseをcommitし、
running/drainingがゼロかつowner heldの場合だけ許可を差し替える。失敗時は許可を変えず、pauseできた場合は
停止を維持する。resumeは別の明示操作である。既に開始したRPCの遠隔効果は取り消せず、
古いepochの結果を新grantで承認しない。同一actorの再grantもこのfenceを経由する。

sendはsource=nullのため許可はoutbox全体に及ぶ。試験はfreshな専用outboxと単一producerで
この前提を限定し、任意enqueue/Task操作は許可しない。既存・復元・共有outboxの検査や
複数sourceの独立失効はこの実装の機能ではなく、汎用storeへ安全に適用済みとは扱わない。
source許可を無効化するとsendも拒否するが、sourceとexact-body承認は同一ではない。
必要なnative承認を代替せず、MCP管理tool、常駐loop、実製品設定を追加しない。
