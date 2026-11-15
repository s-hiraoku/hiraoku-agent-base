# HABの設計判断記録（ADR）

[READMEへ](../README.md) · [設計思想](hab-principles.md) · [ロードマップ](history/hab-roadmap.md)

状態は「採用」「当面不採用」「保留」「未決定」を使います。採用は設計判断であり、本番接続・費用・公開の承認を兼ねません。判断を変更するときは、この表と関連文書・testを更新します。

| ID / 状態      | 判断と理由                                                                                                               | 代替案・限界                                                                                                                     |
| -------------- | ------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| ADR-001 / 採用 | agentの判断を保持し、共通Hubは依頼・進捗・結果を仲介する（標準のメッセージ交換ではADR-015・016のとおり、HABはアドレス単位の認証・名義・配送だけを担う）                                                                 | 中央の単一super-agentへの統合は当面不採用。個人文脈を全agentへ複製しない                                                         |
| ADR-002 / 採用 | 現本番候補はMac＋SQLite。状態DBは一つ                                                                                    | Worker/D1核とmockを移植性のため維持。Sites/D1本番は保留で、現在のpilotでは使わない                                               |
| ADR-003 / 採用 | 既存の限定Task試験ではHTTP MCPと外向きMac worker、独立Hermes Runs、durable receiptを使う。標準通信の接続条件はADR-015で区別する                                                       | A2Aは初期版で当面不採用とした（2026-11-06のADR-016でhost所有名義の入口として採用、既定は無効）。Desktop session/API/authの流用もしない                                                                  |
| ADR-004 / 採用 | 原子的claim、lease/fence、要求idempotency、監査/outboxで失敗を扱う                                                       | exactly-once配送を保証しない。有限retryと受信側dedup、未知runの照合が必要                                                        |
| ADR-005 / 採用 | 固定task、最小scope、並列1、実tool/import境界を最初の受入れにする                                                        | 任意shell・自由入力・自由な宛先・個人データ・自律follow-upは当面不採用                                                           |
| ADR-006 / 採用 | Auth0をidentity候補とし、主体/clientを分離。未設定は拒否                                                                 | 本番設定・無料feature・client登録方式は未確認。service credentialをuser consentの代わりにしない                                  |
| ADR-007 / 採用 | 既存Tailscaleの再利用を優先検討し、既存MCPを維持                                                                         | Hubの同host別pathか別8443は未決定。双方に限定code変更とOAuth/client検証が必要。Cloudflare/domainは必須でない                     |
| ADR-008 / 採用 | 結果取得を最初に、通知はopt-in・固定payload・承認済みcallbackに限定                                                      | Eventsコードは実装済み、実receiver/egress/常駐配送は保留。通知は新taskを作らない                                                 |
| ADR-009 / 採用 | source/設計はpublic、実設定・秘密・履歴はprivateで管理                                                                   | public repoは実agent起動やHub追加公開を許可しない。repoは同一履歴を保持してhiraoku-agent-baseへ改名                              |
| ADR-010 / 採用 | 既存jobは元の担当に残す。費用・停止・照合を先に決める                                                                    | cronの重複作成、有料fallback、不明admissionの無制限retryは当面不採用                                                             |
| ADR-011 / 保留 | Claude Code・Codex・CursorとCuaを限定executor候補にする                                                                  | Hub adapter、workspace reservation、権限、費用、result provenanceを検証後に選定                                                  |
| ADR-012 / 保留 | 競合は設計参考として保存し、部品単位で比較する                                                                           | 導入・置換・migrationは未決定。browser本人sessionによるdot代理操作は初期HAB接続に採用しない                                      |
| ADR-013 / 採用 | [HAB Relay draft v2 + store-and-forward](hab-messaging-spec.md)を通信設計に採用（Relayという独自実装はADR-016で廃止。message契約・store-and-forward・ACK・期限の要件は存続）。Relay／Task Engine／Adapter／認可を分離する | 単一Node＋SQLiteから開始。認証境界はADR-014、配送storeと構成はADR-016で改訂。durable outbox/inbox等の実能力はG0未確認。仕様採用は実接続・公開・credential発行の承認ではない |
| ADR-014 / 採用 | 2026-10-25 JST：[認証は参加グループ単位、Botの切り分けはアドレス単位](auth-groups.md)。1認証主体に1件または複数の所属個体を紐付ける | グループ内のBot本人性は要求しない。グループ外の名義使用・受信箱閲覧を拒否。Registryのopt-in拡張を実装。基本5操作のMCP名義選択を実装。常用token更新は未実装で、稼働設定やgrantを変更しない |

## ADR-015 / 採用：共通MCP通信と受信側の判断を分離する

2026-11-04 UTC。標準経路の構成（Relay、NATS実行port）はADR-016で改訂した。受信側の判断・承認の分担は引き続き有効である。基準は[共通MCP接続](common-mcp-connection.md)、[受信supervisor](receiver/receive-supervisor.md)、[Relay責務](hab-messaging-spec.md#3-構成と責務)とする。

- HABは認証・名義・宛先・配送・相関を担当する。受信側hostが定期poll・重複排除・永続保存後ACKを行う。ACKは表示・引受け・実行・承認・完了を証明しない。
- 内容の判断、返信、作業の実行、既存の権限・承認の適用は受信エージェント側が担当する。HABは製品専用モデルrunnerや承認実装を標準接続へ組み込まない。
- 通常の質問・回答にはTaskを要求しない。既存の限定Task、汎用テキストTask、A2A入口、NATS実行portは明示構成する任意機能として保持する。任意機能の実行状態やjournal契約を、共通MCP接続の必須条件へ広げない。
- 製品の既存MCP設定、受信契機、保存先、表示能力の確認は必要である。製品実行APIをHABが呼ぶ専用adapterの追加とは区別する。正式なwake・表示APIがなければ、その能力を未対応・未確認として報告する。

照合基準のmain `c667095` では、ReceiveSupervisorはreceiveのみを反復し、汎用Task入口は通常Relayへ未配線だった。稼働経路の破損を確認した判断ではない。未マージ[PR #132](https://github.com/s-hiraoku/hiraoku-agent-base/pull/132)はHermes固有実行・承認の隔離候補であり、標準接続として採用しない。既存の受信経路を置換するものとして進めず、mainへの取込み・本番有効化は本判断に含めない。

通常通信を任意Task実行に統合する案と、全エージェントへ新たな共通承認UIを必須にする案は採用しない。受信側既存機構へ権限と判断を残すためである。回帰検証は[設計境界の照合記録](history/design-boundary-alignment.md)を参照。

## ADR-016 / 採用：単一host、JetStream配送、エージェントSDKで標準接続を構成する

2026-11-06 UTC。ADR-015の受信側の判断・承認の分担は維持し、標準経路の構成と配送storeをこの判断で改訂する。配送storeの部分（JetStream）は2026-11-13のADR-018でSQLite単独に置き換えた。以下のJetStream・journal schema 4・rollback照合の記述は当時の判断の記録である。基準は当時の`packages/relay-nats/DESIGN.md`（削除済み）、[エージェントSDK](../src/agent-sdk/README.md)、[HAB登録・認可境界](../src/hab/README.md)、[ローカルRelayサービス](host-service.md)とする。

- 配送はNATS JetStreamだけで行う。SQLite配送storeは廃止し、保存済みの旧messageは移行しない。host設定の配送sectionは`delivery`で、旧`store` sectionを含む設定は`config_invalid`で拒否する。
- `src/messaging`がmessage契約と`DeliveryService` interfaceを持つ。`src/hab`のRegistryが名義・認証group・権限・容量を判定する。配送backendは名義や権限を判断しない。
- `src/host`が唯一のhostである。設定、HTTP、監査、管理CLI、MCP server（`src/host/mcp`）を組み立て、JetStream配送を`DeliveryService`として注入する。起動は`npm run relay:local`、管理は`npm run relay:admin`を使う。
- エージェント側は`src/agent-sdk`の永続sender／outbox、保存後ACKのreceiver／inbox、MCP clientを使う。MCP tool名`relay_*`は既存の接続設定との互換のため維持する。
- A2Aはエージェント側のSDKからhostのMCP、`DeliveryService`の順に通す。2026-11-06のowner判断により、A2A gatewayはhost所有のA2A名義でhostへ配線する（下記「次に決める内容」5、[A2A host配線](a2a/a2a-host-preview.md#host-wiring-with-a-host-owned-identity)）。hostは設定の`a2a` sectionがある場合だけ、専用のRegistryアドレスと永続mailbox（agent-sdkのoutbox/inbox）を起動時に冪等に用意し、A2A Taskをその名義から送り、受信者はその名義へ返信する。呼出し元エージェントのmailboxは読まない（受信者1件1leaseと、そのエージェント自身の保存後ACK受信と衝突するため）。返信は依頼の期限から1日の返信期間だけ保存する。2026-11-07のowner判断により、期間内に結果が反映されなかったTaskは標準の`FAILED`へ移し、理由`result_window_expired`と「受信者が実行したかは不明」の旨をstatusに示す。WORKINGのまま残さず、独自のA2A状態も追加しない。期間後の返信は記録せずACKし、Taskは変えない。新しいmessage IDの返信は、Taskを変える場合だけ保存する。保存の前に受信loopが保存済みTaskの写しへ適用し、ACK確認済みの保持返信だけを根拠にする。状態を変えない返信やTaskが拒否する返信は、期間後の返信と同じく記録せずACKする。未確認の保持返信が確定した場合だけ重複または競合する新IDの返信は、容量を守るため保存もACKもせず保留する。有限のlease再試行やTTLにより保留返信がquarantined／expiredになる場合があるため、送信者はstatusを確認する。未確認返信を適用したり、回復を必ず保証したりするものではない。確認済みの状態から重複と判断できる返信はACK履歴の枠を使わない。保留された返信の到達やTaskの完了は保証しない。inboxが保持しているIDは必ずinboxへ渡すので、重複排除と未確定ACKの確定は保たれる。返信期間が閉じる時刻はTask storeの次の期限から求め、最も早い期間が閉じた受信cycleから、tenant・owner・idの安定キーで1回100件まで処理する。個別保存の失敗を越えて次のページへ進み、一巡後の次回処理で再試行する。呼出し元はA2A用credentialで認証し、Registryが呼出し元自身の`resolve`・`submit`と宛先への`execution_request`送信権を毎回判定するため、host名義は呼出し元が直接送れない相手へ届かず、他者の返信も読ませない。`DeliveryService`契約、lease規則、`relay_*` MCP toolは変更しない。
- 汎用NATS実行port（`src/generic-nats`）、管理添付、SQLite snapshot bundleは削除した。task-bridge、answer-intents、adapter-hostは今回の構成変更の対象外として保留する。

配送storeを二重に持つ案（SQLiteとJetStreamの併用・route切替）は採用しない。旧storeとの照合・rollback経路を保守し続ける費用が、移行しない旧messageの損失より大きいためである。配送journalはschema 4になり、それ以前のbuildは同じjournalで起動できない。旧buildへ戻す場合は、移行直前の整合backupを全部同じ世代で復元する。新releaseが受け付けたmessageと、backup時点で未完了だったmessageを元IDで照合する。backup時に未完了のIDだけでなく、backup後の新規IDも、新journalの行が回収されても受信inboxや実行記録に残る証拠から照合対象へ加える。どの写しにも残らないIDはこの一覧だけでは列挙できない。journalの`expired`・`quarantined`は未配達の証明にならず、受信者のinbox・Task結果・実行記録で判断する。復元した状態のIDがすべて期限切れになるまで旧buildを起動しないので、新releaseで実行済みのIDはRelayから再配達されない。ACKは保存の証明で実行の証明ではないため、backup時に受信inboxへ保存済み・未処理だった本文も照合する。復元inboxは期限に関係なく保存済み本文を渡すので、受信者を再開する前に写しの実行記録と照合し、実行済みの本文は再処理させない。backup後に保存され、新inboxの写しだけに未解放で残る本文も別に照合する。drainと期限待ちはその本文を復元先へ移さない。実行記録やTask状態から未引渡しと確認できた場合だけ、元のsender/message IDと重複排除を保つアプリ固有のローカル復旧手順で写しから引き継ぐ。未確認の副作用、欠けた写し、矛盾があれば停止を保ち、自動再送、別ID化、期限延長を行わない（当時の手順は削除済みの`packages/relay-nats/OPERATIONS.md`。現在の移行と復旧は[配送store](delivery-store.md#back-up-and-restore)）。本判断は本番接続・公開・credential発行の承認を兼ねない。

2026-11-12 JSTのowner確認：旧Relayは廃止し、**配送はNATS JetStream、エージェント間の相互運用はA2Aへ置き換えた**ものとする。A2Aはhost所有名義の入口として採用し、既定は無効、本番配備は別に判断する。エージェント向けのMCP 5ツール（`relay_*`）はA2Aと並ぶ標準入口として残す。tool名と`relay:local`／`relay:admin`の名前は互換のためだけに残し、文書ではhostと呼ぶ。

2026-11-07のレビュー補足（A2A入口の返信outbox回収）：outbox回収は全件分の返信枠を一括要求せず、上限M、保持行数T、返信期間内のsource数W、今回回収する行数pに対して2×(max(0,M-T+p)+W)件分の本文・byte・ACK履歴・保持行の余裕を確認する。TがM以下なら空き枠F=M-Tとして2×(F+W+p)と同じである。上限を既存行数より下げた場合、超過行の回収だけでは新しい送信枠を生まない。pは100以下で、同一hostの同期区間で集計から回収まで行う。保存エラーの本文を捨てず、期限処理と30日保持は変更しない。通常shutdown、結果期限、identityの永久disconnectは既存の意味を維持する。identity変更による失効解除は提供せず、A2Aを外してMCPだけ起動できる。

## ADR-017 / 採用・実装済み：受信ループをエージェントSDKへ移す

2026-11-12 JST、owner判断。標準受信の基準とした受信supervisor（`ReceiveSupervisor`）は`src/adapter-host`にあり、その`AdapterHostCycle`はADR-016で保留としたtask-bridge・answer-intentsと返信budget（`src/adapter-policy`）を構成時に必要とする。host本体も二重起動防止に`src/adapter-host`の`SQLiteHostOwner`を使う。標準経路が保留部品に依存しないよう、受信supervisor、受信だけを行う最小cycle、process ownerを`src/agent-sdk`へ移す。Task引受け・質問返信intent・返信budgetは`src/adapter-host`に残し、明示構成する任意連携とする。新しいエージェントは`src/agent-sdk`だけで送信と保存後ACKの受信を組み込めることを完了条件とする。

実装：`src/agent-sdk/receive-host.ts`の`HostCore`がstop/epoch control（`sqlite-host-control.ts`）・process owner（`sqlite-host-owner.ts`）・transport管理・認可確認を持ち、`ReceiveHost`はその上で`receive`だけを受け付ける。outbox・返信budget・Task bridgeは不要である。`ReceiveSupervisor`は`receive-supervisor.ts`へ移り、`receive`を実行できる任意のhostを受け取る。`src/adapter-host`の`AdapterHostCycle`は同じ`HostCore`を継承し、送信・回答・Task操作を足した任意連携として残る。公開APIとエラーコードは変えていない。

## ADR-018 / 採用：配送storeをSQLite単独にし、JetStreamとnats-serverを外す

2026-11-13 JST、owner判断。クラウド展開は1台のVMで動かす前提とする。ADR-016の配送構成のうち「配送はNATS JetStreamだけで行う」をこの判断で置き換える。基準は[配送store](delivery-store.md)とする。

- 配送はhostの状態ディレクトリにある1つのSQLiteファイル（`delivery.sqlite`、`src/delivery/sqlite-delivery.ts`）だけで行う。受付・本文・lease・再試行・保存済みACK・秘匿した配送監査を同じtransactionで記録する。受付をcommitした時点で本文も保存され、すぐpollできる。
- `packages/relay-nats`、nats-serverの固定版と導入script、pump、broker設定、CIのJetStream段を削除した。host設定の`delivery`は`volume`・`queue`・任意の`maintenance`だけを持ち、`broker`・`pump`を含む設定は`config_invalid`で拒否する。
- 理由：brokerはloopback専用・1 replica・consumerなしで本文置き場としか使っておらず、受付・lease・再試行・ACK履歴はすでにSQLite journalが持っていた。別processの運用、pumpによる最大1周期の可視化遅延、journalとbroker storeの2つを揃えて戻す復旧手順は、1台構成では利点がない。
- `DeliveryService`契約、MCP 5ツール（`relay_*`）、Registryの認可、agent SDKのoutbox/inbox、A2A入口は変えない。旧JetStream journalのmessageは移行しない。`jetstream-journal.sqlite`が状態ディレクトリに残っている間は`legacy_jetstream_journal_present`で起動を拒否する。移行は送信を止め、最後の受付から1時間と`max_clock_skew_ms`を待ってから旧journalを外す（[手順](delivery-store.md#upgrade-from-the-jetstream-build)）。この待ち時間により旧IDは期限切れになり、新storeで再受付されない。
- 複数host・HA・外部consumerが必要になった場合は、この判断を見直す。そのときはJetStreamをbrokerとして本来の形（consumer、複数replica）で使う案を含めて比較する。本判断は本番接続・公開・credential発行の承認を兼ねない。

## ADR-019 / 採用：Relayの名前を残さず、MCPツールと内部名をhab_*へ作り替える

2026-11-14 JST、owner判断。サービス開始前のため互換性は持たせず、ADR-016で互換のため残した`relay_*`の名前を一括で作り替える。

- MCP 5ツールは`hab_resolve`／`hab_submit`／`hab_status`／`hab_poll`／`hab_ack`、OAuth scopeは`hab:resolve`〜`hab:ack`とし、既存の`hab_discover`とそろえる。旧名のエイリアスは置かない。MCP server名は`hab`、A2A Taskのmetadata keyも`hab`とする。
- agent SDKのSQLite table（`inbox`・`outbox`・`receiver_acks`ほか）、固定エラーコード（`transport_failed`・`host_start_rejected`ほか）、host設定の秘密`delivery_fingerprint_key`、npm script（`hab:host`・`hab:admin`のみ）、script・設定例・試験・文書のファイル名からもrelayを外す。旧名のinbox/outbox DBは開けないため作り直す。
- 配置済みの接続はOAuth scopeの付与、Hermesの`tools.include`、Dotsのコネクタ、受信サービスを新しい名前へ同時に切り替える必要がある。`docs/history`と過去のADR本文は当時の名前のまま残す。

## ADR-020 / 採用：エージェントには送る・読む・返すの4ツールだけを見せ、hostの受信箱で受け取る

2026-11-14 JST、owner判断。Mac miniでのDots⇄Hermes試験で、エージェントが封筒（ID・時刻・期限・宛先ID）を自作して失敗し、理由の違う誤りがすべて`forbidden`に見えた。HABを使う人がこの沼にはまらないよう、MCPをエージェントがしたいことに合わせて作り直す。ADR-019の5ツールは低レベルの配送catalogとして残す。

- **2つのcatalog。** hostの`/mcp`はエージェント用で、`hab_send`（宛先アドレスと本文）・`hab_reply`（受け取ったmessage_idと本文）・`hab_inbox`・`hab_status`と、有効なら`hab_discover`だけを出す。`/mcp/delivery`は agent SDK と受信サービス用で、`hab_submit`・`hab_status`・`hab_poll`・`hab_ack`・`hab_resolve`（と`hab_discover`）を出す。同じ接続のcredentialで両方を開ける（OAuthのresourceは`/mcp`のまま）。どちらを出すかはhost codeが決め、呼出し側は選べない。
- **封筒はhostが作る。** `hab_send`はアドレスを解決し、`rm1.`形式のID、送信時刻、7日の期限、新しいthread（または指定のthread）、`kind`（既定`question`）を埋める。`hab_reply`は元の送信者・同じthread・`in_reply_to`を埋め、questionへの返信は`answer`、それ以外は`notice`にする。期限を過ぎた元メッセージへの返信は、既読でも`reply_target_expired`。
- **hostの受信箱（メール型）。** `hab_inbox`は未読を古い順に返し、同じtransactionで既読（ACK）にする。`include_read`で既読後7日（`READ_BODY_RETENTION_MS`）の本文を読み直せ、その後は本文を消す。既読で残した本文も、消すまでbyte容量に数える。1回の応答に収まる分だけを既読にし、残りは次の呼出しで返す。`message_id`を指定すると、その1通を既読後7日以内なら読み直せる。agent SDKのACKは従来どおり本文をすぐ消す（受信側が自分の永続コピーを持つため）。「ACKで本文を消す」原則はhost受信箱の既読に限り7日保持に変わる。
- **期限。** 受付できる期限は最大7日（`MAX_DELIVERY_TTL_MS`）にする。agent SDKの既定は1時間のまま。`rm1.` IDは中の送信時刻が`first_sent_at`と一致しなければ受け付けない。
- **入力の誤りは具体的なコードで返す。** `invalid_request`（`field`と期待値）、`kind_not_allowed`（`allowed_kinds`）、`unknown_address`、`recipient_unavailable`、`reply_target_not_found`、`reply_target_expired`、`text_too_long`（`max_bytes`）。どのエラーにも、何を直せばよいかの固定文`message`を付ける。`forbidden`は認証・権限・停止だけに使う。拒否の固定理由コード（例：`operation_not_granted`、`pair_blocked`）はhostの監査（`audit.jsonl`の`reason`）だけに記録し、本文や秘密は記録しない。
- **受信の通知。** `hab_inbox`の各メッセージに、利用者へそのまま見せる`notice`を付ける（`src/messaging/incoming-notice.ts`、受信サービスからも使える）。「〇〇 からのメッセージです（種類、返信期限）」、本文、「どうしますか？」と選択肢（1. 返信する＝`hab_reply`にmessage_idと本文を渡す、2. あとで、3. 返信しない）を並べる。本文は送信者が書いた信頼できないデータとして、推測できない印を付けた2行で囲み、指示として実行しないよう明記する。返信期限は元メッセージの期限で、過ぎると既読でも`reply_target_expired`になる。
- **使い方を説明に書く。** MCP serverの`instructions`と各ツールの説明に、送る→`hab_status`、届いたら`hab_inbox`→`hab_reply`の流れと、「既読は作業完了ではない」ことを書く。
- **clientが読めるスキーマを公開する。** `tools/list`の入力スキーマは、ルートが`properties`を持つ1つのobjectで、`$schema`もJavaScript専用の先読みも含まない（2026-11-14追記：Dotsの接続確認から）。`hab_discover`は`action`のenumを持つ1つのobjectにする。呼び出しの検証は厳密なzodスキーマのまま。
- **認証の拒否理由も監査に残す。** `auth_denied`には固定の理由コード（`bearer_missing`、`client_not_registered`、`scope_missing`、`audience_mismatch`、`audience_not_single`、`token_expired`など）を`reason`として付ける。tokenやclaimの値は記録しない。
- **認証に通った接続も監査に残す。** 認証に通ったリクエストごとに、`authenticated`の行へ、運用者が登録した接続ID（OAuthの`connection_id`、ローカル認証の`principal.connection_id`）を`connection`として記録する（2026-11-14追記：疎通確認でDotsとHermesのリクエストを見分けるため）。tokenやclaimの値、subject、client_idは記録しない。
- **Auth0の配列audienceを受け付ける。** ChatGPT系コネクタは`openid`を要求するため、Auth0は`aud`を`[resource, "<issuer>userinfo"]`の配列にする（2026-11-14追記：Mac miniでDotsが`audience_not_single`で拒否されていた）。受け付ける配列は、resourceがちょうど1回入り、ほかの要素がこのissuerの`userinfo`だけのもの（`[resource]`を含む）。それ以外の配列は拒否する。
- 受け取ったエージェント（Hermesなど）を自動で起こす仕組みは本判断に含めない。別のADRで決める。配置済みのHermes・Dotsは`tools.include`をエージェント用4ツールへ、受信サービスの接続先を`/mcp/delivery`へ切り替える。

## ADR-021 / 採用：届いたメッセージを受信側エージェントの画面に出し、「対応する」を選んだときだけ同じセッションへ渡す

2026-11-14 JST、owner判断。ADR-020の受信通知は、エージェントが自分で`hab_inbox`を呼んだときにしか出なかった。ownerが以前指示した「〇〇からのメッセージです。受信内容……どうしますか？」を、届いた時点で受信側の画面に出す。Hermes専用にせず、どのエージェントにも同じ形でつなげるようにする。

- **既読にしない新着の取得。** `/mcp/delivery`に`hab_peek`を加える（操作は`poll`）。受信者の未読を古い順に返し、既読にも変更にもしない。`next_cursor`を`after`に渡すと続きを返すので、選択待ちの古い未読が多くても新着が埋もれない。各メッセージは送信者の不変ID`sender_id`と`message_id`の組で区別する。選んだ後に既読にするのは`hab_mark_read`（同じ`poll`、`sender_id`と`message_id`の両方を指定し、本文は返さない）。2人の送信者が同じ`message_id`を使っても、選ばなかった方は既読にならない。エージェント用の`/mcp`は4ツールのまま。
- **文面はHABが作る。** `hab_peek`の各メッセージに、利用者へ見せる`display`（「〇〇 からのメッセージです。」「（種類、返信期限）」「受信内容」と本文、「どうしますか？」と 1. 対応する 2. あとで 3. 対応しない）と、「対応する」の後に同じセッションへ渡す`handoff_prompt`（本文を推測できない印の2行で囲み、利用者の指示ではないことと`hab_reply`の使い方を書く）を付ける。`hab_inbox`の`notice`の選択肢も同じ言葉（対応する／あとで／対応しない）に揃える。
- **受信通知アダプタ（`src/agent-notify/`、`npm run hab:notify`）。** 受信者の credential で`hab_peek`を定期的に呼び、未表示の新着を画面に出し、利用者の選択を記録する。共通部分はHABが持つ：新着の検出、文面、選択の記録（SQLite）、二重実行の防止。各エージェントが用意するのは`AgentScreen`の2つの操作だけ：`show`（そのセッションの画面に出す。モデルを動かさない）と`handoff`（「対応する」の後にそのセッションへ渡す）。製品に依存しない`JsonlScreen`（イベントをJSON Linesで書き、製品側の連携が読む）を同梱する。
- **選択ごとの動き。** 届いただけではモデルを動かさない。「あとで」は未読のまま残し、`show-again`で同じメッセージを出し直せる。「対応しない」は既読にして何も始めない。「対応する」は既読にしてから、検証済みの同じセッションへ`handoff_prompt`を1回だけ渡す。返信はそのセッション自身が`hab_reply`で行い、アダプタは返信しない。
- **状態を区別する。** `showing`（画面に出す途中。中断したら次の確認で出し直す）・`shown`・`later`・`declined`・`accepting`・`started`（セッションが受け付けた）・`queued`（製品の入力に入れたが開始は未確認）・`unsupported`（そのセッションへの正式な入口がない）・`unknown`（渡せたか分からない）・`unavailable`（選んだ時点でHABがもう渡さない：期限切れ、7日の読み直し期間後、送信者の権限取消し。何も渡さない）・`expired`。`unknown`と`unsupported`は自動で再送せず、別のセッションや同じアドレスのCLIで代用しない。二重クリック、再起動、並行の選択でも渡すのは1回まで（行単位の条件付き更新）。選択の記録は1つのセッション（`target`）に結び付け、別のセッション向けに開くと`notices_target_mismatch`で拒否する。既読にできなかったときは何も始めず、選び直せる。記録ファイルは本文を含むので所有者だけが読める権限（0600）で作り、他人が読める既存ファイルは拒否する。
- **権限と費用。** 受信時に自動でターンを始めることは本判断に含めない（ownerの受入条件：受信だけではモデルの作業や返信を始めない）。「対応する」は、そのメッセージへの対応の開始であり、外部送信・ファイル変更・認証情報の操作などの権限を広げない。受信側エージェントは既存の権限と承認の手順で処理する。
- **限界。** HABの既読は、人が内容を見た・同意した・作業を終えたことを意味しない。Hermes Desktopへの接続部品と、既存Desktopセッションでの受入確認は未完了（[受信通知アダプタ](receiver/arrival-notifier.md)）。Codex（app-server の `turn/start`）・Claude Code（status line と channel）・ChatGPT コネクタ（Dots、表示のみで引渡しは `unsupported`）の画面アダプタも用意したが、実機での確認は未実施。ADR-017のSDK受信（保存してからACK）と同じ受信者に並べると、ACKされた本文は`hab_peek`・`hab_inbox`に出ない。1つの受信者にはどちらか一方を使う。

## 次に決める内容

1. Hub外部resource URLとdiscovery route。既存MCPのclient/認証を確認し、既存routeへの干渉がない案を承認する。
2. Auth0 issuer、正確なcallback、主体/clientと最小scope、無料条件、秘密保管とrevocation。
3. 今回のHermes inventoryの実行環境とprivate binding、$0モデル枠、単発停止・回収条件。
4. Dots/Grokの実MCP呼出し・結果取得と、wakeまたはEventsを追加する必要性。
5. ~~A2A gatewayをhostへ配線するか~~ 決定済み：host所有のA2A名義で配線する（ADR-016、owner判断 2026-11-06）。既定は無効。結果は受信者の永続返信による報告（`attestation: "recipient_reply"`）で、受信者engineの独立検証ではない。

個別のtechnical contractは[Hub内部設計](history/task-engine.md)、[Auth0](history/auth0-boundary.md)、[import境界](history/hermes-import-boundary.md)を参照してください。重複する設定表を増やさず、そちらを更新します。

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

