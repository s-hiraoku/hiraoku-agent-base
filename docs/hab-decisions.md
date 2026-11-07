# HABの設計判断記録（ADR）

[READMEへ](../README.md) · [設計思想](hab-principles.md) · [ロードマップ](hab-roadmap.md)

状態は「採用」「当面不採用」「保留」「未決定」を使います。採用は設計判断であり、本番接続・費用・公開の承認を兼ねません。判断を変更するときは、この表と関連文書・testを更新します。

| ID / 状態      | 判断と理由                                                                                                               | 代替案・限界                                                                                                                     |
| -------------- | ------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| ADR-001 / 採用 | agentの判断を保持し、共通Hubは依頼・進捗・結果を仲介する                                                                 | 中央の単一super-agentへの統合は当面不採用。個人文脈を全agentへ複製しない                                                         |
| ADR-002 / 採用 | 現本番候補はMac＋SQLite。状態DBは一つ                                                                                    | Worker/D1核とmockを移植性のため維持。Sites/D1本番は保留で、現在のpilotでは使わない                                               |
| ADR-003 / 採用 | 既存の限定Task試験ではHTTP MCPと外向きMac worker、独立Hermes Runs、durable receiptを使う。標準通信の接続条件はADR-015で区別する                                                       | A2Aは初期版で当面不採用。Desktop session/API/authの流用もしない                                                                  |
| ADR-004 / 採用 | 原子的claim、lease/fence、要求idempotency、監査/outboxで失敗を扱う                                                       | exactly-once配送を保証しない。有限retryと受信側dedup、未知runの照合が必要                                                        |
| ADR-005 / 採用 | 固定task、最小scope、並列1、実tool/import境界を最初の受入れにする                                                        | 任意shell・自由入力・自由な宛先・個人データ・自律follow-upは当面不採用                                                           |
| ADR-006 / 採用 | Auth0をidentity候補とし、主体/clientを分離。未設定は拒否                                                                 | 本番設定・無料feature・client登録方式は未確認。service credentialをuser consentの代わりにしない                                  |
| ADR-007 / 採用 | 既存Tailscaleの再利用を優先検討し、既存MCPを維持                                                                         | Hubの同host別pathか別8443は未決定。双方に限定code変更とOAuth/client検証が必要。Cloudflare/domainは必須でない                     |
| ADR-008 / 採用 | 結果取得を最初に、通知はopt-in・固定payload・承認済みcallbackに限定                                                      | Eventsコードは実装済み、実receiver/egress/常駐配送は保留。通知は新taskを作らない                                                 |
| ADR-009 / 採用 | source/設計はpublic、実設定・秘密・履歴はprivateで管理                                                                   | public repoは実agent起動やHub追加公開を許可しない。repoは同一履歴を保持してhiraoku-agent-baseへ改名                              |
| ADR-010 / 採用 | 既存jobは元の担当に残す。費用・停止・照合を先に決める                                                                    | cronの重複作成、有料fallback、不明admissionの無制限retryは当面不採用                                                             |
| ADR-011 / 保留 | Claude Code・Codex・CursorとCuaを限定executor候補にする                                                                  | Hub adapter、workspace reservation、権限、費用、result provenanceを検証後に選定                                                  |
| ADR-012 / 保留 | 競合は設計参考として保存し、部品単位で比較する                                                                           | 導入・置換・migrationは未決定。browser本人sessionによるdot代理操作は初期HAB接続に採用しない                                      |
| ADR-013 / 採用 | [HAB Relay draft v2 + store-and-forward](hab-relay-spec.md)を通信設計に採用。Relay／Task Engine／Adapter／認可を分離する | 単一Node＋SQLiteから開始。認証境界はADR-014、配送storeと構成はADR-016で改訂。durable outbox/inbox等の実能力はG0未確認。仕様採用は実接続・公開・credential発行の承認ではない |
| ADR-014 / 採用 | 2026-10-25 JST：[認証は参加グループ単位、Botの切り分けはアドレス単位](relay-auth-groups.md)。1認証主体に1件または複数の所属個体を紐付ける | グループ内のBot本人性は要求しない。グループ外の名義使用・受信箱閲覧を拒否。Registryのopt-in拡張を実装。基本5操作のMCP名義選択を実装。常用token更新は未実装で、稼働設定やgrantを変更しない |

## ADR-015 / 採用：共通MCP通信と受信側の判断を分離する

2026-11-04 UTC。標準経路の構成（Relay、NATS実行port）はADR-016で改訂した。受信側の判断・承認の分担は引き続き有効である。基準は[共通MCP接続](common-mcp-connection.md)、[受信supervisor](receive-supervisor.md)、[Relay責務](hab-relay-spec.md#3-構成と責務)とする。

- HABは認証・名義・宛先・配送・相関を担当する。受信側hostが定期poll・重複排除・永続保存後ACKを行う。ACKは表示・引受け・実行・承認・完了を証明しない。
- 内容の判断、返信、作業の実行、既存の権限・承認の適用は受信エージェント側が担当する。HABは製品専用モデルrunnerや承認実装を標準接続へ組み込まない。
- 通常の質問・回答にはTaskを要求しない。既存の限定Task、汎用テキストTask、A2A入口、NATS実行portは明示構成する任意機能として保持する。任意機能の実行状態やjournal契約を、共通MCP接続の必須条件へ広げない。
- 製品の既存MCP設定、受信契機、保存先、表示能力の確認は必要である。製品実行APIをHABが呼ぶ専用adapterの追加とは区別する。正式なwake・表示APIがなければ、その能力を未対応・未確認として報告する。

照合基準のmain `c667095` では、ReceiveSupervisorはreceiveのみを反復し、汎用Task入口は通常Relayへ未配線だった。稼働経路の破損を確認した判断ではない。未マージ[PR #132](https://github.com/s-hiraoku/hiraoku-agent-base/pull/132)はHermes固有実行・承認の隔離候補であり、標準接続として採用しない。既存の受信経路を置換するものとして進めず、mainへの取込み・本番有効化は本判断に含めない。

通常通信を任意Task実行に統合する案と、全エージェントへ新たな共通承認UIを必須にする案は採用しない。受信側既存機構へ権限と判断を残すためである。回帰検証は[設計境界の照合記録](implementation/design-boundary-alignment.md)を参照。

## ADR-016 / 採用：単一host、JetStream配送、エージェントSDKで標準接続を構成する

2026-11-06 UTC。ADR-015の受信側の判断・承認の分担は維持し、標準経路の構成と配送storeをこの判断で改訂する。基準は[JetStream配送設計](../packages/relay-nats/DESIGN.md)、[エージェントSDK](../src/agent-sdk/README.md)、[HAB登録・認可境界](../src/hab/README.md)、[ローカルRelayサービス](local-relay-service.md)とする。

- 配送はNATS JetStreamだけで行う。SQLite配送storeは廃止し、保存済みの旧messageは移行しない。host設定の配送sectionは`delivery`で、旧`store` sectionを含む設定は`config_invalid`で拒否する。
- `src/messaging`がmessage契約と`DeliveryService` interfaceを持つ。`src/hab`のRegistryが名義・認証group・権限・容量を判定する。配送backendは名義や権限を判断しない。
- `src/host`が唯一のhostである。設定、HTTP、監査、管理CLI、MCP server（`src/host/mcp`）を組み立て、JetStream配送を`DeliveryService`として注入する。起動は`npm run relay:local`、管理は`npm run relay:admin`を使う。
- エージェント側は`src/agent-sdk`の永続sender／outbox、保存後ACKのreceiver／inbox、MCP clientを使う。MCP tool名`relay_*`は既存の接続設定との互換のため維持する。
- A2Aはエージェント側のSDKからhostのMCP、`DeliveryService`の順に通す。2026-11-06のowner判断により、A2A gatewayはhost所有のA2A名義でhostへ配線する（下記「次に決める内容」5、[A2A host配線](a2a-relay-preview.md#host-wiring-with-a-host-owned-identity)）。hostは設定の`a2a` sectionがある場合だけ、専用のRegistryアドレスと永続mailbox（agent-sdkのoutbox/inbox）を起動時に冪等に用意し、A2A Taskをその名義から送り、受信者はその名義へ返信する。呼出し元エージェントのmailboxは読まない（受信者1件1leaseと、そのエージェント自身の保存後ACK受信と衝突するため）。返信は依頼の期限から1日の返信期間だけ保存する。2026-11-07のowner判断により、期間内に結果が反映されなかったTaskは標準の`FAILED`へ移し、理由`result_window_expired`と「受信者が実行したかは不明」の旨をstatusに示す。WORKINGのまま残さず、独自のA2A状態も追加しない。期間後の返信は記録せずACKし、Taskは変えない。新しいmessage IDの返信は、Taskを変える場合だけ保存する。保存の前に受信loopが保存済みTaskの写しへ適用し、inboxが保持している同じTaskへの返信は確認済みとして数える。状態を変えない返信やTaskが拒否する返信は、期間後の返信と同じく記録せずACKする。そのため新しいIDの返信を大量に送られてもACK履歴の枠は減らず、正しい結果は保存される。inboxが保持しているIDは必ずinboxへ渡すので、重複排除と未確定ACKの確定は保たれる。返信期間が閉じる時刻はTask storeの次の期限から求め、最も早い期間が閉じた受信cycleでTaskを移す。呼出し元はA2A用credentialで認証し、Registryが呼出し元自身の`resolve`・`submit`と宛先への`execution_request`送信権を毎回判定するため、host名義は呼出し元が直接送れない相手へ届かず、他者の返信も読ませない。`DeliveryService`契約、lease規則、`relay_*` MCP toolは変更しない。
- 汎用NATS実行port（`src/generic-nats`）、管理添付、SQLite snapshot bundleは削除した。task-bridge、answer-intents、adapter-hostは今回の構成変更の対象外として保留する。

配送storeを二重に持つ案（SQLiteとJetStreamの併用・route切替）は採用しない。旧storeとの照合・rollback経路を保守し続ける費用が、移行しない旧messageの損失より大きいためである。配送journalはschema 4になり、それ以前のbuildは同じjournalで起動できない。旧buildへ戻す場合は、移行直前の整合backupを全部同じ世代で復元する。新releaseが受け付けたmessageと、backup時点で未完了だったmessageを元IDで照合する。backup時に未完了のIDだけでなく、backup後の新規IDも、新journalの行が回収されても受信inboxや実行記録に残る証拠から照合対象へ加える。どの写しにも残らないIDはこの一覧だけでは列挙できない。journalの`expired`・`quarantined`は未配達の証明にならず、受信者のinbox・Task結果・実行記録で判断する。復元した状態のIDがすべて期限切れになるまで旧buildを起動しないので、新releaseで実行済みのIDはRelayから再配達されない。ACKは保存の証明で実行の証明ではないため、backup時に受信inboxへ保存済み・未処理だった本文も照合する。復元inboxは期限に関係なく保存済み本文を渡すので、受信者を再開する前に写しの実行記録と照合し、実行済みの本文は再処理させない。backup後に保存され、新inboxの写しだけに未解放で残る本文も別に照合する。drainと期限待ちはその本文を復元先へ移さない。実行記録やTask状態から未引渡しと確認できた場合だけ、元のsender/message IDと重複排除を保つアプリ固有のローカル復旧手順で写しから引き継ぐ。未確認の副作用、欠けた写し、矛盾があれば停止を保ち、自動再送、別ID化、期限延長を行わない（[手順](../packages/relay-nats/OPERATIONS.md#roll-back)）。本判断は本番接続・公開・credential発行の承認を兼ねない。

## 次に決める内容

1. Hub外部resource URLとdiscovery route。既存MCPのclient/認証を確認し、既存routeへの干渉がない案を承認する。
2. Auth0 issuer、正確なcallback、主体/clientと最小scope、無料条件、秘密保管とrevocation。
3. 今回のHermes inventoryの実行環境とprivate binding、$0モデル枠、単発停止・回収条件。
4. Dots/Grokの実MCP呼出し・結果取得と、wakeまたはEventsを追加する必要性。
5. ~~A2A gatewayをhostへ配線するか~~ 決定済み：host所有のA2A名義で配線する（ADR-016、owner判断 2026-11-06）。既定は無効。結果は受信者の永続返信による報告（`attestation: "recipient_reply"`）で、受信者engineの独立検証ではない。

個別のtechnical contractは[Hub内部設計](architecture.md)、[Auth0](auth0-boundary.md)、[import境界](hermes-import-boundary.md)を参照してください。重複する設定表を増やさず、そちらを更新します。

## ShiftLog機能の接続境界

2026-10-10の本人方針により、ShiftLogをHABの機能として統合することを**採用**します。
repoは別管理を維持します。実装接続は未着手です。
[ShiftLog source](https://github.com/s-hiraoku/shift-log/tree/2a7e8b4fb33df66be440bd41324258aab40ce5d3)
を読み取り、API/schema/auth/collector/LLM sourceと同梱Skillを確認しました。実serviceや個人ログを読んだ証拠ではありません。

- **役割**：許可制の操作観察から10分／6時間のMarkdown記憶を作り、最近の作業、検索、再開contextを返す。
  `POST /v1/agent/continue` はkeyword hitとrecentを併合し、`mode: context_only`を返す。Computer Useや実行指示ではない。
- **最初の接続案**：HABから既存ShiftLog APIへの専用読み取りadapterで
  `GET /v1/agent/recent`、`GET /v1/search`、`GET /v1/memories/:id`と、読み取り目的の
  `POST /v1/agent/continue`だけを固定allowlistにする。limitと時間範囲・response量を制限し、
  本人の明示取得を最初にする。個人記憶を固定connectivity task/resultへ混ぜない。
- **認証・権限**：現sourceのBearerはtenantを選ぶが操作別scopeを分けておらず、同じtokenで
  permissions変更、window upload、history delete、demo seedにも到達する。
  「読み取り専用token」とは言えない。Hubに秘密を伝送せず、trusted local adapterの専用能力境界と
  明示subject/client→tenant対応が必要。必要ならShiftLog側のreadonly credential追加案を先に報告する。
  collectionのON/OFFは履歴readの認可ではなく、現read routeはcollection停止時も過去記憶を返し得る。
  agentへの共有許可はHub側で別に明示し、停止・取り消しを確認する。新規credential発行・別repo変更はまだ行わない。
- **書き込み境界**：収集ON/OFF、許可list、upload、削除、demo seed、既存collector/cron/launchdは
  この統合では呼ばない。ShiftLogのデータ所有・削除を維持する。Hubへの長期複製は作らず、
  後日の削除を過去task/resultやagent記憶へどう反映するかは接続前に決める。
  ただし既存read requestにもHTTP監査logが生じ、tenant hydrationは期限切れraw/10分記憶のpurgeと
  persistenceを行い得る。API全体が書込みゼロとは言わず、この既存retention副作用を接続時に説明する。
- **機密性**：記憶はtitle/body/apps/site/projectとrepo/PR/Slack/URL/file entityを含み得る。
  maskingがあっても個人の活動履歴であり、公開repo・監査log・outboxに本文を入れない。
  Dots/Grok/providerへどの範囲を送るかは接続先ごとに本人が選ぶ。取得内容は非信頼contextとして扱い、
  認可変更・shell・自律follow-upの命令として解釈しない。
- **費用・network**：現在のShiftLog LLM要約はAPI key設定時だけ外部LLMを使い、未設定なら
  LLM経路は使わない。この統合で有効化・新job・cloud送信・常駐化を追加しない。HABの$0制約を維持する。
- **port競合**：ShiftLog serverとHAB Node serverは両方127.0.0.1:8787が既定。
  実稼働は未確認。既存サービスを動かさずに別portを割り当てる必要があるが、設定変更は未実施。

用途として最初は「最近の作業の取得／指定期間・keyword検索／続きのcontext復元」を候補にします。
実際にどのagentへどの期間・本文範囲を共有するかだけが本人の選択事項です。まず限定Hermes往復を完了し、
この案を確認してから別repoの必要変更へ進みます。
