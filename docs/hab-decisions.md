# HABの設計判断記録（ADR）

[READMEへ](../README.md) · [設計思想](hab-principles.md) · [ロードマップ](hab-roadmap.md)

状態は「採用」「当面不採用」「保留」「未決定」を使います。採用は設計判断であり、本番接続・費用・公開の承認を兼ねません。判断を変更するときは、この表と関連文書・testを更新します。

| ID / 状態      | 判断と理由                                                                                                               | 代替案・限界                                                                                                                     |
| -------------- | ------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| ADR-001 / 採用 | agentの判断を保持し、共通Hubは依頼・進捗・結果を仲介する                                                                 | 中央の単一super-agentへの統合は当面不採用。個人文脈を全agentへ複製しない                                                         |
| ADR-002 / 採用 | 現本番候補はMac＋SQLite。状態DBは一つ                                                                                    | Worker/D1核とmockを移植性のため維持。Sites/D1本番は保留で、現在のpilotでは使わない                                               |
| ADR-003 / 採用 | HTTP MCPと外向きMac worker、独立Hermes Runs、durable receiptを使う                                                       | A2Aは初期版で当面不採用。Desktop session/API/authの流用もしない                                                                  |
| ADR-004 / 採用 | 原子的claim、lease/fence、要求idempotency、監査/outboxで失敗を扱う                                                       | exactly-once配送を保証しない。有限retryと受信側dedup、未知runの照合が必要                                                        |
| ADR-005 / 採用 | 固定task、最小scope、並列1、実tool/import境界を最初の受入れにする                                                        | 任意shell・自由入力・自由な宛先・個人データ・自律follow-upは当面不採用                                                           |
| ADR-006 / 採用 | Auth0をidentity候補とし、主体/clientを分離。未設定は拒否                                                                 | 本番設定・無料feature・client登録方式は未確認。service credentialをuser consentの代わりにしない                                  |
| ADR-007 / 採用 | 既存Tailscaleの再利用を優先検討し、既存MCPを維持                                                                         | Hubの同host別pathか別8443は未決定。双方に限定code変更とOAuth/client検証が必要。Cloudflare/domainは必須でない                     |
| ADR-008 / 採用 | 結果取得を最初に、通知はopt-in・固定payload・承認済みcallbackに限定                                                      | Eventsコードは実装済み、実receiver/egress/常駐配送は保留。通知は新taskを作らない                                                 |
| ADR-009 / 採用 | source/設計はpublic、実設定・秘密・履歴はprivateで管理                                                                   | public repoは実agent起動やHub追加公開を許可しない。repoは同一履歴を保持してhiraoku-agent-baseへ改名                              |
| ADR-010 / 採用 | 既存jobは元の担当に残す。費用・停止・照合を先に決める                                                                    | cronの重複作成、有料fallback、不明admissionの無制限retryは当面不採用                                                             |
| ADR-011 / 保留 | Claude Code・Codex・CursorとCuaを限定executor候補にする                                                                  | Hub adapter、workspace reservation、権限、費用、result provenanceを検証後に選定                                                  |
| ADR-012 / 保留 | 競合は設計参考として保存し、部品単位で比較する                                                                           | 導入・置換・migrationは未決定。browser本人sessionによるdot代理操作は初期HAB接続に採用しない                                      |
| ADR-013 / 採用 | [HAB Relay draft v2 + store-and-forward](hab-relay-spec.md)を通信設計に採用。Relay／Task Engine／Adapter／認可を分離する | 単一Node＋SQLiteから開始。個体認証・durable outbox/inboxの実能力はG0未確認。仕様採用は実接続・公開・credential発行の承認ではない |

## 次に決める内容

1. Hub外部resource URLとdiscovery route。既存MCPのclient/認証を確認し、既存routeへの干渉がない案を承認する。
2. Auth0 issuer、正確なcallback、主体/clientと最小scope、無料条件、秘密保管とrevocation。
3. 今回のHermes inventoryの実行環境とprivate binding、$0モデル枠、単発停止・回収条件。
4. Dots/Grokの実MCP呼出し・結果取得と、wakeまたはEventsを追加する必要性。

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
