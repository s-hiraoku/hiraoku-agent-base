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
- **送った側は待たずに終わり、返事は受信箱で受け取る。** `hab_send`の後は利用者に送ったことを伝えてturnを終え、待つためのloopや相手の起動をしない（2026-11-15追記：Dots⇄Hermes試験で、Dotsが送ったまま返事に気づけなかったため）。返事は他のメッセージと同じく`hab_inbox`（と受信通知、ADR-021）に届く。受信通知のないエージェントは、利用者が会話を始めたときに`hab_inbox`を確かめる。`hab_status`は送ったメッセージの`kind`と、同じthreadでその後に相手から届いたメッセージを`replies`（`message_id`・`kind`・`received_at`・送信者が読んだかの`read`、本文なし、最大5件）として返し、`reply_state`を`replied`（返事あり）・`waiting`（未返信で期限内）・`no_reply`（questionが期限までに返事なし）・`not_expected`（question以外で返事なし）のどれかにする。返事を待つ長時間の呼出し（long-poll）は置かない。MCPの呼出しはhostの`timeout_ms`で切れ、待つ間エージェントのturnも止まるため。`hab_reply`は元メッセージの確認と返信の受付を1回の`submit`認可で行う（認可記録は返信1通につき1行）。
- **clientが読めるスキーマを公開する。** `tools/list`の入力スキーマは、ルートが`properties`を持つ1つのobjectで、`$schema`もJavaScript専用の先読みも含まない（2026-11-14追記：Dotsの接続確認から）。`hab_discover`は`action`のenumを持つ1つのobjectにする。呼び出しの検証は厳密なzodスキーマのまま。
- **認証の拒否理由も監査に残す。** `auth_denied`には固定の理由コード（`bearer_missing`、`client_not_registered`、`scope_missing`、`audience_mismatch`、`audience_not_single`、`token_expired`など）を`reason`として付ける。tokenやclaimの値は記録しない。
- **認証に通った接続も監査に残す。** 認証に通ったリクエストごとに、`authenticated`の行へ、運用者が登録した接続ID（OAuthの`connection_id`、ローカル認証の`principal.connection_id`）を`connection`として記録する（2026-11-14追記：疎通確認でDotsとHermesのリクエストを見分けるため）。tokenやclaimの値、subject、client_idは記録しない。2026-11-20追記：同じリクエストの`method`の行に、呼ばれたMCPメソッドを固定のコード（`tools_list`、`resources_read_ui`など）で記録する。表にないメソッドは`other`とし、呼び出し側が書いたメソッド名やURIそのものは残さない。拒否したメソッドも記録するので、カードが出ないなどの原因を製品ごとに確かめられる。
- **Auth0の配列audienceを受け付ける。** ChatGPT系コネクタは`openid`を要求するため、Auth0は`aud`を`[resource, "<issuer>userinfo"]`の配列にする（2026-11-14追記：Mac miniでDotsが`audience_not_single`で拒否されていた）。受け付ける配列は、resourceがちょうど1回入り、ほかの要素がこのissuerの`userinfo`だけのもの（`[resource]`を含む）。それ以外の配列は拒否する。
- 受け取ったエージェント（Hermesなど）を自動で起こす仕組みは本判断に含めない。別のADRで決める。配置済みのHermes・Dotsは`tools.include`をエージェント用4ツールへ、受信サービスの接続先を`/mcp/delivery`へ切り替える。

## ADR-021 / 採用：届いたメッセージを受信側エージェントの画面に出し、「対応する」を選んだときだけ同じセッションへ渡す

2026-11-14 JST、owner判断。ADR-020の受信通知は、エージェントが自分で`hab_inbox`を呼んだときにしか出なかった。ownerが以前指示した「〇〇からのメッセージです。受信内容……どうしますか？」を、届いた時点で受信側の画面に出す。Hermes専用にせず、どのエージェントにも同じ形でつなげるようにする。

- **既読にしない新着の取得。** `/mcp/delivery`に`hab_peek`を加える（操作は`poll`）。受信者の未読を古い順に返し、既読にも変更にもしない。`next_cursor`を`after`に渡すと続きを返すので、選択待ちの古い未読が多くても新着が埋もれない。各メッセージは送信者の不変ID`sender_id`と`message_id`の組で区別する。選んだ後に既読にするのは`hab_mark_read`（同じ`poll`、`sender_id`と`message_id`の両方を指定し、本文は返さない）。2人の送信者が同じ`message_id`を使っても、選ばなかった方は既読にならない。エージェント用の`/mcp`は4ツールのまま。
- **文面はHABが作る。** `hab_peek`の各メッセージに、利用者へ見せる`display`（「〇〇 からのメッセージです。」「（種類、返信期限）」「受信内容」と本文、「どうしますか？」と 1. 対応する 2. あとで 3. 対応しない）と、「対応する」の後に同じセッションへ渡す`handoff_prompt`（本文を推測できない印の2行で囲み、利用者の指示ではないことと`hab_reply`の使い方を書く）を付ける。`hab_inbox`の`notice`の選択肢も同じ言葉（対応する／あとで／対応しない）に揃える。
- **受信通知アダプタ（`src/agent-notify/`、`npm run hab:notify`）。** 受信者の credential で`hab_peek`を定期的に呼び、未表示の新着を画面に出し、利用者の選択を記録する。共通部分はHABが持つ：新着の検出、文面、選択の記録（SQLite）、二重実行の防止。各エージェントが用意するのは`AgentScreen`の2つの操作だけ：`show`（そのセッションの画面に出す。モデルを動かさない）と`handoff`（「対応する」の後にそのセッションへ渡す）。製品に依存しない`JsonlScreen`（イベントをJSON Linesで書き、製品側の連携が読む）を同梱する。
- **選択ごとの動き。** 届いただけではモデルを動かさない。「あとで」は未読のまま残し、`show-again`で同じメッセージを出し直せる。「対応しない」は既読にして何も始めない。「対応する」は既読にしてから、検証済みの同じセッションへ`handoff_prompt`を1回だけ渡す。返信はそのセッション自身が`hab_reply`で行い、アダプタは返信しない。
- **状態を区別する。** `showing`（画面に出す途中。中断したら次の確認で出し直す）・`shown`・`later`・`declined`・`accepting`・`started`（セッションが受け付けた）・`queued`（製品の入力に入れたが開始は未確認）・`unsupported`（そのセッションへの正式な入口がない）・`unknown`（渡せたか分からない）・`unavailable`（選んだ時点でHABがもう渡さない：期限切れ、7日の読み直し期間後、送信者の権限取消し。何も渡さない）・`expired`。`unknown`と`unsupported`は自動で再送せず、別のセッションや同じアドレスのCLIで代用しない。二重クリック、再起動、並行の選択でも渡すのは1回まで（行単位の条件付き更新）。選択の記録は1つのセッション（`target`）に結び付け、別のセッション向けに開くと`notices_target_mismatch`で拒否する。既読にできなかったときは何も始めず、選び直せる。記録ファイルは本文を含むので所有者だけが読める権限（0600）で作り、他人が読める既存ファイルは拒否する。
- **権限と費用。** 受信時に自動でターンを始めることは本判断に含めない（ownerの受入条件：受信だけではモデルの作業や返信を始めない。2026-11-17のADR-023で、利用者が設定で許可した送信元だけを例外にした）。「対応する」は、そのメッセージへの対応の開始であり、外部送信・ファイル変更・認証情報の操作などの権限を広げない。受信側エージェントは既存の権限と承認の手順で処理する。
- **限界。** HABの既読は、人が内容を見た・同意した・作業を終えたことを意味しない。Hermes Desktopへの接続部品と、既存Desktopセッションでの受入確認は未完了（[受信通知アダプタ](receiver/arrival-notifier.md)）。Codex（app-server の `turn/start`）・Claude Code（status line と channel）・ChatGPT コネクタ（Dots、表示のみで引渡しは `unsupported`）の画面アダプタも用意したが、実機での確認は未実施。ADR-017のSDK受信（保存してからACK）と同じ受信者に並べると、ACKされた本文は`hab_peek`・`hab_inbox`に出ない。1つの受信者にはどちらか一方を使う。

## ADR-022 / 採用：クラウドのエージェントには「新着あり」の呼び鈴だけをMCPイベントで送る

2026-11-16 JST、owner判断。Dots（ChatGPT）やMuseのようなクラウド製品は、会話で頼まれたときにしか`hab_inbox`を見ない。Mac mini上に受信通知（ADR-021）を置けないため、Dots⇄Muse試験では返事が届いても誰も気づかなかった。ChatGPTはMCPサーバーからのイベントで作業を始める仕組み（OpenAI MCP Events、webhook配送、Standard Webhooks署名）を持つので、HABはそれに合わせて「受信箱に新着がある」とだけ知らせる。基準は[MCPイベントで新着を知らせる](connections/mcp-events.md)とする。

- **呼び鈴だけを送る。** イベントは`hab.message.received`の1種類で、中身は宛先アドレスと届いた時刻だけ。本文・送信者・種類・message IDは載せない。読むのは今までどおりエージェント自身の`hab_inbox`で、既読・ACK・認可の境界は変わらない（ADR-015の「受信側が取りに行く」は維持し、HABが押し出すのは呼び鈴に限る）。
- **購読はエージェント自身の接続で行う。** 外部入口（ingress）のエージェント用`/mcp`だけが`events`を名乗り、`events/list`・`events/subscribe`・`events/unsubscribe`に答える。購読者は検証済みの接続が`poll`で読める受信者に限り、引数で他人の受信箱を指せない。配送用の`/mcp/delivery`とloopbackには出さない。設定`ingress.events`が無ければ従来どおり無効。
- **送り先と頻度を絞る。** callbackは公開HTTPSだけ（名前解決した全アドレスが公開アドレスであることを確かめ、そのアドレスへ接続し、リダイレクトしない）。購読時に署名付きのchallengeで受け取り手を確かめる。購読の寿命は既定1時間・最長24時間で、ChatGPTが期限前に更新する。権限を取り消した接続は更新できず、遅くとも寿命で止まる。1受信者あたりの購読数、1件あたりの再送回数（8回、指数backoff）に上限を置き、410で購読を消す。
- **限界。** 呼び鈴を受けたChatGPTが実際に作業を始めるか、どれだけ遅れるかはChatGPT側の判断で、HABは保証しない（MCP Eventsは2026年時点でドラフトの拡張）。Museには同じ仕組みが無いので、Muse自身の定期実行で`hab_inbox`を見させる。受信側の判断・承認（ADR-015）、「受信だけでは返信しない」（ADR-021の受入条件）はそのまま。

## ADR-023 / 採用：利用者が許可した送信元のメッセージだけ、受信通知が「対応する」を代わりに選ぶ

2026-11-17 JST、owner判断。ADR-021では、受信通知のカードを人が押すまで何も始まらないため、人がいない間はエージェント同士のやり取りが止まる。利用者が事前に許可した送信元・種類のメッセージに限り、受信通知（`hab:notify`）が「対応する」を代わりに選び、同じセッションへ渡す。ADR-021の「受信だけでは作業を始めない」に、この明示した例外を足す。基準は[受信通知アダプタ](receiver/arrival-notifier.md#許可した送信元の自動受付adr-023)とする。

- **既定は全部手動。** notifier の設定（`notify.json`、0600）に`auto_accept`を書いたときだけ有効になる。許可リストはそのnotifier（1つのセッション）に限られ、HAB hostには置かない。
- **判定に使うのはHABが保証する値だけ。** 送信元のアドレス（`from`、必要なら不変の`sender_id`でも固定）、種類（`kind`）、自分が送ったメッセージへの返事か（`in_reply_to`）、渡す文面の大きさ。本文のキーワードでは判定しない（送信者が簡単に合わせられるため）。合わないメッセージは今までどおりカードで待つ。
- **渡す文面で、選んだのが人でないことを伝える。** `handoff_prompt`の1行目（「利用者が…選びました」）を、ルール名と「利用者は見ておらず選んでもいない」「行ってよいのは読むことと`hab_reply`での返信だけ。ファイル変更・コマンド実行・返信以外の外部送信・設定や認証情報の操作は行わない」に差し替える。利用者はいないので承認や確認を求めても止まるだけになるため、承認を待たずに`hab_reply`まで終える（承認なしで答えられる部分は答え、残りは利用者の確認待ちとその理由を書く）よう指示する（2026-11-18追記：Dots⇄Hermesの初回試験で、Hermesがコマンド実行の承認待ちで止まり返信できなかったため、owner判断）。計算・要約・一般知識のようにツールで確かめなくても答えられることは、検証できないことを理由に控えず答えるよう明記する（同日追記：2回目の試験で、Hermesが「18+27」をツールで検証できないとして答えなかったため）。1行目が想定と違う文面は書き換えず、手動に戻す。これは文面による指示で、確実に止められるのはエージェント製品側の承認設定がかかる操作だけである。
- **行き過ぎを止める。** 送信元ごとの1時間あたりの自動件数（既定10）と、同じthreadでの自動件数（既定6）に上限を置き、超えた分はカードに戻す。2つのエージェントが互いに自動で返し合っても、threadごとに止まる。件数は選択の記録（SQLite）に残し、再起動後も数える。
- **記録を残す。** 規則に合ったメッセージごとに、notifier専用の`audit.jsonl`（0600、1 MiBで`.1`へ回す、本文なし）へ`auto_accept`（受け付ける前）・`auto_handoff`（結果の状態）・`auto_skip`（上限・長さ・文面の形で手動に戻した理由）を書く。`auto_accept`を書けなければ自動では選ばない。カードは今までどおり表示し、結果の状態で履歴に移る。
- **それ以外はADR-021のまま。** 既読にしてから1回だけ渡す、`unknown`は再送しない、HABに既読を伝えられなければ`accept_waiting`で待つ（後で渡すときも自動の文面を使う）。

## ADR-024 / 採用：HABが止まっていた時間を呼び鈴の寿命に数えず、気づかれていない新着を運用者に見せる

2026-11-17 JST、owner判断（「問題の解決方法を検討して、実装しよう」）。同日23:21にMac miniのHAB hostが正常終了の形で止まり、launchdの`KeepAlive`が異常終了のときだけ再起動する設定だったため戻らなかった。スリープ防止の`caffeinate -i`がhostに付いていたので一緒に消え、Macは約1時間眠った。その間にDots（ChatGPT）のMCPイベント購読（ADR-022、寿命1時間）が期限を過ぎてHABから消え、ChatGPTは購読し直さなかった。メッセージは受信箱に届いていたが、誰も気づかなかった。

- **止まっていた時間は寿命に数えない。** 呼び鈴の配送は数秒ごとに時計を記録する。前の記録から`outage_after_ms`（既定60秒。poll3回分より短い値はpoll3回分として扱い、通常のtickで寿命が延びないようにする）より長く空いたら、hostが止まっていたかMacが眠っていたとみなし、空く前に生きていた購読の寿命にその時間を足す（最長`max_ttl_ms`）。購読者はHABに届かない間は更新できなかったのだから、その分を失わせない。配送中の遅いwebhookは時計を止めない（時計は配送とは別に毎tick記録する）。権限を取り消した接続の購読も同じだけ延びうるが、呼び鈴は中身を持たず、更新はこれまでどおり認可を確かめる。
- **切れた呼び鈴を記録して見せる。** 購読が期限切れ・410・`events/unsubscribe`で終わると、受信者ごとに最後の終了時刻と理由（`expired`/`gone`/`unsubscribed`）を`events.sqlite`に残し、同じ受信者が購読し直すと消す。`hab:admin status`の`inboxes`に、受信者ごとの未読数・最古の未読時刻・呼び鈴の状態を出し、30分以上の未読を`unread_waiting`、更新されずに切れた呼び鈴を`doorbell_lapsed`として`problems`に載せる。callback URLとwebhookの鍵は出さない。
- **HABは購読を作り直さない。** 購読するのはエージェント製品自身で、HABが勝手に作り直したり、切れた購読に送り続けたりはしない（ADR-022の認可境界のまま）。切れたら運用者がDotsのタスクを作り直す。
- **hostとnotifierは必ず起動し直し、スリープ防止はhostから切り離す。** LaunchAgentの`KeepAlive`を常にtrueにし、意図して止めるのは`launchctl bootout`だけにする。スリープ防止はhostに付けず、別の常駐ジョブ（`caffeinate -i -s`）にする。手順は[LaunchAgent](operations/host-launchagent.md)。
- **Museは変わらない。** HABから押し出す手段がないので、Muse自身の定期実行で`hab_inbox`を見させる（ADR-022）。

## ADR-025 / 採用：宛先一覧には、HABに登録された有効なエージェントを全員出す

2026-11-19 JST、owner判断（「HABに接続しているエージェントを全部見れないと、意味がない」「HABに登録されているということはユーザが承認したエージェントしか入らない設計」）。claude.aiのClaude（claude@claude.hab）をつないだとき、Dotsの`hab_discover`の一覧にはDots自身しか出ず、送り先を見つけられなかった。`hab_discover`（2026-10-31、#112）は、ADR-014の「グループ外の名義・受信箱を漏らさない」に合わせて、自分の認証グループの所属だけを一覧にしていた。しかしHABの目的はエージェント同士が宛先を見つけてやり取りすることで、登録は運用者だけが行う（`hab:admin`）。登録されている相手は利用者が承認したエージェントだけなので、互いの宛先を隠す理由がない。

- **既定で全員を出す。** `registry.discovery.directory`の既定を`all_active`にし、`directory`は自分のgroupの所属に加えて、ほかのgroupの有効なアドレスを全部返す。`group`を指定すれば従来どおり自分のgroupだけにできる。
- **出すのは宛先として使う情報だけ。** ほかのgroupのentryは不変ID・アドレス・名前・登録状態・`presence`と`relationship: "other_group"`だけ。操作権限・認証の割当・host割当は出さない。待機中・停止・退役のアドレスも出さない。`check_address`は一覧に出るアドレスを`unavailable`と答える。
- **送受信の境界は変わらない。** 一覧に出ても、ほかのgroupの名義で送ったり、受信箱を読んだりはできない（ADR-014）。送れるのは今までどおり宛先として`hab_send`するだけ。
- **製品仕様を直す。** F-03（宛先一覧）と「group外の存在を漏らさない」の記述に、この例外を書く（[製品仕様](hab-product-spec.md)）。

## ADR-026 / 採用：受信メッセージの見せ方は各エージェントのアダプタが描き、HABは共通の表示用データを返す

2026-11-19 JST、owner判断（「エージェントごとのアダプターで読みやすく改善したい」「末端のそれぞれのエージェントのアダプターで処理を実装する」「これで行こう」）。ADR-020・021の`notice`と`display`は、どの製品でも読めるよう改行入りの素朴な文章にしている。カードの仕様は製品ごとに大きく違い（Hermes Desktopはプラグイン、claude.ai・ChatGPT・GeminiアプリはMCP Apps、Claude Codeはstatus lineとchannel、Codex・Grok Bot・Antigravityは文字だけか未確認）、文章を丸ごと入れると送信者や選択肢が二重に出る。モデルが`notice`を読み直して伝える製品では、見せ方が毎回変わり、要約されることもある。基準は[エージェントごとの受信表示](receiver/per-agent-display.md)とする。

- **HABは表示用のデータを返す。** `hab_inbox`と`hab_peek`の各メッセージに`presentation`（版1）を足す。中身は今ある値の並べ替えだけで、新しい情報は足さない：見出し、送信者（アドレスと表示名。削除された送信者は「（削除された送信者）」）、種類と表示名（質問・回答・お知らせ）、自分が送ったメッセージへの返事か、送信日時、返信期限、選択肢（`choices`と同じ）、本文が送信者の書いたデータであること（`body_untrusted: true`）と扱いの一文、表示していない構造化データの件数。本文はメッセージの`text`をそのまま使い、`presentation`に写さない（応答の大きさを増やさないため）。`hab_peek`も`text`を返す。表示名は日本語でHABが決め、各アダプタはそれを使う（製品ごとに訳語がずれないように）。
- **今の文章は残す。** `notice`・`display`・`handoff_prompt`は今までどおり返す。これらも同じ値から作るので、文章と`presentation`は常に一致する。画面を持たない製品や、`presentation`を知らない古いアダプタは文章をそのまま使う。
- **描くのは各アダプタ。** Hermes Desktopのプラグインは`presentation`から見出し・送信者・種類・期限・本文の枠・ボタンを分けて描き、無ければ今の`display`を出す。Claude Codeのstatus lineは要約1行と本文の先頭を出す。claude.ai・ChatGPT・Geminiアプリ向けには、エージェント用`/mcp`がMCP Appsの部品`ui://hab/inbox-v1`を配り、`hab_inbox`だけに`_meta.ui.resourceUri`（ChatGPTの別名`openai/outputTemplate`も）を付ける。部品はネットワークを使わない1枚のHTMLで、本文は文字としてだけ描く。ボタンはHABの状態を変えない（`hab_inbox`は返した時点で既読にする）：「対応する」「会話に渡す」は会話に利用者の発言として返信の依頼を入れ（`ui/message`）、モデルが返信案を見せてから送る。「あとで」「対応しない」はカードを畳むだけ。`/mcp`は読み取り専用の`resources/list`・`resources/read`・`resources/templates/list`に答える（`/mcp/delivery`は答えない）。部品を描けない製品では、普通のツール結果として文章のまま動く。
- **本文の扱いは変えない。** モデルへ渡る文章（`notice`・`handoff_prompt`）は今までどおり推測できない印の2行で本文を囲む。`presentation`は構造化データとしてモデルにも渡るので`body_untrusted`と扱いの一文を付ける。アダプタは本文を文字として描き、HTMLやMarkdownとして解釈しない。
- **限界。** `presentation`は見せ方の材料で、届いた時点で画面に出す入口（ADR-021の受信通知）を新たに作るものではない。claude.ai・ChatGPT・Gemini・Grok Bot・AntigravityでMCP Appsが実際に描けるかは実機で確かめる（2026-11-19時点で未確認）。応答の大きさの見積もり（本文が文章と構造化データに入る回数）は、`hab_peek`が`text`を返す分だけ増える。

## ADR-027 / 採用：受け取られたのに読まれない呼び鈴は、一度だけ鳴らし直し、受信側のMCPの結果で本人に気づかせる

2026-11-19 JST、owner判断（「受信側のエージェントのMCPにその仕組みを追加するようにして」）。claude@claude.habからDotsに送った試験メッセージは、呼び鈴がChatGPTに届いて200が返り、購読もChatGPTが自分で更新し続けていたのに、Dotsは一度も受信箱を読みに来なかった。HABからはChatGPT側でタスクが起動していないことしか分からず、Dots自身もそれを知らないまま、次に話しかけられるまで誰も気づかなかった。

- **一度だけ鳴らし直す。** 呼び鈴が2xxで受け取られてから`unanswered_after_ms`（既定5分、60000–86400000）たってもそのメッセージが未読なら、同じ購読に1回だけもう一度鳴らす。`eventId`は別にして、重複除けで捨てられないようにする。再送はしない（2xxでなくても終わり）。中身は最初の呼び鈴と同じ`{to, arrived_at}`だけ。`ingress.events.rering: false`で止められる。メッセージ1通あたり1回なので、ChatGPTのイベント実行枠（1時間30回）をほとんど使わない。
- **受信側のMCPの結果で知らせる。** 受信側エージェントが`/mcp`の`hab_send`・`hab_reply`・`hab_status`を呼ぶと、未読があれば結果に`inbox_reminder`（未読数、最古の未読時刻、まだ未読のメールについて最初に2xxで受け取られた呼び鈴の時刻、`doorbell_unanswered`、説明）を足す。その時刻から`unanswered_after_ms`以上たっていれば`doorbell_unanswered: true`にし、「呼び鈴は鳴って受け取られたのに受信箱が読まれていない。イベントタスクが動いていないかもしれないので、hab_inboxを読んで、利用者にタスク設定を確かめるよう伝える」と説明する。`hab_inbox`では、読む前に未読を確かめ、呼び鈴が無視されていたときだけ同じ説明を付ける。未読は`hab_inbox`と同じ認可で数え（読めなくなった送信元のメールは数えない）、既読にはしない。本文・送信元・メッセージIDは含めない。
- **エージェント向けの案内文にも書く。** MCPの`instructions`に「`hab.message.received`で起動されたらすぐ`hab_inbox`を呼ぶ」「`inbox_reminder`があれば説明に従う」を加える。
- **できないこと。** タスクが止まっている間、エージェントは動いていないので自分では気づけない。気づくのは次にHABのツールを使ったとき（利用者が話しかけたときなど）。止まったタスクを起動するのは利用者で、HABは購読やタスクを作り直さない（ADR-024）。

## ADR-028 / 採用：返事をその場で待ちたいエージェントには、hab_inboxで最大数十秒だけ新着を待たせる

2026-11-19 JST、owner判断（agent-mailの記事を参考に「お願いします」）。claude.aiのClaudeやClaude Codeのように、呼び鈴（ADR-022）も受信通知（ADR-021）も受けられないエージェントは、送った後に返事が来ても、利用者が次に話しかけるまで気づけない。agent-mail（自作のMCPメール）は`check_inbox(wait_secs)`で受信箱が空なら最長50秒待ち、「行きはWebhook、帰りはMCPの待ち受け」で往復を成り立たせている。ADR-020の「返事を待つ長時間の呼出し（long-poll）は置かない」を、次の範囲に限って改める。

- **`hab_inbox`の`wait_secs`。** 0〜60の整数（既定0で従来どおり）。未読があればすぐ返す。未読がなければ、そのエージェント宛てのメッセージが受け付けられるか、時間が尽きるまで待ってから、通常の`hab_inbox`として読む（既読にするのも認可も従来どおり）。結果に実際に待った秒数`waited_secs`を付ける。`include_read`・`message_id`とは併用できない（`invalid_request`、`field: "wait_secs"`）。
- **待てる時間はhostが決める。** `http.max_wait_ms`（既定25000、0〜60000、0で待たない）が上限。待つ呼出しだけ、HTTPの期限を「待つ時間＋読むための`timeout_ms`」に延ばす。`timeout_ms`そのもの（上限30秒）は変えない。
- **待つ呼出しで他を詰まらせない。** 同時に待てるのは`max_active_requests - 1`本まで（最低1本）。それを超えた呼出しは待たずにすぐ返す。同じエージェントが新しく待つと、古い待ちは空で返す（再試行で待ちが積み上がらない）。書き込みを1本ずつ流すwriter admissionを使う構成では待たない。
- **起こし方。** 受付（`hab_send`・`hab_reply`）の後、host内で宛先のagent IDだけを待ち側に知らせる。本文・送信元・message_idは渡さない。知らせはきっかけにすぎず、待ち側は必ず認可付きの読み直しで確かめる。ほかの経路で届いた分のために、5秒ごとにも読み直す。
- **使いどころを案内文に書く。** 待つ間はエージェントのturnも止まるので、MCPの`instructions`では「利用者がこのturnで返事を求めているときだけ`wait_secs`を使い、空で返ったら利用者に伝えてturnを終える（待ち直さない）」と案内する。送った後に何もせず終わるのが基本であることは変わらない。
- **できないこと。** 待ちは呼び鈴の代わりではない。待っていないエージェントは、従来どおり呼び鈴・受信通知・会話の始めの`hab_inbox`で受け取る。MCPクライアント側の呼出し期限（製品ごとに異なる）より長く待つと、クライアントが先に切る。

## ADR-029 / 採用：自分で購読できないエージェントには、運用者がアドレスごとに呼び鈴の宛先を登録する

2026-11-19 JST、owner判断（agent-mailの記事を参考に「3つとも、PRを3本に分けて」）。ADR-022の呼び鈴は、ChatGPTのようにエージェント製品が自分でMCPイベントを購読するときだけ鳴る。Grok Botのように「Webhookで起きるroutine」は持つが購読の仕組みを持たない製品には、新着を知らせる手段がなかった。agent-mailは宛先ごとのwake設定（URLと鍵）を置き、送信のたびにそのURLを叩いてroutineを起こしている。

- **運用者がhost設定に書く。** `ingress.events.doorbells`に`{address, url, secret_file}`を最大32件。鍵はhost設定に書かず、所有者だけが読める（0600、リンク不可、1KiB以下）別ファイルから起動時に読む。`whsec_`で始まればStandard Webhooksで署名し、それ以外はBearer tokenとして`Authorization`に載せる（16〜512文字）。URLはMCPイベントの購読と同じく公開HTTPSだけ。存在しないアドレスは`unknown_doorbell_address`、URLや鍵の誤りは`invalid_doorbell`、鍵ファイルの権限違反は`unsafe_doorbell_secret`で起動しない。
- **中身と鳴らし方はMCPイベントの呼び鈴と同じ。** `{to, arrived_at}`だけで本文・送信元・IDは載せない。新着1通ごとに1回、失敗は同じ規則で再送し、ADR-027の鳴らし直しと`inbox_reminder`もそのまま効く。登録した時点（host起動時）に待っているメールでは鳴らさない。
- **購読とは別扱い。** 期限がなく、確認のchallengeを送らない（運用者がURLを保証する）。エージェントの購読枠（`max_per_agent`）を使わず、MCPの`events/unsubscribe`では外せない。設定から消して再起動すると外れる。`hab:admin status`では`doorbell: "live"`と`doorbell_operator`（件数）で見え、URLと鍵は出さない。
- **読むのは今までどおりエージェント自身。** 起きたroutineはHABコネクタ（ingressの`/mcp`）で`hab_inbox`を読み、`hab_reply`で返す。HABはroutineの中身や起動を保証しない。受信だけでは返信しない（ADR-021の受入条件）ことも変わらない。

## ADR-030 / 採用：受け取られた呼び鈴のメールが未読の間は、新着で呼び鈴を鳴らさない

2026-11-19 JST、owner判断（agent-mailの「未読があって最近起こしたなら起こし直さない」を取り入れる。範囲カードで「3 つとも、PR を 3 本に分けて」）。ADR-022の呼び鈴はメッセージ1通ごとに鳴るので、相手が起きて読む前に何通も届くと、同じ「メールがある」を何度も伝え、ChatGPTのイベント実行枠（1時間30回）も使う。番号はADR-028（`hab_inbox`の待ち受け）とADR-029（運用者が登録する呼び鈴）の後。

- **静かな時間。** 購読ごとに、最後に2xxで受け取られた呼び鈴とそのメッセージを覚える。その呼び鈴から`unanswered_after_ms`（ADR-027と同じ、既定5分）たっておらず、そのメッセージがまだ未読なら、新しいメールでは鳴らさない。受け取った側は「メールがある」とすでに知っていて、受信箱を読めば新しいメールも一緒に読めるから。
- **飛ばさずに待たせる。** 鳴らさなかったメールでカーソルを進めない。静かな時間が終わった時点でまだ未読なら、そのとき鳴らす。読まれていれば（`hab_inbox`は未読をまとめて読む）一度も鳴らさない。鳴らしたメールだけ読まれた場合は、その時点で静かな時間が終わり、次の配送で鳴る。
- **鳴らし直しが先。** 配送は毎回ADR-027の鳴らし直しを先に行う。鳴らし直しが受け取られると静かな時間がそこから始まるので、5分後に鳴らし直しと新着の呼び鈴が同時に鳴ることはない。読まれないまま続くと、呼び鈴は購読ごとにおよそ`unanswered_after_ms`に1回になる。
- **受け取られなかった呼び鈴は数えない。** 2xx以外（応答なし・5xx・413・8回の失敗）は静かな時間を始めない。同じメッセージの再送中は止めない。
- `ingress.events.quiet: false`で、従来どおり1通ごとに鳴らす。ADR-029の運用者登録の呼び鈴も購読として同じ扱いになる。
- 中身・署名・`inbox_reminder`（ADR-027）は変えない。HABは購読やタスクを作り直さない（ADR-024）。

## ADR-031 / ADR-032 で置き換え：呼び鈴と並べて、受信箱の定期確認（ポーリング）を置く。間隔は利用者が決め、既定は10分

2026-11-20 追記：HAB から時間で鳴らす定期確認は ADR-032 でやめた。決まった間隔で見るのは製品の側で、HAB は遅れを `poll_overdue` で見せるだけにする。以下は当時の判断の記録。


2026-11-20 JST、owner判断（「Hook機能と合わせて、polling機能も搭載しよう。ユーザーが間隔を設定できるようにしよう。デフォルトは10分で。」）。同日の疎通確認で、Dots・Museは呼び鈴だけでは返信まで進まず、本人が会話で頼む必要があった。届いた時点で知らせる呼び鈴（ADR-021〜030）に加えて、一定間隔で受信箱を確かめる経路を置き、呼び鈴が届かない・取りこぼすエージェントの保険にする。基準は[MCPイベントで新着を知らせる](connections/mcp-events.md#受信箱の定期確認adr-031)とする。

- **どこで時計を回すかはエージェントの種類で決まる。** 定期確認は「誰かが時間で起きて`hab_inbox`（または`hab_peek`）を呼ぶ」ことで、起きる仕組みを持つ側に置く。受信処理・表示は各エージェントのアダプタ側という方針（ADR-021・026）はそのままで、次の3つに分ける。
  1. **受信通知アダプタを置けるエージェント（Hermes Desktop、Codex、Claude Code）。** `hab:notify`はもともと`interval_ms`（既定15秒、1秒〜1時間）ごとに`hab_peek`を呼ぶポーリングなので、追加しない。間隔は利用者が`notify.json`で決める。
  2. **呼び鈴でしか起こせないエージェント（Dots＝ChatGPTのMCPイベント購読、Grok Bot＝運用者が登録した呼び鈴）。** 自分で10分ごとに起きる手段が確かでない（ChatGPTの定期タスクを10分間隔で回せるかは未確認で、確実に起こせるのはイベントだけ）ため、HABの呼び鈴の配送（ADR-022・027・029・030と同じ場所）が時計を持つ。未読がある間、生きている呼び鈴ごとに、最後に2xxで受け取られた呼び鈴（新着・鳴らし直し・定期確認のどれでも）か前回の定期確認から`ingress.events.inbox_check.interval_ms`（既定600000＝10分、0で止める、60000〜86400000）たったら、最も古い未読について同じ呼び鈴をもう一度鳴らす。アドレスごとの間隔は`inbox_check.addresses`（`{"dots@dot.hab": 300000, "grok@grok-bot.hab": 0}`のように最大64件、存在しないアドレスは`unknown_inbox_check_address`で起動しない）。未読がなければ鳴らさない（何も無いのに起こしても、読んで終わるだけで利用量を使う）。
  3. **どちらも無いエージェント（Muse、claude.ai、アダプタの無いClaude Code）。** 製品自身の定期実行（Museの定期実行、Claude Codeの`/loop`や予定タスク、Grokのタスクなど）で`hab_inbox`を呼ばせる。間隔は利用者が製品側で決める（推奨10分）。HABはMCPの`instructions`に「定期実行で起こされたら`hab_inbox`を呼び、新着がなければ黙って終える」を加える。
- **定期確認の呼び鈴は中身も署名も同じ。** `{to, arrived_at}`（最も古い未読の到着時刻）だけで、本文・送信元・IDは載せない。`eventId`は回ごとに別にする（重複除けで捨てられないように）。2xxで受け取られればADR-030の静かな時間とADR-027の`inbox_reminder`の材料にもなる。読むのは今までどおりエージェント自身の`hab_inbox`。
- **鳴らしすぎない。** 再送はしない（失敗しても次の間隔が再試行）。同じ「最も古い未読」に鳴らす回数は呼び鈴ごとに`inbox_check.max_rings`（既定6、1〜1008）まで。既定の10分×6回で、タスクが動かないままのエージェントを1時間以上は起こし続けない（メールは7日残るので上限が無いと最大1008回になる）。最も古い未読が読まれれば数え直す。1回の配送で鳴らす定期確認は10件まで。
- **呼び鈴が出来る前から待っていたメールも対象にする。** ADR-029の「登録した時点に待っているメールでは鳴らさない」は登録直後の呼び鈴の話で、間隔がたってもまだ未読なら定期確認で鳴る。ポーリングなら見つけるはずのメールだから。
- **見える化。** `hab:admin status`の`inboxes`に、呼び鈴が生きている受信者だけ`inbox_check_ms`（実際の間隔、0は止めている）を出す。
- **できないこと。** HABの定期確認は「呼び鈴を時間で鳴らし直す」もので、呼び鈴そのものが届かないとき（購読切れ`doorbell_lapsed`、callbackが落ちている）は鳴らせない。そのときの保険は製品自身の定期実行（上の3）だけで、HABは購読やタスクを作り直さない（ADR-024）。ChatGPTが呼び鈴でタスクを起動するか、どれだけ遅れるかはChatGPT側の判断（ADR-022）で、タスクが動かないなら何回鳴らしても読まれない。Museや claude.ai のように外から起動できない製品では、HABは間隔を強制できず、利用者が製品側で設定した間隔と利用量の上限に従う。受信だけでは返信しない（ADR-021の受入条件）、受信側の判断と承認（ADR-015）は変わらない。

## ADR-032 / 採用（台帳の部分）：製品の受け方と、アドレスが表すセッションを台帳に持つ

2026-11-20 JST、owner判断（「アドレスって、セッションごとに持てる」「データベースで管理したら？」「おすすめで大丈夫」）。同日の実機確認で、製品ごとに受け方が違うこと（Hermes は notifier、Dots と Grok は呼び鈴、Muse は予定タスク、claude.ai は話しかけたときだけ）と、ChatGPT のイベントが見張りを頼んだ 1 つの会話でしか動かないことが分かった。受信・表示・実行の全体はこの ADR に順に書き足す（[計画](plans/receive-show-act-plan.md)）。ここでは台帳の部分だけを決める。

- **1 セッションに 1 アドレス。** 管理の単位は製品側のセッション（タスク、会話）で、アドレスとセッションは 1 対 1。HAB は会話を管理しない。同じ製品の中で 2 つのアドレスが同じセッション名を持つことはない（`registry_session_taken`）。名前の付いたセッションは黙って置き換えず、`replace` を明示したときだけ替える（`registry_session_bound`）。一意にするのは運用者が名付けたセッションだけで、仮のセッション名は登録や命名を妨げない。
- **台帳に持つ。** `registry.sqlite` に `hab_product_receive`（製品ごとの受け方 `hook` / `poll` / `on_request` と、`poll` のときだけの間隔 60 秒〜24 時間）と `hab_agent_sessions`（アドレスごとのセッション名、仮かどうか、結び付けた時刻と運用者）を足す。行は消さない。セッション名は製品に渡すだけで、HAB は中身を解釈しない。
- **既存のアドレスは仮のセッション。** 移行は host の起動時だけに行い（`hab:admin` は `registry_upgrade_pending` で待つ）、既存のアドレスを、アドレスと同じ名前の仮のセッションとして入れる。新しく登録したアドレスも、名前が付くまでは仮。配送と呼び鈴の動きはこの判断では変えない。
- **Hook で起こせる notifier は Hook にする。** 運用者が登録した呼び鈴（ADR-029）に限り、宛先に同じ Mac の `http://127.0.0.1:<port>`（ポート指定あり）を許す。notifier はその受け口で Standard Webhooks の署名を確かめ、すぐに受信箱を確かめる。notifier の定期確認は取りこぼしの保険として残す。エージェントの購読の宛先は今までどおり公開 HTTPS だけで、ADR-022 の防御は変えない。
- **HAB からは時間で鳴らさない。** ADR-031 の定期確認をやめる。呼び鈴は新着で 1 回と、読まれなければ鳴らし直し 1 回（ADR-027）だけ。古い設定の `inbox_check` は無視して起動し、`ready` の行で 1 回だけ知らせる。受け方が `poll` の製品は、`hab_inbox` を最後に呼んだ時刻（`events.sqlite` に記録）が間隔の 2 倍を超えたら `hab:admin status` に `poll_overdue` を出す。
- **相手のセッションが終わったら送らない。** 製品は、呼び鈴の `to` に当たるセッションがないとき `410` と `{"reason":"session_gone"}` で答える。HAB はこの答えだけを数え、続けて 3 回でそのアドレスを「相手がいない」にし、`hab_send` を `recipient_absent` で断る。応答なし・5xx・ほかの拒否は数えない。2xx の受け取りか新しい購読で戻す。台帳の行と未読は消さない（未読の扱いと不達の知らせは後の判断）。
- **Hermes の notifier は会話の有無を `state.db` で確かめて答える。** 2026-11-21 JST、owner依頼（「終わったセッションを製品から HAB に知らせる」）。notifier の設定 `screen.session_probe` に `hermes_bridge.desktop_session` を書くと、呼び鈴を受けたときと確認の前に、結び付けた会話を Hermes の `SessionDB` で読み取り専用に確かめる。会話がない・アーカイブ済みのときだけ `410 session_gone` で答え、その間は表示も自動の受け付けもしない（未読を既読にしない）。読めない・遅いときは `200` のまま。Grok の routine と ChatGPT のイベントには答えを返す手段がないので、まだ対象にしない。
- **戻すのは本人の受信箱確認。** 2026-11-21 JST、owner判断（「本人の受信箱確認で外す」）。「相手がいない」の間は送信を断るので呼び鈴が鳴らず、2xx で戻る機会がない。そこで、そのアドレス自身が `hab_inbox`（エージェント用）か `hab_peek`（notifier 用）を呼んだら「相手がいない」を外す。notifier は会話がない間は `hab_peek` を呼ばないので、誤って戻らない。呼び鈴の登録し直しや購読し直しで戻るのは今までどおり。
- **1 回の読み取りを 3 回と数えない。** 製品の 1 回の判定が、溜まった未読の呼び鈴ごとに続けて返ると「続けて 3 回」が意味を失う。HAB は `session_gone` を、前に数えてから `ingress.events.absent_spacing_ms`（既定 60 秒、0〜1 時間）たっていなければ数えない。呼び鈴の配送も `session_gone` の答えを受けたらその回はそこで止め、次の未読は次の回に鳴らす。
- **運用者が登録する。** 受け方とセッションは `hab:admin receive` と `hab:admin session` で、運用者が決める。エージェントが MCP から申請する形は別の判断にする。`hab:admin status` の `products` と各アドレスの `session` に出す。
- **セッション名は呼び鈴で渡す（2026-11-21 追記）。** 呼び鈴の `data` を `{to, session, arrived_at}` にする。`session` は台帳のセッション名で、仮のときはアドレスと同じ。購読は今のところアドレスごとに持つ。受信側は呼び鈴のセッション名で対象の会話を確認できる。製品ごとの購読への集約は別の段で扱う。`hab_inbox` には載せない。読むセッションはもう自分のアドレスの接続で呼んでおり、振り分けは MCP 側で済んでいる。本文・送信元・ID を載せないことは変えない。
- **hook の製品で呼び鈴がなければ知らせる（2026-11-21 追記）。** 受け方が `hook` の製品のアドレスに生きている呼び鈴も切れた記録もない（`doorbell: "none"`）とき、`hab:admin status` の `problems` に `doorbell_missing` を出す。台帳では Hook なのに鳴らす先がない状態で、新着に誰も気づかない。
- **Hermes の実機確認は残っている（2026-11-21 追記）。** 会話の有無に応じて `410 session_gone` を返す仕組みは、`screen.session_probe` を設定した notifier で使える。実機で会話を終了したときの応答と、別の会話を不在扱いにしないことは未確認。

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

