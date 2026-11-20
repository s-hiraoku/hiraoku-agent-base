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

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `Mac mini Claude Code` at the PR head, per the boot recipe.

- [x] Lane 1. Regression lane against trunk. trunk と head で `tools/list` を送る。trunk には `method` の行がなく、head は `tools_list` を書く。Save `pr1-lane1-audit.jsonl`. Pass when head の行が 1 件ある。
- [x] Lane 2. `tools/call`（`hab_inbox`）を送る。Save `pr1-lane2-audit.jsonl`. Pass when `tools_call` の行が `tool_started` と同じ correlation にある。
- [x] Lane 3. `prompts/list` を送る。Save `pr1-lane3-audit.jsonl`. Pass when 405 で、`prompts_list` のあとに `resource_rejected` が続く。
- [x] Lane 4. 表にないメソッド `x-private/probe` を送る。Save `pr1-lane4-audit.jsonl`. Pass when `other` が記録され、その文字列が記録にない。
- [x] Lane 5. `resources/read` で `ui://hab/inbox-v1` を読む。Save `pr1-lane5-audit.jsonl`. Pass when `resources_read_ui` が記録される。
- [ ] Lane 6. `resources/read` で `file:///etc/passwd` を読む。Save `pr1-lane6-audit.jsonl`. Pass when `resources_read_other` で、URI が記録にない。
- [ ] Lane 7. Mcp-Method の見出しと本文のメソッドを食い違わせる。Save `pr1-lane7-audit.jsonl`. Pass when `mismatch` が記録される。
- [ ] Lane 8. 認証なしの要求を送る。Save `pr1-lane8-audit.jsonl`. Pass when `method` の行が出ず、`auth_denied` だけになる。
- [ ] Lane 9. 監査ファイルを回転させる大きさまで要求を送る。Save `pr1-lane9-ls.txt`. Pass when `audit.jsonl.1` ができ、権限が 0600 のまま。
- [x] Lane 10. Mac mini の実機で claude.ai から受信箱を見る。Save `pr1-lane10-audit.jsonl`. Pass when claude の接続に `resources_read_ui` の行がある（2026-11-20 10:04:04 UTC に確認済み）。

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

- [x] 製品ごとの手順と「AI に渡す文」と、確認結果の表を書く。PR #244（ブランチ `claude/project-thread-1p20u7`）に一本化。#246 は同じ内容の旧版。

**You see.**

- [x] 手順書の表が、付録 A の確認結果と一致する。

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] 文書の中のリンク先がすべて存在する。Run `npx prettier --check docs/connections/agent-setup.md`。

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `Mac mini Claude Code` at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. trunk には `docs/connections/agent-setup.md` がない。head ではリンク先がすべて存在する。Save `pr2-lane1-links.txt`. Pass when 存在しないリンクが 0 件。
- [ ] Lane 2. Hermes の文を Mac の Claude Code に渡す。Save `pr2-lane2-hermes.txt`. Pass when 試験メールでカードが出る。
- [x] Lane 3. Dots の文を stallone の会話に渡す。Save `pr2-lane3-dots.png`. Pass when 試験メールに返信が届く（試験 C で 29 秒、確認済み）。
- [x] Lane 4. Grok の文で routine を作る。Save `pr2-lane4-grok.png`. Pass when 呼び鈴から返信まで進む（24 秒、確認済み）。
- [x] Lane 5. Muse の文で予定タスクを作る。Save `pr2-lane5-muse.png`. Pass when 予定の時刻に既読と返信が記録される（確認済み）。
- [x] Lane 6. claude.ai の文を渡す。Save `pr2-lane6-claude.png`. Pass when カードが出る（確認済み）。
- [ ] Lane 7. Claude Code の `/loop` の文を実行する。Save `pr2-lane7-claude-code.txt`. Pass when 10 分ごとに `tools_call` が記録される。
- [ ] Lane 8. Codex の文を渡す。Save `pr2-lane8-codex.txt`. Pass when 話しかけたときに受信箱が読める。
- [ ] Lane 9. 「うまく動かないとき」の呼び鈴の項で `hab:admin status` を実行する。Save `pr2-lane9-status.json`. Pass when 文書の欄の名前と出力が一致する。
- [ ] Lane 10. 文書に実在のホスト名や鍵がないかを調べる。Save `pr2-lane10-grep.txt`. Pass when `ts.net` と鍵の文字列が 0 件。

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

- [ ] Edit `src/hab/sqlite-registry.ts`（`hab_products` と `hab_agents` に列を足し、移行を書く）。
- [ ] Edit `src/host/admin.ts`（設定と表示の操作）。
- [ ] Edit `docs/hab-decisions.md`（ADR-032 の台帳の部分を先に書く）。
- [ ] Create `test/hab-registry-receive.test.js`。

**Build.**

- [ ] `hab_products` に受け方（`hook` / `poll` / `on_request`）と、`poll` のときの間隔を足す。
- [ ] `hab_agents` に、製品側のセッション名と、結び付けた人と時刻を足す。HAB はこの名前を製品に渡すだけで、中身は解釈しない。
- [ ] `hab:admin` に、製品の受け方とアドレスのセッションを設定・表示する操作を足す。
- [ ] 移行で、既存の 5 アドレスを仮のセッションとして登録する。今の配送と呼び鈴の動きは変えない。

**You see.**

- [ ] `hab:admin status` に、製品ごとの受け方と、アドレスごとのセッションが出る。

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] 移行、受け方の設定、セッションの設定と表示、未設定のときの既定の件を足す。Run `node --test test/hab-registry-receive.test.js`。

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `Mac mini Claude Code` at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. trunk の DB を head で開く。Save `pr3-lane1-migrate.txt`. Pass when 移行が終わり、配送と呼び鈴が trunk と同じに動く。
- [ ] Lane 2. 5 アドレス相当を作り、`hab:admin status` を取る。Save `pr3-lane2-status.json`. Pass when 製品ごとの受け方とアドレスごとのセッションが出る。
- [ ] Lane 3. 製品の受け方を `poll`、間隔 1 分に設定する。Save `pr3-lane3-product.json`. Pass when status に間隔が出る。
- [ ] Lane 4. アドレスにセッション名を設定する。Save `pr3-lane4-agent.json`. Pass when 結び付けた人と時刻が記録される。
- [ ] Lane 5. 1 アドレスに 2 つ目のセッションを結び付けようとする。Save `pr3-lane5-reject.res`. Pass when 1 対 1 違反で断られる。
- [ ] Lane 6. 存在しない製品に受け方を設定する。Save `pr3-lane6-reject.res`. Pass when `not_found` で断られる。
- [ ] Lane 7. 権限のない接続で設定の操作を呼ぶ。Save `pr3-lane7-forbidden.res`. Pass when `forbidden` で断られる。
- [ ] Lane 8. 移行を 2 回流す。Save `pr3-lane8-migrate-twice.txt`. Pass when 2 回目は何も変えない。
- [ ] Lane 9. host を再起動する。Save `pr3-lane9-restart.json`. Pass when 設定が残っている。
- [ ] Lane 10. Mac mini の DB の読み取り専用の複製で移行を試す。Save `pr3-lane10-macmini-copy.json`. Pass when 5 アドレスが仮セッションになり、本番の DB は変わらない。

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

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `Mac mini Claude Code` at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. 試験メールを送り、受付から notifier の `shown` までを測る。Save `pr4-lane1-runlog.txt`. Pass when head が 2 秒以内（trunk は最大 15 秒）。
- [ ] Lane 2. notifier を止めて呼び鈴を鳴らす。Save `pr4-lane2-events.txt`. Pass when HAB が失敗を数え、再送する。
- [ ] Lane 3. 署名の違う要求を受け口に送る。Save `pr4-lane3-runlog.txt`. Pass when 確認が走らない。
- [ ] Lane 4. 古い timestamp の要求を送る。Save `pr4-lane4-runlog.txt`. Pass when 拒否される。
- [ ] Lane 5. 購読の宛先に `http://127.0.0.1` を指定する。Save `pr4-lane5-subscribe.res`. Pass when `invalid_callback_url` で拒否される。
- [ ] Lane 6. 運用者設定に `http://10.0.0.1` を書く。Save `pr4-lane6-start.txt`. Pass when host が起動を拒否する。
- [ ] Lane 7. 呼び鈴の受け口を止めたまま新着を送る。Save `pr4-lane7-runlog.txt`. Pass when 定期確認でカードが出る。
- [ ] Lane 8. 自動受付の相手から送る。Save `pr4-lane8-audit.jsonl`. Pass when `auto_handoff` と返信が記録される。
- [ ] Lane 9. Hermes Desktop を再起動する。Save `pr4-lane9-hermes.png`. Pass when 再起動後もカードが出る。
- [ ] Lane 10. Mac mini の実機で、Hermes Desktop のカードを開く。Save `pr4-lane10-hermes-card.png`. Pass when カードが出て、「対応する」で返信が届く。

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

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `Mac mini Claude Code` at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. 新着を置いて 11 分待つ。Save `pr5-lane1-checks.txt`. Pass when trunk は `hab_event_checks` が増え、head は増えない。
- [ ] Lane 2. 鳴らし直しの条件を作る。Save `pr5-lane2-rerings.txt`. Pass when ADR-027 の鳴らし直しは今どおり動く。
- [ ] Lane 3. `inbox_check` を含む古い設定で起動する。Save `pr5-lane3-start.txt`. Pass when 起動し、使わない旨が 1 回だけ記録される。
- [ ] Lane 4. 間隔 1 分の `poll` 製品を作り、受信箱を読まずに 2 分待つ。Save `pr5-lane4-status.json`. Pass when `poll_overdue` が出る。
- [ ] Lane 5. 続けて受信箱を読む。Save `pr5-lane5-status.json`. Pass when `poll_overdue` が消える。
- [ ] Lane 6. 間隔ちょうど 2 倍の時刻で status を取る。Save `pr5-lane6-status.json`. Pass when 境目の扱いがテストと一致する。
- [ ] Lane 7. 受け方が `hook` の製品で受信箱を読まずに待つ。Save `pr5-lane7-status.json`. Pass when `poll_overdue` は出ない。
- [ ] Lane 8. `on_request` の製品で待つ。Save `pr5-lane8-status.json`. Pass when `poll_overdue` は出ない。
- [ ] Lane 9. host を再起動して最後に読んだ時刻を見る。Save `pr5-lane9-restart.json`. Pass when 時刻が残り、誤って `poll_overdue` にならない。
- [ ] Lane 10. Mac mini の実機で Muse の予定タスクを一時停止する（本人の操作）。Save `pr5-lane10-muse-audit.jsonl`. Pass when 間隔の 2 倍後に `poll_overdue` が出て、再開で消える。

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

- [ ] 2 アドレスの製品に購読 1 つで両方鳴る件、移行でまとまる件、`to` が正しい件を足す。Run `node --test test/hab-events.test.js`。

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `Mac mini Claude Code` at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. 1 アドレスの製品で新着を送る。Save `pr6-lane1-rings.txt`. Pass when trunk と同じに鳴る。
- [ ] Lane 2. 2 アドレスの製品を作り、購読 1 つで両方に新着を送る。Save `pr6-lane2-rings.txt`. Pass when 2 回鳴り、それぞれの `to` が正しい。
- [ ] Lane 3. 購読のあとにアドレスを足して新着を送る。Save `pr6-lane3-rings.txt`. Pass when 購読を作り直さずに鳴る。
- [ ] Lane 4. アドレスごとの購読が 2 つある trunk の DB を移行する。Save `pr6-lane4-migrate.txt`. Pass when 製品の購読 1 つにまとまり、記録が残る。
- [ ] Lane 5. 設定ファイルに運用者登録の呼び鈴がある状態で起動する。Save `pr6-lane5-start.txt`. Pass when 台帳の製品の行に移る。
- [ ] Lane 6. 別の製品のアドレスへ新着を送る。Save `pr6-lane6-rings.txt`. Pass when 関係のない製品の購読は鳴らない。
- [ ] Lane 7. 製品の購読を解除する。Save `pr6-lane7-unsub.res`. Pass when その製品のどのアドレスでも鳴らない。
- [ ] Lane 8. 静かな時間（ADR-030）の間に同じ製品の 2 アドレスへ送る。Save `pr6-lane8-quiet.txt`. Pass when 抑制がアドレスごとに効く。
- [ ] Lane 9. Mac mini で Dots へ試験メールを送る。Save `pr6-lane9-dots-audit.jsonl`. Pass when 呼び鈴から既読と返信までが記録される。
- [ ] Lane 10. Mac mini で Grok へ試験メールを送る。Save `pr6-lane10-grok-audit.jsonl`. Pass when 呼び鈴から既読と返信までが記録される。

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

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `Mac mini Claude Code` at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. 410 を返す受け口に鳴らす。Save `pr7-lane1-status.json`. Pass when trunk は購読を消すだけ、head は回数を数える。
- [ ] Lane 2. `session_gone` 付きの 410 を 3 回返す。Save `pr7-lane2-status.json`. Pass when `recipient_absent` が `problems` に出る。
- [ ] Lane 3. そのアドレスへ `hab_send` する。Save `pr7-lane3-send.res`. Pass when `recipient_absent` で断られる。
- [ ] Lane 4. 5xx を返し続ける。Save `pr7-lane4-status.json`. Pass when アドレスが有効のまま。
- [ ] Lane 5. 応答しない受け口にする。Save `pr7-lane5-status.json`. Pass when アドレスが有効のまま。
- [ ] Lane 6. 「相手がいない」のアドレスの未読を見る。Save `pr7-lane6-delivery.txt`. Pass when 送り手に不達が届き、未読が消える。
- [ ] Lane 7. アドレスの名前を別のセッションで登録しようとする。Save `pr7-lane7-admin.txt`. Pass when 予約済みで拒否される。
- [ ] Lane 8. 製品が購読し直す。Save `pr7-lane8-status.json`. Pass when 状態が戻り、送信できる。
- [ ] Lane 9. host を再起動する。Save `pr7-lane9-status.json`. Pass when 状態と回数が保たれる。
- [ ] Lane 10. Mac mini の実機で、Grok の routine を止めて鳴らす。Save `pr7-lane10-status.json`. Pass when 5xx か応答なしでは数えない。

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
- [ ] 重なっている鳴らし直し（ADR-027）、静かな時間（ADR-030）、定期確認（ADR-031）を、1 つの規則として説明し直す。ADR-031 は PR-5 で置き換えたと書く。

**You see.**

- [ ] ADR の表で、ADR-032 が ADR-021 から ADR-031 のどれを置き換え、どれを残すかが読める。

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] リンク先がすべて存在する。

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `Mac mini Claude Code` at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. trunk に ADR-032 がない。head ではリンク先がすべて存在する。Save `pr8-lane1-links.txt`. Pass when 存在しないリンクが 0 件。
- [ ] Lane 2. ADR の表を読む。Save `pr8-lane2-table.txt`. Pass when ADR-032 が置き換える ADR と残す ADR が書かれている。
- [ ] Lane 3. 設計の契約で audit を流す。Save `pr8-lane3-audit.json`. Pass when `status` が `current`。
- [ ] Lane 4. verify-hab で Hermes の Hook を通す。Save `pr8-lane4-evidence.txt`. Pass when 機能マップの手順どおりに動く。
- [ ] Lane 5. verify-hab で製品ごとの間隔を通す。Save `pr8-lane5-evidence.txt`. Pass when 機能マップの手順どおりに動く。
- [ ] Lane 6. verify-hab でアドレス指定の購読を通す。Save `pr8-lane6-evidence.txt`. Pass when 機能マップの手順どおりに動く。
- [ ] Lane 7. verify-hab で相手がいないエラーを通す。Save `pr8-lane7-evidence.txt`. Pass when 機能マップの手順どおりに動く。
- [ ] Lane 8. 手順書の表と ADR-032 の表を比べる。Save `pr8-lane8-diff.txt`. Pass when 一致する。
- [ ] Lane 9. `npm test` を流す。Save `pr8-lane9-test.txt`. Pass when 失敗が 0 件。
- [ ] Lane 10. 本人が ADR-032 を読む。Save `pr8-lane10-review.txt`. Pass when 本人が承認する。

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
- PR-6 の ChatGPT の扱い。ChatGPT のイベントは見張りを頼んだ 1 つの会話でしか動かないので、製品ごとに 1 購読だと Dots は実質 1 セッションになる。会話ごとに分けたいなら、購読にアドレスを指定できる形（この計画の初版の PR-5）が要る。おすすめは方針どおり製品ごとに 1 つで進め、必要になったら ChatGPT だけ例外を足す。
- PR-7 の N 回と数える期間、未読を消す範囲、製品から「セッション終了」を知らせる口を作るか。
- Hook だけの製品（Dots、Grok）で呼び鈴が失敗したときの保険を、鳴らし直し（ADR-027）だけにするか（おすすめ）、製品側の予定タスクも作るか。

## Appendix C. この計画の型との違い

- 実行はクラウドの下請けではなく、Mac mini の Claude Code 1 体で行う。HAB の実機が Mac mini にあるため。
- 10 本の swarm レーンの代わりに、verify-hab の検証用スタックと Mac mini の実機確認を使う。レーンは型どおり 10 本にし、画面のないレーンは `Save` に HAB の記録や応答のファイルを指定する。
- control-ui と control-cli の代わりに、HTTP の要求と読み取り専用の DB の確認で操作する。
