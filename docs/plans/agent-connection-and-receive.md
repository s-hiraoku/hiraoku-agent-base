# HAB の接続診断と製品別の受信

実装計画。基準となる HAB の `main` は `3d0c56d`。導入の完了は、利用者が選んだアプリの会話で最初の1通を確認できた時点とする。受信後の返信は別に記録する。

nenwa は製品の設定、報告されたセッション、製品が使える受信方法を調べる。HAB では、この順番を受信側に取り入れる。宛先と権限は HAB の台帳で管理し、保存済みのメッセージは同じ HAB の受信箱から読める。 [nenwa の診断](https://github.com/nogu66/nenwa/blob/b9b87731da65b3f62876c0797e88d53a342eddb3/src/install.rs#L40-L105) · [nenwa の製品別受信](https://github.com/nogu66/nenwa/blob/b9b87731da65b3f62876c0797e88d53a342eddb3/DESIGN.md#getting-messages-into-agents) · [ADR-032](../hab-decisions.md#adr-032--採用台帳の部分製品の受け方とアドレスが表すセッションを台帳に持つ)

[受信・表示・実行を全エージェントで確立する計画](receive-show-act-plan.md)（以下「8 PR 計画」）との関係は次のとおり。

- 8 PR 計画の PR-1〜5 は `3d0c56d` までに main に入った。受信方式の登録には PR-3 の `hab:admin receive`、アドレスと会話の紐づけには `hab:admin session`、Hermes の Hook には PR-4 の `wake` と運用者の呼び鈴を使う。
- 宛先の退役（PR-7）と ADR-032 の本文（PR-8）は 8 PR 計画が担当する。この計画はその 2 つを待たずに始めてよい。会話が見つからないときの扱いは PR-7 の `session_gone` に合わせる。
- 購読を製品ごとに 1 つにする件（PR-6）は、本人の判断で後回しにした（2026-11-21）。この計画は今のアドレスごとの購読を前提にする。
- PR-2 の設定手順書（[agent-setup.md](../connections/agent-setup.md)）は置き換えない。この計画のセットアップは、手順書の Hermes の節を 1 つのコマンドで行えるようにするもので、完成したら手順書からそのコマンドを案内する。

この設計の診断結果は読み取り専用の観測として扱う。

## 1. 受信側の証拠を診断に表示する

運用者が `doctor` で1つの宛先を指定する。CLI は `scripts/hab-admin.ts`、台帳と受信状態の読み取りは `src/host/admin.ts` に置く。 `hostAdminStatus` の状態の算出方法を再利用する。診断では既存 DB を読み取り専用で開き、移行が必要な場合は既存の `registry_upgrade_pending` を返す。現在の `hostAdminStatus` の DB を開く処理は移行も呼ぶため、診断には移行を呼ばない経路を使う。

```sh
npm run hab:admin -- --config <host-config> doctor --address <address>
```

任意の `--whoami-file <path>` には、運用者が対象アプリで実行した `hab_discover` の `{"action":"whoami"}` が返した構造化結果を渡す。ファイルは JSON 1件、最大64 KiBとする。共有グループで名義が未選択なら、対象アドレスを明示して照会し直す。診断はファイルに記録された名義との一致を報告する。現在の接続や会話の稼働は、対象アプリで再度観測する。 [HAB の自己識別](../connections/mcp-agent-discovery.md#自分を確認する)

| 表示項目 | 判定に使う情報 |
| --- | --- |
| アドレスと接続の紐づけ | 台帳の不変 ID、登録状態、紐づけと必要な権限。 |
| 採取した応答の名義 | `whoami.selected_identity` と台帳の不変 ID を照合する。一致は `ok`、不一致は `problem`、結果がない場合と名義未選択は `unknown`。 |
| 対象の会話 | 台帳上の会話名と採取した `host_identity` を別々に表示する。実会話は期限内のホスト側の証明があり、製品内で同じ会話だと照合できたときだけ確認済みとする。紐づけのない `owner_reference` は製品のセッション ID と照合できないので `unknown`。 |
| 受信方法と動作 | 台帳の `hook`、`poll`、`on_request` と、`status` が観測した呼び鈴の結果や最終既読、`poll_overdue`。`hook` の宛先は、呼び鈴（購読か運用者の登録）があること、最後に鳴らした結果、その後に読まれたかを分けて出す。運用者の呼び鈴が `127.0.0.1` を指す場合は、その製品の notifier の `wake` の待ち受けと鍵が設定されているかを `next_action` で確認させる（診断はホストの外のファイルを読まない）。 |

応答は `address` と `checks` を持つ JSON とする。 `checks` は `registration`、`reported_identity`、`session`、`receive` の4項目。各項目は `state`、固定の `reason`、確認に使った公開可能な値 `evidence`、次の操作 `next_action` を持つ。 `state` は `ok`、`problem`、`unknown` のいずれか。コマンド自体が成立したら、各項目の結果を出して終了コード0を返す。アドレスの欠落、DB を読めない場合、不正な JSON は管理 CLI のエラー処理に従う。入力ファイル全体の出力は避け、診断には認証情報やメッセージ本文を含まない項目だけを写す。

たとえば呼び鈴が HTTP 2xx で受理され、最終既読が更新されていなければ、受理時刻と最終既読を別々に出す。次の操作として対象製品の実行履歴を確認するよう表示する。会話が観測できない状態は `unknown` とし、宛先の受付可否は台帳の登録状態に従う。

### 診断の受入条件

- [ ] `test/host-admin.test.js` で、対象アドレスの欠落、認証情報の期限切れ、名義不一致、会話の未観測、通知の受理と未読の併存を検証する。
- [ ] `doctor` の実行前後で、宛先の登録状態、接続、既読、通知回数が一致する。
- [ ] Hermes Desktop の対象会話から取得した `whoami` を照合し、後述の試験送信で実際の会話への到達を別に記録する。CLI の診断だけで実機の到達を合格にしない。

## 2. Hermes Desktop の設定を1つの手順で進める

最初の製品は、カード表示、会話への引き渡し、返信の実績がある Hermes Desktop とする。Mac mini の Hermes は 2026-11-15 からプラグイン方式（[hab-desktop-adapter](../../experiments/hermes-desktop-adapter/README.md)）で動き、2026-11-21 から HAB の呼び鈴（Hook）で起きる。セットアップはこの構成を対象にする。古い reader 方式（プロファイル設定の `external_messages.readers`）は対象にしない。 [製品別の実機結果](../connections/agent-setup.md#製品ごとにできること)

設定対象は 1 つのローカルプロファイルと、そのプロファイル内で利用者が選んだ保存済みの会話。プロファイルと `stored_session_id` は利用者が指定する。書き換えるファイルは次の 3 つ。

| ファイル | 中身 |
| --- | --- |
| notifier の `notify.json` | HAB の URL、認可済みの agent ID、notifier 専用の OAuth 設定、`screen`（`hermes-desktop`、会話 ID、`backend_namespace`、`profile_scope`、引き渡しコマンド）、`wake`（ポートと鍵ファイル）、保険の `interval_ms`（おすすめ 5 分）。 |
| プラグインの `config.json` | プロファイルの `plugins/hab-desktop-adapter/config.json`。`binding_id` と `destination_binding`（HAB の `binding` が返した値）、`stored_session_id`、`connection_id`、`profile`、`backend_namespace`、`profile_scope`、`receiver_id`、notifier を呼ぶ `command` と `cwd`。所有者だけが読める通常のファイル（0600）で、認証情報は入れない。 |
| HAB host の設定 | `ingress.events.doorbells` に、このアドレスの呼び鈴 `http://127.0.0.1:<port>/wake` と、`wake` と同じ鍵ファイルを 1 件足す。反映には host の再起動が要る。 |

鍵ファイル（`whsec_` で始まる 1 行、0600）は `plan` では作らず、`apply` が新しく作る。既にあれば上書きしない。

新しい `hab:setup` CLI で次の操作を提供する。ファイルとディレクトリの指定には絶対パスを使う。

```sh
npm run hab:setup -- plan --product hermes-desktop --profile <dir> --notify-template <json> --notify-config <new-json> --host-config <json> --session-id <stored-session-id> --wake-port <port> --plan <dir>
npm run hab:setup -- apply --plan <dir>
npm run hab:setup -- undo --plan <dir>
```

テンプレートは、利用者が準備した `screen.type=hermes-desktop` の notifier 設定を使う。既存セッションの移行は既存のオフライン移行手順が担当する。 [notifier の設定](../receiver/arrival-notifier.md) · [Hermes Desktop の設定](../receiver/arrival-notifier.md#hermes-desktop)

1. `plan` は 3 つのファイルの新しい中身と差分を提示する。プラグインの `backend_namespace` と `profile_scope` は `screen` と一致させる。`command` は実行中の Node とリポジトリの `scripts/hab-notify.ts` の絶対パスを使い、作成先の `notify.json` を指定する。次の場合は競合として止める：プロファイルの `external_messages.readers` に同じ組の HAB reader が残っている（カードが二重に出る）、`config.json` に別の会話が書かれている、host の設定に同じアドレスの別の呼び鈴がある、`wake` のポートが使われている。プラグインの導入、Desktop の「Capabilities → Plugins」での有効化、Hermes 側の SDK パッチは利用者の操作として扱い、`plan` は導入済みかどうかを表示するだけにする。標準出力では秘密を伏せる。
2. `apply` は計画を確認した利用者が実行する。計画には対象パス、テンプレートと 3 ファイルの適用前のハッシュ、新しい設定が未作成であること、適用後のハッシュを記録する。先に既存ファイルを退避し、その記録を保存する。次に鍵ファイル、所有者専用の `notify.json`、`config.json`、host の設定の順に、同じディレクトリの一時ファイルから置換する。各書き換えの直前に元の状態を照合し、`apply` と `undo` は直列にする。計画と退避分は所有者専用のディレクトリに置く。host と notifier の再起動は `apply` の最後に手順として表示し、`apply` 自身は行わない。
3. 再実行時は前後のハッシュとファイルの有無を照合する。すべてが適用後なら完了を返す。一部だけが適用後なら、そのファイルを適用前へ戻してから再開できる。期待した前後のどちらにも一致しない場合は対象パスと退避先を表示して止める。 `undo` では host の呼び鈴とプラグインの `config.json` を先に戻し、この操作で作った `notify.json` と鍵ファイルを最後に削除する。既存ファイルの権限は退避時の値に戻す。受信記録の DB と画面ファイルは利用者のデータとして扱う。
4. 利用者は既存の手順で OAuth ログインと運用者登録を済ませ、host と notifier を再起動する。診断で名義と呼び鈴を確認し、対象会話に試験の1通を送り、カードの表示と「対応する」を確認する。 [HAB の接続手順](../connections/agent-setup.md#共通の準備をする)

実装は `scripts/hab-setup.ts` と `scripts/lib/` の製品別処理に置く。 `scripts/hab-notify.ts` の設定の検証と `binding` の意味、host の設定の検証（呼び鈴の `127.0.0.1` の規則）を再利用する。未知の構造や対応外の型は `plan` で止める。既存の設定（別の呼び鈴、別製品のプラグイン、コメント、秘密を含む項目）はファイルを読み直して保持を確かめる。

### セットアップの受入条件

- [ ] 一時プロファイルと一時 host 設定で計画だけを作ると元ファイルが一致する。適用後はプラグインの `config.json` と HAB の呼び鈴が 1 件ずつだけ存在し、再適用は差分ゼロになる。別の呼び鈴、別製品のプラグイン、コメントが残る。
- [ ] 同じ組の reader が残っているプロファイルでは `plan` が競合で止まる。
- [ ] 不正な設定、計画後の編集、退避の失敗、途中のファイルの置換前のプロセス停止を再現する。次回実行で変更済みファイルと退避分を照合し、競合がなければ途中状態から復元できる。
- [ ] 適用後の host と notifier を合成環境で起動し、呼び鈴で notifier が 2 秒以内に受信箱を確かめる（PR-4 のテストと同じ形）。
- [ ] 対応する Hermes Desktop で、対象会話だけにカードが表示される。「対応する」で引き渡され、試験メッセージへの返信が1通返る。

## 3. 製品が示した会話に渡す

製品が証明できるセッション ID を使い、台帳上の宛先と、入力を受ける会話の一致を引き渡し時に確認する。本文は既存の `handoff_prompt` と利用者の選択、または許可済みの自動受付ルールに従って渡す。通知を発行したこと、製品が表示したこと、入力を受け付けたこと、処理を始めたことを別の結果として扱う。 [受信アダプターの契約](../receiver/arrival-notifier.md#hab-が持つ部分と各エージェントが用意する部分)

| 製品 | 実装に進むための条件 |
| --- | --- |
| Codex（ChatGPT アプリ） | 最初に調べる新しい引き渡し先。nenwa の `codex queue --thread` と HAB の既存 app-server 経路を、利用者が実際に使う同じ Codex ホストと会話で比較する。GUI の会話で受信を観測できた経路を採用候補にする。 |
| Claude Code | 公開フックや既存の status line が渡すセッション ID を診断に使う。 `/clear` か会話を開き直した後は ID を取り直す。その ID と同じ会話へ製品が入力を受け付けることを自動引き渡しの条件にする。 |
| Hermes Desktop、Dots、Grok Bot、Muse | 既存のカード、MCP Events、Webhook、予定タスクを使う。Dots では通知の受理、既読、カード表示を個別に観測する。Grok Bot のルーチン実行は製品の履歴で確認し、HAB 側では通知の受理と既読を診断する。Muse は予定実行後の最終既読を確認する。 |
| Cursor、OpenCode、Pi | 接続する製品が決まったときの候補。Cursor は次のフックで渡す方式、OpenCode と Pi は待機中にも受け取る方式を実際の利用環境で確かめる。 |

Codex で確認できた経路は `src/agent-notify/codex.ts` と `AgentScreen` の既存契約に実装する。キューへの受付を確認できた時点は `queued`、ターン開始の応答を確認できた時点は `started`。入力を送った後に応答が途切れたときは `unknown` で終え、利用者が元の会話で投入済みか確認する。会話に使える入口がなければ `unsupported` とする。通知の「対応する」は引き渡しの前に既読にするため、元の1通を読み直すときは `hab_inbox` に `include_read: true` と元の `message_id` を渡す。 [HAB の Codex 連携](../receiver/arrival-notifier.md#codex) · [既読メッセージの再取得](../common-mcp-connection.md)

### Codex の受入条件

- [ ] 実際のデスクトップアプリで2つの会話を開き、指定したスレッドにだけ1通が届く。待機中と作業中を別に記録する。
- [ ] 対象の会話を閉じた場合は、有効なアドレスで受付済みの1通を受信箱から読める。開始の確認がない受付は `queued` と記録する。
- [ ] 応答消失を合成テストで再現する。結果は `unknown` になり、送信回数は1回のままになる。対象会話を変更した場合も新しい会話に転送されない。
- [ ] どちらの経路も GUI の対象会話への受信を確かめられなければ、利用した製品、バージョン、失敗した段階を残し、手動受信として扱う。

## 実装順と試験の記録

1. **診断。** 既存の管理 CLI で宛先1件を診断し、確認済みの項目と未観測の項目が判別できたら、セットアップへ進む。
2. **Hermes Desktop のセットアップ。** 一時プロファイルと一時 host 設定で `plan`、`apply`、`undo` を通し、次に対応する実機プロファイルで最初の1通を確認する。Mac mini の今の Hermes は手で設定済みなので、実機では `plan` が差分ゼロになることを先に確かめる。
3. **セッションへの引き渡し。** Codex の実機調査は診断と並行できる。GUI で受信を確認した経路に限って実装し、引き渡しの合成テストと実機試験を通す。Claude Code 以降も、製品ごとに確認できた入口を追加する。

試験送信は利用者が宛先を確認して、認可済みの送信元から `hab_send` で1通だけ行う。記録には製品名とバージョン、HAB のコミット、送信者とメッセージの ID、宛先、対象セッション、表示と引き渡しの観測、返信の有無を残す。共有資料には試験用の ID と観測結果を載せる。対象製品の GUI か実セッションで観測する項目は、合成テストとは別に結果を残す。
