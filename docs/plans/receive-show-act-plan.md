# 受信・表示・実行を全エージェントで確立する計画

HAB のメールを、各エージェントが受け取り、利用者に見せ、選んだとおりに動けるようにする。
対象の利用者は HAB でエージェント同士をつなぐ本人で、メールが届いたことに気づき、許可した相手には自動で返事が進む状態を得る。
守る決まりは 3 つある。受け取っただけでは返信しない（ADR-021）。返信を許すのは受け手の設定だけ（ADR-015、ADR-023）。
HAB はセッションを管理せず、1 セッションに 1 アドレスを使う。
管理の単位はセッション（タスク）で、アドレスとセッションは 1 対 1。結び付けは HAB の台帳（Registry）が持つ。
呼び鈴の購読と polling は製品ごとに 1 つで、どのセッション宛てかは通知の `to` で製品側が振り分ける。
受信は Hook が主で、Hook を作れない製品だけ製品側の polling にする。HAB 側の定期確認（ADR-031）はやめる。
PR は順に PR-1（監査のメソッド記録）、PR-2（設定手順書）、PR-3（台帳に製品の受け方とセッション）、PR-4（Hermes の Hook）、
PR-5（HAB 側の定期確認をやめ、polling の遅れを見せる）、PR-6（製品ごとに 1 つの購読）、PR-7（相手がいないときのエラー）、PR-8（設計書の整理）。

## How to read this

One box is one unit of work. Every box names the evidence that checks it. A nested box is a sub-step of the box above it. Check a box only when its evidence exists, a file, a log line, a screenshot, a test run, or a SHA.
（1 つの箱が 1 つの作業単位で、箱ごとに確かめる証拠を書く。証拠があるときだけ印を付ける。）
本文は手順書で、付録に説明と記録を置く。

この計画は `pstack/skills/poteto-mode/playbooks/autopilot-stack.md` で進める。
ただし実行するのは Mac mini の Claude Code 1 体で、クラウドの下請けと swarm は使わない（付録 C の差分）。
PR のマージと Mac mini への展開は本人の操作で、各 PR は merge-ready で止まる。

Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

## Program checklist

### Arm the program

- [ ] この計画を本人に示して止まる。実行は本人の明示の go で始める。
- [ ] 開始時と各段階で、trunk から次を読み直す。
  - [ ] `git show origin/main:docs/hab-decisions.md`
  - [ ] `git show origin/main:docs/connections/mcp-events.md`
  - [ ] `git show origin/main:docs/receiver/arrival-notifier.md`
  - [ ] `git show origin/main:.claude/skills/verify-hab/SKILL.md`
- [ ] 本人の go のあと、進み具合の確認を `/loop 1h` で回す。確認の文は次のとおりにする。
      「計画書を読み直し、進行中の PR の状態を副作用（ブランチ、テスト結果、HAB の記録）で確かめる。前回の報告から変わったことだけを、短い status message で本人に知らせる。」
- [ ] 本人が止めたら、すべての作業を書き込みなしで止める。

### Spawn owners

- [ ] 各 PR はこのセッションが順に持つ。下請けを使う場合は `poteto-agent` に 1 PR ずつ渡す。
- [ ] 次の依存に従う。
  - [ ] PR-1 と PR-2 は独立で、最初に進める。どちらもブランチは作成済み。
  - [ ] PR-3 は PR-1 のあと。PR-4 から PR-7 は PR-3 のあと、この順に 1 つずつ。PR-8 は最後。
  - [ ] PR-3 から PR-7 は `src/hab/sqlite-registry.ts` と `src/hab/events.ts` を共有するので、同時に書かない。
- [ ] ファイルの境界を守る。PR-2 と PR-8 は `docs/**` と `.claude/skills/verify-hab/**` だけを触る。
- [ ] 本人の確認を待つ。PR-3、PR-4、PR-6、PR-7 は利用者から見える動きを変えるので、Mac mini での実機確認の結果を見せてからマージする。

### PR mechanics, for every PR

- [ ] フォージは `gh` を使う。
- [ ] PR は draft にせずに開く。ベースは `main`。
- [ ] push の前に `npm run lint` と `npm run typecheck` を 1 回ずつ通す。
- [ ] commit の前に差分を読み直し、不要なコメントを消す。
- [ ] レビューのコメントは 1 件ずつ、直すか理由を書いて閉じる。
- [ ] merge-ready の報告の前に、`main` に rebase する。

### Verdict and merge, for every PR

- [ ] merge-ready の時点で、`npm test` 全体、verify-hab の実地確認、Mac mini の実機確認（PR ごとの Verify, live）をそろえる。
- [ ] どれか 1 つでも失敗したら直してから報告し直す。新しい head では確認をやり直す。
- [ ] マージは本人が行う。展開は本人の直接の一言のあとに行い、毎回バックアップと ROLLBACK.md を残す。

### Boot recipe, for every live lane

各実地確認は、Mac mini 上で PR の head から行う。

- [ ] `git fetch origin <head-branch> && git checkout <head SHA>`。
- [ ] verify-hab の `launch.sh` で検証用スタックを起動し、`DOCTOR_OK` を待つ。Node は 26.13.1 を使う。
- [ ] 入力は `mcp.sh` と HTTP の要求だけで行い、DB は `inspect.mjs` と `sqlite3` の読み取り専用で見る。
- [ ] 証拠は `$RUN/evidence/` と、実機確認の HAB 監査記録（`audit.jsonl`）の行で残す。

## 監査記録にメソッドの固定コードを残す（PR-1）

**Depends on.** None.

**Files.**

- [x] Edit `src/protocol.ts`、`src/host/mcp/http.ts`、`src/local-audit.ts`、`src/security.ts`。
- [x] Create `test/protocol-method-code.test.js`。

**Build.**

- [x] `mcpMethodCode` が、認証済みの要求ごとに `method` の行を固定コードで書く。ブランチ `claude/audit-mcp-method`、commit `acacaff`。

**You see.**

- [x] `audit.jsonl` に `{"category":"method","method":"resources_read_ui"}` のような行が出る。

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [x] `test/protocol-method-code.test.js`、`test/local-audit.test.js`、`test/host-service.test.js` の新しい 6 件。Run `node --test` で 27 件が通った。

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Mac mini の実機と verify-hab の検証用スタックで確かめる。

- [x] Lane 1. Regression lane against trunk. trunk には `method` の行がない。head では `tools/list` が `tools_list` になる。
- [x] Lane 2. 許可していないメソッド `prompts/list` が 405 になり、`prompts_list` のあとに `resource_rejected` が続く。
- [x] Lane 3. 表にないメソッドは `other` になり、その文字列は記録に出ない。
- [x] Lane 4. Mac mini（2026-11-20 10:01 UTC から稼働）で、claude.ai の `resources_read_ui` が記録された。

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. 要求 1 件あたりの処理時間。
- [ ] Probe. verify-hab の `tools/list` を 100 回、trunk と head で交互に送る。
- [ ] Baseline. trunk の中央値を先に記録する。
- [ ] Rule. head の中央値が trunk より 2 ミリ秒以上遅ければ失敗とする。

**Review gate.** None. PR-1 is not review-gated.

**Merge.**

- [ ] `main` に rebase し、本人がマージする。

## 全エージェントの設定手順書を置く（PR-2）

**Depends on.** None.

**Files.**

- [x] Create `docs/connections/agent-setup.md`。
- [x] Edit `docs/README.md`。

**Build.**

- [x] 製品ごとの手順と「AI に渡す文」と、確認結果の表を書く。PR #244（ブランチ `claude/project-thread-1p20u7`）に一本化済み。

**You see.**

- [x] 手順書の表が、付録 A の確認結果と一致する。

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] 文書の中のリンク先がすべて存在する。Run `npx prettier --check docs/connections/agent-setup.md`。

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [x] Lane 1. Dots の文を stallone の会話で使い、試験 C が 12 秒で既読、29 秒で返信になった。
- [x] Lane 2. Grok の文で作った routine が、呼び鈴から 24 秒で返信した。
- [x] Lane 3. Muse の文で作った予定タスクが、受信箱を読んで返信した。

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. なし。文書だけの PR なので、性能の比較は行わない。
- [ ] Probe. なし。
- [ ] Baseline. なし。
- [ ] Rule. なし。

**Review gate.** None. PR-2 is not review-gated.

**Merge.**

- [ ] 本人がマージする。

## 台帳に製品の受け方とセッションを持たせる（PR-3）

**Depends on.** PR-1.

**Files.**

- [ ] Edit `src/hab/sqlite-registry.ts`（`hab_products` と `hab_agents` に列を足す、移行を書く）。
- [ ] Edit `src/host/admin.ts`（設定と表示の操作）。
- [ ] Edit `docs/hab-decisions.md`（ADR-032 の台帳の部分を先に書く）。
- [ ] Create `test/hab-registry-receive.test.js`。

**Build.**

- [ ] `hab_products` に受け方（`hook` / `poll` / `on_request`）と、`poll` のときの間隔を足す。
- [ ] `hab_agents` に、製品側のセッション名、結び付けた人と時刻を足す。HAB はこの名前を製品に渡すだけで、中身は解釈しない。
- [ ] `hab:admin` に、製品の受け方とアドレスのセッションを設定・表示する操作を足す。
- [ ] 移行で、既存の 5 アドレスを仮のセッションとして登録する。今の配送と呼び鈴の動きは変えない。

**You see.**

- [ ] `hab:admin status` に、製品ごとの受け方と、アドレスごとのセッションが出る。

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] 移行、受け方の設定、セッションの設定と表示、未設定のときの既定の件を足す。Run `node --test test/hab-registry-receive.test.js`。

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Lane 1. Regression lane against trunk. trunk の DB を head で開くと移行され、配送と呼び鈴が trunk と同じに動く。
- [ ] Lane 2. verify-hab で 5 アドレス相当を作り、`hab:admin status` で製品とセッションを見る。
- [ ] Lane 3. Mac mini の DB のコピー（読み取り専用の複製）で移行を試し、5 アドレスが仮セッションになる。

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. `hab_send` の処理時間。
- [ ] Probe. 検証用スタックで `hab_send` を 100 回、trunk と head で交互に送る。
- [ ] Baseline. trunk の中央値を先に記録する。
- [ ] Rule. head が trunk より 10% 以上遅ければ失敗とする。

**Review gate.** The operator reviews before merge.

- [ ] 移行後の `hab:admin status` の出力を本人に見せる。
- [ ] Post the screenshot of the result and a short video (or the HAB log lines when there is no screen) in chat. The operator reviews and clicks merge.

**Merge.**

- [ ] 本人がマージし、展開は本人の一言のあとに行う。

## Hermes を Hook で起こす（PR-4）

**Depends on.** PR-3.

**Files.**

- [ ] Edit `src/hab/events.ts`（運用者登録の呼び鈴の送り方）。
- [ ] Edit `src/host/config.ts`（`doorbells[].url` に loopback を許す条件）。
- [ ] Edit `src/agent-notify/`（notifier に loopback の受け口を足す）。
- [ ] Edit `docs/connections/mcp-events.md`、`docs/receiver/arrival-notifier.md`、`docs/hab-decisions.md`（ADR-029 の追記）。

**Build.**

- [ ] 運用者が設定ファイルで登録した呼び鈴に限り、`http://127.0.0.1:<port>/` への送信を許す。エージェントが購読する宛先は公開 HTTPS のままにする。
- [ ] notifier に、Standard Webhooks の署名を確かめる受け口を足す。呼び鈴を受けたら、すぐに 1 回確認する。
- [ ] notifier の定期確認は残し、取りこぼしの保険にする。間隔は台帳の Hermes の行で決め、notifier は起動時にそれを読む。

**You see.**

- [ ] 試験メールを送ると、notifier の `run.log` に `shown` が 2 秒以内に出る。

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] `test/hab-events.test.js` に、loopback の運用者呼び鈴が届く件と、購読の loopback が拒否される件を足す。Run `node --test test/hab-events.test.js`。
- [ ] `test/agent-notify.test.js` に、署名が正しい呼び鈴で確認が 1 回走る件と、署名違いを拒否する件を足す。

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Lane 1. Regression lane against trunk. trunk では、Hermes の表示まで最大で notifier の間隔（15 秒）かかる。head では 2 秒以内。
- [ ] Lane 2. notifier を止めた状態で鳴らすと、HAB の記録が失敗を数え、再送する。
- [ ] Lane 3. 署名の違う要求を loopback の受け口に送ると、確認が走らない。
- [ ] Lane 4. Mac mini の実機で、Hermes Desktop にカードが出て、自動受付の相手には返信が届く。

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. 受付から notifier の `shown` までの時間。
- [ ] Probe. 試験メールを 10 通、trunk と head で交互に送る。
- [ ] Baseline. trunk の中央値（2026-11-20 の実測で約 3 秒）を先に記録する。
- [ ] Rule. head の中央値が 2 秒を超えたら失敗とする。

**Review gate.** The operator reviews before merge.

- [ ] Mac mini の実機確認の時刻と、Hermes のカードのスクリーンショットを示す。
- [ ] Post the screenshot of the result and a short video (or the HAB log lines when there is no screen) in chat. The operator reviews and clicks merge.

**Merge.**

- [ ] 本人がマージし、展開は本人の一言のあとに行う。

## HAB 側の定期確認をやめ、polling の遅れを見せる（PR-5）

**Depends on.** PR-4.

**Files.**

- [ ] Edit `src/hab/events.ts`（`inbox_check` を消す）。
- [ ] Edit `src/host/config.ts`（`inbox_check` の設定を読まなくする）。
- [ ] Edit `src/host/admin.ts`（`poll_overdue`）。
- [ ] Edit `docs/hab-decisions.md`（ADR-031 を置き換え済みにする）。

**Build.**

- [ ] ADR-031 の受信箱の定期確認（HAB から鳴らす 10 分ごとの呼び鈴）を消す。鳴らし直し（ADR-027）は残す。
- [ ] 古い設定に `inbox_check` があっても host は起動し、使わない旨を 1 回だけ記録する。
- [ ] 受け方が `poll` の製品は、最後に受信箱を読んだ時刻が台帳の間隔の 2 倍を超えたら、`hab:admin status` の `problems` に `poll_overdue` を出す。

**You see.**

- [ ] Muse の予定タスクが止まると、`poll_overdue` が出る。

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] `inbox_check` が鳴らないこと、古い設定で起動すること、`poll_overdue` の境目の件を足す。Run `node --test test/hab-events.test.js`。

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Lane 1. Regression lane against trunk. trunk は 10 分ごとに `hab_event_checks` が増える。head では増えない。
- [ ] Lane 2. 間隔 1 分の `poll` 製品を作り、受信箱を読まないと 2 分後に `poll_overdue` が出る。

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. 配送 1 回あたりの処理時間。
- [ ] Probe. 検証用スタックで新着 100 通を、trunk と head で交互に流す。
- [ ] Baseline. trunk の中央値を先に記録する。
- [ ] Rule. head が trunk より 10% 以上遅ければ失敗とする。

**Review gate.** None. PR-5 is not review-gated.

**Merge.**

- [ ] 本人がマージする。

## 呼び鈴の購読を製品ごとに 1 つにする（PR-6）

**Depends on.** PR-5.

**Files.**

- [ ] Edit `src/hab/events.ts`（購読の対象をアドレスから製品へ）。
- [ ] Edit `src/host/config.ts`（運用者登録の呼び鈴を台帳の製品の行へ移す）。
- [ ] Edit `docs/connections/mcp-events.md`。

**Build.**

- [ ] `hab_event_subscriptions` の対象を `agent_id` から製品にする。製品のどのアドレスに届いても、その製品の購読が鳴る。通知には今どおり `to` を入れ、製品側がセッションへ振り分ける。
- [ ] 運用者登録の呼び鈴（Grok、PR-4 の Hermes）を、設定ファイルから台帳の製品の行へ移す。設定ファイルの古い登録は起動時に読み込んで移す。
- [ ] 移行で、今のアドレスごとの購読を製品の購読にまとめる。同じ製品で URL が 2 つ以上あれば、新しい方を残して記録する。

**You see.**

- [ ] Dots の製品に新しいアドレスを足しても、購読を作り直さずに呼び鈴が鳴る。

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] 2 アドレスの製品に購読 1 つで両方鳴る件、移行でまとまる件、`to` が正しい件を足す。

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Lane 1. Regression lane against trunk. 1 アドレスの製品では trunk と同じに鳴る。
- [ ] Lane 2. verify-hab で 2 アドレスの製品を作り、購読 1 つで両方の新着が鳴る。
- [ ] Lane 3. Mac mini で Dots と Grok の往復を確かめる。

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. なし。購読の数が減るだけで、配送の処理は変えない。
- [ ] Probe. なし。
- [ ] Baseline. なし。
- [ ] Rule. なし。

**Review gate.** The operator reviews before merge.

- [ ] Dots と Grok の往復の HAB の記録を本人に見せる。
- [ ] Post the screenshot of the result and a short video (or the HAB log lines when there is no screen) in chat. The operator reviews and clicks merge.

**Merge.**

- [ ] 本人がマージし、展開は本人の一言のあとに行う。

## 相手のセッションがないときにエラーにする（PR-7）

**Depends on.** PR-6.

**Files.**

- [ ] Edit `src/hab/events.ts`、`src/hab/sqlite-registry.ts`、`src/hab/agent-tools.ts`、`src/host/admin.ts`、`src/messaging/`。

**Build.**

- [ ] 呼び鈴の受け口が、通知の `to` に当たるセッションについて 410 と理由 `session_gone` を返したときだけ数える。応答なし、5xx、そのほかの 4xx は数えない。
- [ ] 続けて N 回（既定 3 回）になったら、台帳でそのアドレスを退役（`retired`）にする。行は消さない。`hab_send` は `recipient_absent` で断る。
- [ ] そのアドレスの未読は、送り手に不達を知らせてから消す。アドレスの名前は予約として残す。
- [ ] 本人が接続し直すか、製品が購読し直すと、状態を戻す。

**You see.**

- [ ] 410 を 3 回返す受け口に鳴らすと、`hab:admin status` の `problems` に `recipient_absent` が出て、`hab_send` が断られる。

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] 410 の回数、5xx を数えない件、戻る件、未読を消す件を足す。

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Lane 1. Regression lane against trunk. trunk は 410 で購読を消すだけ。head ではアドレスが「相手がいない」になる。
- [ ] Lane 2. 受け口を一時的に落としても（5xx）、アドレスは有効のまま。

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. `hab_send` の処理時間。
- [ ] Probe. 検証用スタックで `hab_send` を 100 回、trunk と head で交互に送る。
- [ ] Baseline. trunk の中央値を先に記録する。
- [ ] Rule. head が trunk より 10% 以上遅ければ失敗とする。

**Review gate.** The operator reviews before merge.

- [ ] 「相手がいない」になったときの `hab_send` の結果の文面を本人に見せる。
- [ ] Post the screenshot of the result and a short video (or the HAB log lines when there is no screen) in chat. The operator reviews and clicks merge.

**Merge.**

- [ ] 本人がマージし、展開は本人の一言のあとに行う。

## 受信・表示・実行の設計を 1 本にまとめる（PR-8）

**Depends on.** PR-7.

**Files.**

- [ ] Edit `docs/hab-decisions.md`（ADR-032 を足し、ADR-021 から ADR-031 との関係を書く）。
- [ ] Edit `docs/connections/agent-setup.md`、`.claude/skills/verify-hab/`。

**Build.**

- [ ] 受け取る、見せる、選んだとおりに動くの 3 段と、製品ごとの約束（付録 A の表）を ADR-032 に書く。
- [ ] 残る鳴らし直し（ADR-027）と静かな時間（ADR-030）を 1 つの規則として説明し直し、ADR-031 は PR-5 で置き換えたと書く。

**You see.**

- [ ] ADR の表で、ADR-032 が ADR-021 から ADR-031 のどれを置き換え、どれを残すかが読める。

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] リンク先がすべて存在する。

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Lane 1. verify-hab の機能マップを、PR-3 から PR-7 の動きで更新し、検証用スタックで 1 回通す。

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. なし。文書だけの PR。
- [ ] Probe. なし。
- [ ] Baseline. なし。
- [ ] Rule. なし。

**Review gate.** The operator reviews before merge.

- [ ] ADR-032 の本文を本人に見せる。
- [ ] Post the screenshot of the result and a short video (or the HAB log lines when there is no screen) in chat. The operator reviews and clicks merge.

**Merge.**

- [ ] 本人がマージする。

## Close the program

- [ ] すべての箱に証拠がある。
- [ ] 本人に、PR ごとの結果と、製品ごとの約束の最終の表を報告する。

## Appendix A. Prototype evidence

2026-11-20 に Mac mini（HAB 6a3dd40、のちに acacaff）で確かめた。時刻は UTC。

| 製品            | 受け取る                                               | 見せる                                      | 選んだとおりに動く                                |
| --------------- | ------------------------------------------------------ | ------------------------------------------- | ------------------------------------------------- |
| Hermes Desktop  | notifier。確認済み                                     | プラグインのカード。確認済み                | 自動受付から `hab_reply` まで約 11 秒。確認済み   |
| Dots（ChatGPT） | MCP Events。試験 C で 12 秒後に既読                    | 文章。`resources/read` を一度も呼ばない     | 見張りの指示に許可を書いたあと、29 秒で返信       |
| Grok Bot        | 運用者登録の呼び鈴。15:19:33 に鳴り 16 秒で既読        | Bot のチャットに文章                        | 15:19:57 に返信。初回の 15:14 は HAB に届かず失敗 |
| Muse            | 予定タスク。09:55:52 に既読                            | 文章。`tools/list` のあともカードを取らない | 10:01 に返信                                      |
| claude.ai       | 話しかけたときだけ                                     | カード。`resources_read_ui` を記録          | カードの「対応する」で会話に依頼文が入る          |
| Claude Code     | channels は開発用フラグで会話に届いた                  | 会話の中の文章                              | 未確認                                            |
| Codex           | app-server の外部の口がない（`daemon version` が失敗） | なし                                        | なし                                              |

カードのページは、MCP Apps の仕様どおりの最小ホスト（使い捨て）で描けて、`ui/message` も動いた。

## Appendix B. 本人が決めること

- PR-3 のセッションの登録の仕方。運用者が `hab:admin` で登録する（おすすめ）か、エージェントが MCP から申請して本人が承認するか（後者は別 PR）。
- PR-4 の notifier の保険の間隔（おすすめは 5 分）。
- PR-5 の `poll` 製品の既定の間隔と、`poll_overdue` を出す倍率（おすすめは 2 倍）。
- PR-6 の ChatGPT の扱い。ChatGPT のイベントは見張りを頼んだ 1 つの会話でしか動かないので、製品ごとに 1 購読だと Dots は実質 1 セッションになる。会話ごとに分けたいなら、購読にアドレスを指定できる形（11/21 の Mac 版の旧 PR-5）が要る。おすすめは方針どおり製品ごとに 1 つで進め、必要になったら ChatGPT だけ例外を足す。
- PR-7 の N 回と数える期間、未読を消す範囲、製品から「セッション終了」を知らせる口を作るか。
- Hook だけの製品（Dots、Grok）で呼び鈴が失敗したときの保険を、鳴らし直し（ADR-027）だけにするか（おすすめ）、製品側の予定タスクも作るか。

## Appendix C. この計画の型との違い

- 実行はクラウドの下請けではなく、Mac mini の Claude Code 1 体で行う。HAB の実機が Mac mini にあるため。
- 10 本の swarm レーンの代わりに、verify-hab の検証用スタックと Mac mini の実機確認を使う。レーンの数は PR ごとに必要な分だけにし、画面のないレーンはスクリーンショットの代わりに HAB の記録の行を証拠にする。check-plan の「Ten lanes」と「names no screenshot」の指摘は、この違いによるもので、意図して残す。
- control-ui と control-cli の代わりに、HTTP の要求と読み取り専用の DB の確認で操作する。
