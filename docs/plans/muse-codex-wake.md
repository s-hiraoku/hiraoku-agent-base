# Muse と Codex を自動で受け取る計画

Muse（`muse@muse.hab`）と Codex に、利用者が話しかけなくても HAB の新着が届くようにする。
対象の利用者は HAB でエージェント同士をつなぐ本人で、Codex の会話に新着が来たら Codex が自分で受信箱を読む状態を得る。
守る決まりは 3 つある。HAB は押し出さず呼び鈴を鳴らすだけ（ADR-015、ADR-022）。起こす文に送信者の本文を入れない（ADR-021）。返信を許すのは受け手の設定だけ（ADR-023）。
Muse は外から起こす公開の口がないので、今の予定タスク（15 分ごと）を正式な受け方として残す。Muse にコードの変更はない。
Codex は受信側の notifier が `codex queue --thread` で決まった一文を会話に入れて起こす。
PR は順に PR-1（Muse は polling と記録する文書）、PR-2（Codex を `codex queue` で起こす）。
PR-2 は付録 A の Q2（アプリの会話に届くか）が合格してから着手する。不合格なら PR-2 の代わりに PR-2b（Codex は話しかけたときだけと記録する文書）にする。

## How to read this

One box is one unit of work. Every box names the evidence that checks it. A nested box is a sub-step of the box above it. Check a box only when its evidence exists, a file, a log line, a screenshot, a test run, or a SHA. The body is a how-to. The appendices explain and record.

この計画は `pstack/skills/poteto-mode/playbooks/autopilot-stack.md` で進める。
実行するのは Mac mini の Claude Code（Remote Control）1 体で、クラウドの下請けと swarm は使わない（付録 C の C-4）。
PR のマージと Mac mini での設定変更は本人の操作で、PR-1 と PR-2 は merge-ready で止まる。

Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

## Program checklist

### Arm the program

- [ ] この計画を本人に示して止まる。実行は本人の明示の go で始める。
- [ ] 開始時と各段階で、trunk から次を読み直す。
  - [ ] `git show origin/main:docs/hab-decisions.md`
  - [ ] `git show origin/main:docs/receiver/arrival-notifier.md`
  - [ ] `git show origin/main:docs/connections/agent-setup.md`
  - [ ] `git show origin/main:.claude/skills/verify-hab/SKILL.md`
- [ ] 本人の go のあと、進み具合の確認を `/loop 1h` で回す。確認の文は次のとおりにする。
      「計画書を読み直し、進行中の PR の状態をブランチ、テスト結果、HAB の記録で確かめる。前回の報告から変わったことだけを、短い status message で本人に知らせる。変わっていなければ何も書かない。」
- [ ] 本人が止めたら、すべての作業を書き込みなしで止める。

### Spawn owners

- [ ] PR ごとに持ち主を 1 つにする。持ち主は Mac mini の Claude Code で、PR-1 と PR-2 を順に持つ。
- [ ] 依存の順を守る。
  - [ ] PR-1 は独立で、`main` から切る。
  - [ ] PR-2 は付録 A の Q2 が合格してから、`main` から切る。PR-1 とは触るファイルが重ならない。
- [ ] ファイルの境界を守る。PR-1 は `docs/**` だけを触る。PR-2 は `src/agent-notify/codex.ts`、`scripts/hab-notify.ts`、`test/agent-notify-codex*.test.js`、`docs/connections/agent-setup.md`、`.claude/skills/verify-hab/**` だけを触る。
- [ ] レビューの関門を守る。PR-2 は受け取りの動き方を変えるので、本人がチャットで画面写真と動画を見てからマージする。

### PR mechanics, for every PR

- [ ] forge は `gh` を使う。`origin` が使えたら記録する。`gt` は要らない。
- [ ] PR は draft にせず ready で開く。base は `main`。
- [ ] push の前に `npm run lint` と `npm run check` を 1 回通す。hooks は有効のまま push する。
- [ ] 各 commit の前に `/deslop`、レビューの前に `/no-comments` を通す。
- [ ] Codex レビューと CodeRabbit の指摘は `../references/bugbot-triage.md` に沿って直す、退ける、本人に聞くに分ける。
- [ ] code-ready の報告の前に trunk に追従する。自分のブランチでも rebase ではなく merge で取り込む（force-push は使わない）。

### Verdict and merge, for every PR

- [ ] 検証は code-ready の head で 1 回通す。gates の 1 段（`npm test`、設計検証 `automated-design-scope`）、Verify, live の 10 lanes、Verify, perf、差分と証拠を読む監査 2 本。
- [ ] すべて合格のときだけ clean とする。見つかったことは持ち主に戻す。head が変わったら判定し直す。
- [ ] マージは本人が行う。持ち主は merge-ready で止まり、本人の「マージして」を待つ。

### Boot recipe, for every live lane

各 lane は Mac mini の上で PR の head を使う。HAB は verify-hab の手順で loopback の host を立て、Codex は ChatGPT アプリ同梱の `codex`（0.171 以降）を使う。

- [ ] `git fetch origin <head-branch> && git checkout <head SHA>`。
- [ ] verify-hab の手順で使い捨ての HAB host と notifier を起動し、`hab:admin status` の `problems` が 0 になるまで待つ。本番の host と notifier には触らない。
- [ ] 入力は HAB の MCP（`hab_send`）と `codex` のコマンドだけで入れる。読むだけの確認は `hab:admin status`、`audit.jsonl`、`codex app-server daemon version` を使う。
- [ ] 画面写真は `/tmp/swarm-<pr-id>/worker-<n>/<slug>.png` に保存し、報告に道筋を付ける。

## Record Muse as a scheduled-poll receiver (PR-1)

**Depends on.** None.

**Files.**

- [ ] Edit `docs/connections/agent-setup.md`。
- [ ] Edit `docs/receiver/wake-model.md`。

**Build.**

- [ ] `agent-setup.md` の Muse の節に、受け方は予定タスクの polling だけで、外から起こす口がないことと、その根拠（付録 A の Q1）を書く。

**You see.**

- [ ] `agent-setup.md` の表で Muse の行が「予定タスク 15 分（Hook なし、確定）」になっている。

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] 文書だけなのでテストは足さない。設計検証の台帳 `verification/design/contract.json` の sha256 を更新し、`python3 -B -m hirastack audit --target . --spec verification/design/contract.json` が `current` を返す。

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `Mac mini の Claude Code（swarm なし）` at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. trunk と head で、本番の Muse 宛てに試験メールを 1 通送り、次の予定時刻まで待つ。trunk でも同じ受け方なので結果は同じになる。Save `pr1-lane1-muse-read.png`. Pass when 両方で 15 分以内に既読になる。
- [ ] Lane 2. Muse の予定タスクの一覧を Muse のアプリで開く。Save `pr1-lane2-schedule.png`. Pass when HAB の受信箱を見るタスクが 15 分間隔で有効になっている。
- [ ] Lane 3. Muse への試験メールに返信を求める本文を入れる。Save `pr1-lane3-reply.png`. Pass when 許可した送信元からなら `hab_reply` が記録される。
- [ ] Lane 4. `hab:admin status` を見る。Save `pr1-lane4-status.png`. Pass when Muse の受け方が `poll` 15 分で、`poll_overdue` が出ていない。
- [ ] Lane 5. 文書の Muse の節を開く。Save `pr1-lane5-doc.png`. Pass when 根拠の出典が付録 A と同じで、外から起こす口がないと書いてある。
- [ ] Lane 6. 文書の表を開く。Save `pr1-lane6-table.png`. Pass when Muse の行と本文の記述が食い違わない。
- [ ] Lane 7. Muse に M-1 の質問をした画面を開く。Save `pr1-lane7-muse-answer.png`. Pass when 予定タスク以外の起こし方がないという答えが写っている。
- [ ] Lane 8. 設計検証を流す。Save `pr1-lane8-audit.txt`. Pass when `status` が `current`。
- [ ] Lane 9. `wake-model.md` の Muse の行を開く。Save `pr1-lane9-wake-model.png`. Pass when 分類 D（製品の予定）と書いてある。
- [ ] Lane 10. 文書内のリンクを開く。Save `pr1-lane10-links.txt`. Pass when 切れたリンクが 0 件。

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. 試験メールの送信から Muse の既読までの秒数。trunk と head で同じ仕組みなので、同じ数字が出る。
- [ ] Probe. 試験メールを trunk と head で交互に 2 通ずつ送り、`audit.jsonl` の送信時刻と既読時刻の差を取る。
- [ ] Baseline. trunk の値を先に記録する。
- [ ] Rule. どの 1 通も 1,800 秒（間隔の 2 倍）を超えたら不合格。

**Review gate.** None. PR-1 is not review-gated.

**Merge.**

- [ ] head の SHA で clean の判定がある。
- [ ] Codex レビューと CodeRabbit の振り分けが済んでいる。
- [ ] 判定のあと trunk に追従し、patch-id が変わっていない。
- [ ] 本人がマージする。

## Wake a Codex conversation with codex queue (PR-2)

**Depends on.** 付録 A の Q2 の合格。PR-1 には依存しない。

**Files.**

- [ ] Edit `src/agent-notify/codex.ts`。
- [ ] Edit `scripts/hab-notify.ts`。
- [ ] Create `test/agent-notify-codex-queue.test.js`。
- [ ] Edit `docs/connections/agent-setup.md`。
- [ ] Edit `.claude/skills/verify-hab/SKILL.md`。

**Build.**

- [ ] `codex.ts` に起こす道を作る。画面の `show()`（届いた時点で、既読にしない）で `codex queue --thread <thread_id> --message <決まった一文> --remote <daemon のソケット>` を引数の配列で呼び、20 秒で打ち切る。決まった一文は「HAB に新着があります。hab_inbox を呼んで、届いたメールを notice のとおり見せてください。」で、送信者の本文は入れない。
  - [ ] 「対応する」後の `codexHandoff` は残し、WebSocket の `thread/resume` と `turn/start` を、承認済みの `handoff_prompt` を入れた `codex queue` に替える。`websocketConnect` と `CodexAppServer` は消す。
  - [ ] `codex queue` がスレッドを見つけられないと答えたら、PR-7 の `recipient_absent` として返す。終了コードが 0 以外か時間切れなら `unknown` とし、再送しない。
- [ ] `hab-notify.ts` の `codex` 設定を `thread_id`、`codex_bin`（既定 `codex`）、`daemon_socket`（既定 `~/.codex/app-server-control/app-server-control.sock`）に替え、`app_server` を消す。古い設定は起動時に理由付きで拒む。

**You see.**

- [ ] 試験メールを送ると、Codex アプリの試験用の会話に決まった一文が出て、Codex が `hab_inbox` を呼び、`notice` を見せる。notifier のログに `codex_queue ok` が 1 行出る。

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] `test/agent-notify-codex-queue.test.js` に、成功、終了コード 1、時間切れ、スレッドなし（`recipient_absent`）、起こす一文に本文が入らない、起こしたあともメッセージが未読のまま、「対応する」後の引き渡しが承認済みの本文で `codex queue` を呼ぶ、古い `app_server` 設定を拒む、の件を足す。`codex` は偽のコマンドに差し替える。Run `node --test test/agent-notify-codex-queue.test.js`。
- [ ] 全体を 1 回通す。Run `npm test`。

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `Mac mini の Claude Code（swarm なし）` at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. trunk と head で、待機中の Codex の試験用の会話宛てに試験メールを送る。trunk には起こす道がないので、trunk では会話に何も出ないことを記録し、head では会話に一文が出て `hab_inbox` まで進むことを確かめる。Save `pr2-lane1-idle-wake.png`. Pass when head で 30 秒以内に `hab_inbox` が audit に記録される。
- [ ] Lane 2. 作業中の会話に試験メールを送る。Save `pr2-lane2-busy.png`. Pass when 今の作業が壊れず、区切りで一文が処理される。
- [ ] Lane 3. 起こしたあと、HAB の状態を見る。Save `pr2-lane3-unread.png`. Pass when Codex が読むまでメッセージが未読のまま。
- [ ] Lane 4. 会話に出た文を見る。Save `pr2-lane4-no-body.png`. Pass when 送信者の本文が会話に一文として入っていない。
- [ ] Lane 5. 許可した送信元から返信を求める試験メールを送る。Save `pr2-lane5-reply.png`. Pass when `hab_reply` が送信者に届く。
- [ ] Lane 6. 「対応する」を選ぶ手動の流れを試す。Save `pr2-lane6-accept.png`. Pass when 承認済みの本文が会話に入り、既読になる。
- [ ] Lane 7. 試験用の会話を消してから送る。Save `pr2-lane7-absent.png`. Pass when `recipient_absent` が記録され、再送しない。
- [ ] Lane 8. daemon を止めてから送る。Save `pr2-lane8-no-daemon.png`. Pass when `unknown` が記録され、保険の確認（5 分）で未読が残っていると分かる。
- [ ] Lane 9. Codex アプリを再起動してから送る。Save `pr2-lane9-app-restart.png`. Pass when 同じ会話に届く。
- [ ] Lane 10. 試験メールを 1 分に 3 通送る。Save `pr2-lane10-burst.png`. Pass when 一文は重ならずに入り、3 通とも `hab_inbox` で読まれる。

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. 送信から Codex の `hab_inbox` までの秒数。trunk には起こす道がないので、head の秒数を絶対の予算で測り、trunk は「話しかけるまで読まれない」ことを記録する。
- [ ] Probe. 試験メールを 5 通、間を 1 分空けて送り、`audit.jsonl` の送信時刻と `hab_inbox` の時刻の差を取る。trunk でも同じ 5 通を交互に送る。
- [ ] Baseline. trunk で 5 通とも 10 分以内に読まれないことを先に記録する。
- [ ] Rule. head の中央値が 30 秒、最大が 60 秒を超えたら不合格。`codex queue` 1 回の実行が 20 秒を超えたら不合格。

**Review gate.** The operator reviews before merge.

- [ ] lane 1、lane 3、lane 4 の screenshot（画面写真）を `docs/history/media/pr2-review-<slug>.png` に写す。
- [ ] lane の Mac mini で、送信から Codex の返信までの 30 秒から 60 秒の video（動画）を撮り、`docs/history/media/pr2-review.mp4` に置く。
- [ ] screenshot と video をチャットに出す。merge-ready で止まり、operator（本人）のマージを待つ。

**Merge.**

- [ ] head の SHA で clean の判定がある。
- [ ] Codex レビューと CodeRabbit の振り分けが済んでいる。
- [ ] 判定のあと trunk に追従し、patch-id が変わっていない。
- [ ] 本人がマージし、Mac mini への導入は本人の別の一言で行う。

## Close the program

- [ ] 上の箱がすべて証拠付きで埋まっている。
- [ ] 本人に、PR ごとの判定と、Mac mini に入れる手順（daemon の常駐のさせ方を含む）を報告する。

## Appendix A. Prototype evidence

**Q1. Muse を外から起こす口はあるか。** 公開情報では、ない。自動の実行は予定タスクだけで、第三者の試験では最短 1 分、30 秒は受け付けなかった（[SmartScope](https://smartscope.blog/en/blog/claude-code-delegate-tasks-meta-muse-using-spreadsheets-2026/)、[dev.to](https://dev.to/ying_liao_0a481102ff971b4/automating-real-work-with-muse-connectors-scheduled-tasks-58co)）。Webhook、メールの到着、MCP のイベントで動く記述はない。nenwa も Muse を起こせない相手として扱う（[nenwa DESIGN.md](https://github.com/nogu66/nenwa/blob/b9b87731da65b3f62876c0797e88d53a342eddb3/DESIGN.md)）。2026-11-20 には予定タスクが自動で `hab_inbox` と `hab_reply` まで進んだ。未確認なのは Muse 自身の答え（M-1）だけで、本人が Muse のチャットで 1 問聞く。

**Q2. `codex queue` は Codex アプリの会話に届くか。** 未確認。2026-11-21 14:1x JST に Mac mini で読むだけの調査をした。

- `codex` は 2 つある。`~/.local/bin/codex` が 0.149.0、ChatGPT アプリ同梱の `/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex` が 0.171.0-alpha.13。`--resume` は 0.171 だけにある。
- `codex queue` の接続先は daemon の制御ソケット `~/.codex/app-server-control/app-server-control.sock` で、`thread/queue/add` を送る。存在しないスレッドへの試し送り（`--remote unix://`）は、両方の版でソケットがないと言って exit 1 で終わった。会話には何も入っていない。
- アプリの app-server は ChatGPT アプリの子プロセスで、`--listen` がなく stdio だけで動いている。TCP の待ち受けも名前付きのソケットもない。daemon は動いていない。
- アプリと CLI の会話は同じ `~/.codex`（`sessions/`、`queue_1.sqlite`、`state_5.sqlite`）に入っている。バイナリには `queued_items` の表と、変わったことを知らせる revision の仕組みがある。
- ここから推測できること（未確認）。daemon を起動すれば queue は共有の `queue_1.sqlite` に積まれ、アプリの app-server が revision でそれを拾って会話に流す可能性がある。版の差（daemon 0.149 とアプリ 0.171）で弾かれる可能性もあるので、試すときは同梱の 0.171 を使う。
- 次の試し（本人の了承待ち）。同梱の 0.171 で daemon を一時起動し、アプリで開いた試験用の会話 1 つに `codex queue` を送り、アプリに出るかを見て、daemon を止める。合格なら PR-2、不合格なら PR-2b。

**Q3. Codex の hooks で起こせるか。** 起こせない。`~/.codex/hooks.json` の `Stop` や `PostToolUse` は会話が動いているときだけ走るので、待機中の会話は起きない（[Codex hooks](https://learn.chatgpt.com/docs/hooks)）。補助として使う余地はあるが、この計画には入れない。

## Appendix B. Alternatives rejected

- **今の WebSocket の引き渡しを残す。** アプリの app-server は stdio だけで外から入れないので、今の `codexHandoff` はアプリの会話に届かない。消して `codex queue` に一本化する。
- **`thread/inject_items` で本文を入れる。** 承認していない本文がモデルの履歴に入る（ADR-021 で退けた）。
- **notifier が自分で app-server か `codex exec` を起動する。** 利用者が見ている会話の外で動く。
- **Codex の hooks を主にする。** 待機中の会話を起こせない（Q3）。
- **Muse の間隔を 1 分に縮める。** 起こす口がない問題は変わらず、Muse の利用枠を多く使う。本人が望んだときだけ変える。
- **呼び鈴をアドレスごとでなく製品ごとにまとめる（PR-6）。** 本人の判断で後回し。この計画は今のアドレスごとの呼び鈴のまま進める。

## Appendix C. Risks

- **C-1. daemon とアプリの app-server が同じ `~/.codex` を同時に書く（PR-2）。** `thread-writer-locks/` があるので排他はあると見ているが未確認。持ち主は lane 9 と lane 10 で会話の記録が壊れないかを見る。
- **C-2. daemon を常駐させる必要がある（PR-2）。** 導入時に launchd で常駐させるか、`codex app-server daemon enable` のような製品の仕組みを使うかを決める。Mac mini の設定変更なので本人の一言が要る。
- **C-3. 版の差（PR-2）。** `~/.local/bin/codex` は 0.149 で `--resume` がない。`codex_bin` はアプリ同梱の版を指す。アプリの更新で道筋が変わったら notifier の起動時に知らせる。
- **C-4. swarm を使わない（全 PR）。** 実機が Mac mini 1 台で、Codex アプリも 1 つなので、10 lanes は持ち主が順に回す。並列の検証はできない。
- **C-5. 呼び鈴の一文がモデルへの指示になる（PR-2）。** 文は HAB が決めた固定文で、送信者は変えられない。本文は `hab_inbox` の `notice` の枠の中だけに出る。

## Appendix D. Links and reading list

- 読むもの。`docs/hab-decisions.md`（ADR-015、ADR-021、ADR-022、ADR-023）、`docs/receiver/arrival-notifier.md`、`src/agent-notify/notifier.ts`（`check()` と `#finishAccept`）、`src/agent-notify/codex.ts`。
- 外部の資料。[openai/codex PR #39092](https://github.com/openai/codex/pull/39092)、[Developer commands](https://learn.chatgpt.com/docs/developer-commands)、[nenwa daemon.rs](https://github.com/nogu66/nenwa/blob/b9b87731da65b3f62876c0797e88d53a342eddb3/src/daemon.rs#L400-L425)。
- PR-2 は着手前に `pstack/skills/how/SKILL.md` を通す。`interrogate` は使わない（設計の争点が Q2 の事実だけなので）。
- 判断の記録はこの付録とスレッドに残す。commit はしない。
