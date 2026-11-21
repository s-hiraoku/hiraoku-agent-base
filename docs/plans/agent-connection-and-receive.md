# エージェントの接続と導入を楽にする

実装計画。基準となる HAB の `main` は `235c30c`。目的は、1 つのエージェントを HAB につなぐ手間と、つながったかどうかを確かめる手間を減らすこと。導入の完了は、利用者が選んだ製品の会話で最初の 1 通を確認できた時点とする。

[設定手順書](../connections/agent-setup.md)で 1 つの製品をつなぐと、手間は次の 4 か所に出る。

| 手間                   | 今のやり方                                                                                                                                                                                               | この計画で        |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------- |
| 接続の登録             | Auth0 の管理画面のログで subject を探し、接続台帳（`ingress.oauth_file`）に手で書き足してから `hab:admin connect` を実行する（[共通の準備](../connections/agent-setup.md#共通の準備をする)の 4〜5 番）。 | G. 保留中の接続   |
| 起こし方の設定         | 運用者の呼び鈴（ADR-029）は host の設定ファイルにあり、足すたびに host を再起動する。                                                                                                                    | C. 呼び鈴を台帳に |
| どこで止まったかの確認 | 監査記録、`events.sqlite`、`delivery.sqlite`、`hab:admin status` を手で突き合わせる。                                                                                                                    | A. doctor         |
| 完了の判定             | 運用者が手で 1 通送り、呼び鈴、既読、返信を順に確かめる。                                                                                                                                                | B. ping           |

製品の画面での MCP の追加と OAuth のログインは製品側の操作なので、HAB からは自動化しない。HAB はその後の手順を減らし、次の操作を示す。

[受信・表示・実行を全エージェントで確立する計画](receive-show-act-plan.md)（以下「8 PR 計画」）との関係は次のとおり。

- 8 PR 計画の PR-1〜5 と PR-7 は `235c30c` までに main に入った。受け方の登録（`hab:admin receive`）、アドレスと会話の紐づけ（`hab:admin session`）、Hermes の Hook（`wake`）、`poll_overdue`、`recipient_absent` はこの計画の前提になる。
- 購読を製品ごとに 1 つにする件（PR-6）は後回しのままとする。C はそのうち「運用者の呼び鈴を台帳に置く」部分だけを先に行う。
- ADR-032 の本文（PR-8）は 8 PR 計画が担当する。

各段は独立した PR とし、A、G、C、B の順に入れる。A は読み取りだけで、ほかの段の確認にも使う。

## A. doctor：宛先ごとに、どこまで動いているかを出す

```sh
npm run hab:admin -- --config <host-config> doctor [--address <address>]
```

`--address` を付けると、その宛先の 4 項目を出す。付けないと、すべての宛先を 1 行ずつ（宛先、各項目の `state`、最初の `problem` の `reason`）出す。読み取り専用で、状態は何も変えない。

DB は `hostAdminStatus` と同じ経路で開く。移行が必要な DB は、その経路が先に `registry_upgrade_pending` で断る（`src/host/admin.ts` の `withRegistry`）。そのあとの `registry.migrate()` が書き込みをしないことはテストで確かめる。CLI は `scripts/hab-admin.ts`、判定は `src/host/admin.ts` に置き、`hostAdminStatus` の `inboxes` と `problems` の算出を共有する。

| 項目           | 判定に使う情報                                                                                                                                                                                                                                                                                                                          |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `registration` | 台帳の登録状態、グループの紐づけ、5 操作の権限、接続台帳での承認期限。期限の 14 日前から `problem`。                                                                                                                                                                                                                                    |
| `receive`      | 製品の受け方（`hook`、`poll`、`on_request`、未設定）。`hook` は呼び鈴があること（購読か運用者の登録）、`live` か `lapsed` か、最後に鳴らした結果。`poll` は最後に受信箱を読んだ時刻と `poll_overdue`。受信箱を読んだ時刻は `events.sqlite` にしか残らないので、`ingress.events` がない host では `unknown`（`reads_untracked`）とする。 |
| `reading`      | 未読の数と最古の時刻、最後に受信箱を読んだ時刻。最古の未読より後の呼び鈴が受理され、2 分たっても読まれていなければ `problem`（`rang_not_read`）。`hab_inbox` で読む姿が一度も見えていない宛先は対象にしない。notifier は配送用のツールで読むので、利用者の選択を待つカードを取りこぼしと見誤らないため。                                |
| `session`      | 台帳上の会話名と、仮の名前かどうか。`recipient_absent` なら `problem`。製品が会話を報告する仕組みはまだないので、実際の会話との一致は `unknown`。                                                                                                                                                                                       |

各項目は `state`（`ok`、`problem`、`unknown`）、固定の `reason`、公開できる値だけの `evidence`、次の操作 `next_action` を持つ。`next_action` は製品の受け方に合わせて、手順書の該当する節を示す。コマンドが成立したら終了コード 0 を返す。宛先がない、DB を読めないといった場合は管理 CLI のエラー処理に従う。秘密、URL のクエリ、メッセージ本文は出さない。

運用者の呼び鈴が `127.0.0.1` を指す場合、notifier の `wake` の待ち受けまでは確かめない。host の外のファイルは読まず、`next_action` で notifier の設定を確かめるよう示す。

### A の受入条件

- [ ] `test/host-doctor.test.js` で `hostAdminStatus` の結果を合成し、宛先なし、承認期限切れ間近、受け方の未設定、呼び鈴の `lapsed`、呼び鈴の受理と未読の併存、`poll_overdue`、`recipient_absent` の各場合の `state` と `reason` を確かめる。
- [ ] events ありの実 host（`test/host-admin.test.js`）で、`doctor` の前後の `registry.sqlite`、`events.sqlite`、`delivery.sqlite` の全テーブルの内容が一致する。
- [ ] Mac mini の 5 つの宛先で実行し、今わかっている状態（Hermes は Hook で読まれている、Muse は poll、claude は on_request）と一致することを記録する。

## G. 保留中の接続：Auth0 のログを探さずに接続を承認する

今の OAuth の検証（`src/host/oauth-auth.ts`）は、接続台帳に subject と client ID の組がないトークンを、署名を確かめる前に `client_not_registered` か `subject_not_registered` で断る。値は記録しない。そのため運用者は Auth0 のログで subject を探している。

この段では検証器を変え、台帳にない組のトークンも、登録済みと同じ検査（署名、`iss`、`aud`、scope、有効期限）を最後まで行う。すべて通ったときだけ、その組を「保留中の接続」として記録する。断る理由と応答は今と同じで、保留中の接続には何の権限もない。登録済みの組の検査の順番と結果は変えない。

| 保存する値                               | 説明                                        |
| ---------------------------------------- | ------------------------------------------- |
| `subject`、`client_id`                   | 署名を確かめたトークンの値。組ごとに 1 行。 |
| `first_seen_at`、`last_seen_at`、`count` | 製品が試した時刻と回数。                    |

- 保存先は host の状態ディレクトリの新しい `oauth-pending.sqlite`（0600）。行数は 20 件まで。いっぱいなら最も古い `last_seen_at` の行を置き換える。最後に見てから 7 日たった行は消す。
- 運用者は `hab:admin status` の `pending_connections` で一覧を見る。subject と client ID はそのまま出す。運用者が Auth0 で見ていた値と同じで、トークンではない。
- 承認は `hab:admin connect --address <address> --pending <subject>:<client_id>` とする。admin は接続台帳に `connection_id` を作り、`approved_at` を今、`approved_until` を 1 年後、`state` を `active` として足す。そのあと今の `connect` と同じ手順で登録と紐づけを行う。台帳は同じディレクトリの一時ファイルから置き換え、元の権限を保つ。host は検証のたびに台帳を読み直すので（`#current()`）、再起動は要らない。
- 承認より前に発行されたトークンは、今の検証どおり `token_before_approval` で断る。製品は次のトークンの更新（HAB の上限は 10 分）で承認後のトークンを得る。急ぐときは、製品の画面でコネクタをつなぎ直す。`connect --pending` の出力と手順書にこのことを書く。
- 承認した組は保留の一覧から消す。同じ組がすでに台帳にあれば、台帳は書き換えずに `connect` へ進む。
- 台帳の版が 1（`connections` に有効期限の短い資格情報を並べる版）のときは、承認を断って手での登録を案内する。

### G の受入条件

- [ ] 署名が正しくないトークン、`iss`、`aud`、scope のどれかが違うトークン、期限切れのトークンは保留に残らない。
- [ ] 保留に残ったトークンへの応答は、今と同じ応答と同じ理由になる。
- [ ] 21 件目で最も古い行が置き換わり、7 日で消える。
- [ ] `connect --pending` のあと、host を再起動せずに、承認のあとに発行されたトークンで `hab_discover` が通る。承認より前に発行されたトークンは今と同じ `token_before_approval` で断る（承認の境界は弱めない）。再実行しても台帳の行は増えない。
- [ ] 手順書の「共通の準備」の 4〜5 番を、製品をつないで `connect --pending` で承認する手順に置き換える。

## C. 呼び鈴を台帳に移す

運用者の呼び鈴（ADR-029）を host の設定ファイルから `events.sqlite` に移す。

```sh
npm run hab:admin -- --config <host-config> doorbell add --address <address> --url <url> --secret-file <path>
npm run hab:admin -- --config <host-config> doorbell remove --address <address> --url <url>
```

- `add` は URL を今と同じ規則（公開 HTTPS か、この Mac の `127.0.0.1`。`operatorCallbackUrl`）で確かめる。鍵ファイルは `whsec_` で始まり、所有者だけが読めることを確かめる。鍵そのものは保存せず、ファイルのパスを保存する。
- host は台帳の呼び鈴を定期的に（30 秒ごと）読み直し、`configureStatic` に渡す。`configureStatic` は今でも冪等に差し替えるので、新しい呼び鈴だけが今ある未読のあとから始まり、変わらない呼び鈴は位置を保つ。
- 設定ファイルの `ingress.events.doorbells` は、次の host の起動で台帳に移す。移したあとも設定ファイルに残っていれば、`ignored_config` に出して読まない。
- `doorbell add` と `remove` は記録を残し、同じ要求の再実行は同じ結果を返す。

### C の受入条件

- [ ] `doorbell add` のあと、host を再起動せずに 30 秒以内に呼び鈴が鳴る。`remove` のあとは鳴らない。
- [ ] 設定ファイルの呼び鈴は 1 回だけ台帳に移り、再起動しても重複しない。
- [ ] 不正な URL、`whsec_` でない鍵、他人が読める鍵ファイルを断る。
- [ ] Mac mini の Hermes と Grok の呼び鈴を移し、Hermes の往復が今と同じ時間で返る。

## B. ping：試験の 1 通で導入の完了を判定する

```sh
npm run hab:admin -- --config <host-config> ping --address <address> [--wait-secs <n>]
```

- host は試験専用の名義 `ping@hab.hab` を持つ。A2A の host の名義（`provisionHostA2aIdentity`）と同じ方法で作り、`hab:admin connect` では使えないようにする。
- `ping` は対象の宛先へ `question` を 1 通送る。本文は試験であることと、「受信OK」と返信してほしいことだけを書く。
- 送った後、`--wait-secs`（既定 120、最大 600）の間、段階ごとの時刻を返す。段階は受付、呼び鈴（鳴らした時刻と結果）、既読、返信。最後に進んだ段階と、止まった段階の `next_action`（doctor と同じ）を出す。
- 返信の本文は表示しない。返信があったことだけを記録する。
- 受け方が `on_request` の宛先は、既読まで進まないのが正しい動きなので、受付まで進めば合格とする。`poll` の宛先は、待つ時間が間隔より短ければ既読を `unknown` とする。

### B の受入条件

- [ ] 合成環境で、Hook の宛先の全段階、呼び鈴の失敗、既読なし、返信なしの各場合を確かめる。
- [ ] `ping@hab.hab` 宛ての返信は試験の受信箱にだけ入り、ほかの宛先に見えない。
- [ ] Mac mini の Hermes で全段階が出て、今の往復時間（約 7〜10 秒）と合う。

## 後回しにする候補

次の項目は、導入の手間を直接減らさないか、使う場面がまだないので、条件がそろったときに別の計画で扱う。

| 候補                                                                                                              | 始める条件                                                                                      |
| ----------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Hermes Desktop の 1 コマンドのセットアップ（notifier、プラグイン、呼び鈴を `plan`、`apply`、`undo` で書き換える） | Hermes を別のプロファイルか別の Mac に入れるとき。C の後なら、host の設定の書き換えは要らない。 |
| 製品が示した会話への引き渡し（Codex など）                                                                        | Codex を HAB の相手にすると決めたとき。今の Codex には外から会話に入れる口がない。              |
| 導入の案内（`onboard`）                                                                                           | G、doctor の `next_action`、手順書で足りないとわかったとき。                                    |
| MCP からの登録申請                                                                                                | 複数の運用者が接続を承認するようになったとき。G の保留中の接続を土台にする。                    |
| notifier が終わった会話宛ての呼び鈴に `410` と `session_gone` を返す                                              | Hermes の会話を切り替える運用が始まったとき。PR-7 の `recipient_absent` が働くようになる。      |

## 実装順と試験の記録

1. **A doctor。** 合成テストのあと、Mac mini の 5 つの宛先で実行して結果を記録する。
2. **G 保留中の接続。** 合成テストのあと、新しい製品か新しい Auth0 アプリで、Auth0 のログを見ずに接続できることを確かめる。
3. **C 呼び鈴を台帳に。** Mac mini の Hermes と Grok の呼び鈴を移し、再起動なしで足せることを確かめる。
4. **B ping。** Mac mini の 5 つの宛先で実行し、doctor の結果と矛盾しないことを確かめる。

各段の PR は、テスト（`npm test`）、型検査、lint、設計契約の audit を通してから出す。Mac mini への展開は本人の指示で行う。HAB の動作が変わる段では、検証スキル `.claude/skills/verify-hab/` の機能マップも更新する。
