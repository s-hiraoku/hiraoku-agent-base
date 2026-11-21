# Muse の定期受信と Codex への引き渡しの計画

Muse（`muse@muse.hab`）は今の予定タスク（15 分ごと）で HAB の新着を確認する。外部から起動する公開インターフェースは確認できていない。PR-1 で確認結果と設定方法を文書に記録する。
ローカルの Codex では、HAB の受信通知で「対応する」を選んだとき、PR-2 で追加する `codex queue` を使って検証済みの同じ会話に依頼を渡せるようにする（ADR-021）。利用者が対象の notifier に設定した送信元と種類は、既存の自動受付（ADR-023）を使える。
呼び鈴は受信側に確認を促し（ADR-015、ADR-022）、新着の画面表示はモデルを起動せず未読を保つ（ADR-021）。利用者が設定した自動受付の対象外でも受信だけでモデルを起動する案は、新たな承認条件、既読の扱い、再送と重複防止の設計を ADR で決めてから扱う。
付録 A の Q2 では 2026-11-21 14:49 JST に Mac mini のローカル会話でキュー受付と turn の開始を観測した。HAB の承認から引き渡しまでの通し検証は PR-2 で行う。ChatGPT のプロジェクト内の会話（クラウド側）への配送は Q4 として別に調べる。

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
  - [ ] PR-2 は付録 A の Q2 が合格してから、最新の `main` から切る。両 PR が触る文書と設計台帳は、先に入った変更に合わせて更新する。
- [ ] ファイルの境界を守る。PR-1 は下記の文書と設計台帳を更新する。PR-2 の変更先は下記の Files に示す。
- [ ] レビューの関門を守る。PR-2 は承認後の引き渡し経路を増やすので、本人がチャットで画面写真と動画を見てからマージする。

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

各 lane は Mac mini の上で PR の head を使う。HAB は verify-hab の手順で loopback の host を立て、Codex のキュー経路は Q2 で試した ChatGPT アプリ同梱の `codex` を使う。別の版を使う試験では、実際の版とコマンドの対応を記録する。

- [ ] `git fetch origin <head-branch> && git checkout <head SHA>`。
- [ ] verify-hab の手順で使い捨ての HAB host と notifier を起動し、`hab:admin status` の `problems` が 0 になるまで待つ。本番の host と notifier には触らない。
- [ ] 入力は HAB の MCP（`hab_send`）と `codex` のコマンドだけで入れる。読むだけの確認は `hab:admin status`、`audit.jsonl`、`codex app-server daemon version` を使う。
- [ ] 画面写真は `/tmp/swarm-<pr-id>/worker-<n>/<slug>.png` に保存し、報告に道筋を付ける。
- [ ] PR-1 は受け方を文書に記録する。Muse の予定タスクは本番の HAB コネクタを読むので、PR-1 の lanes は使い捨ての host を使わず、本番の観察として行う。本番の Muse に送るのは試験メールだけで、本人の一言を得てから送る。設定は変えない。

## Record Muse as a scheduled-poll receiver (PR-1)

**Depends on.** None.

**Files.**

- [ ] Edit `docs/connections/agent-setup.md`。
- [ ] Edit `docs/receiver/wake-model.md`。
- [ ] Edit `verification/design/contract.json`。

**Build.**

- [ ] `agent-setup.md` の Muse の節に、受け方は予定タスクの polling だけで、外から起こす公開手段が確認できなかったことと、その根拠（付録 A の Q1）を書く。

**You see.**

- [ ] `agent-setup.md` の表で Muse の行が「予定タスク 15 分（現行の設定）」になっている。

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] 文書だけなのでテストは足さない。設計検証の台帳 `verification/design/contract.json` の sha256 を更新し、`python3 -B -m hirastack audit --target . --spec verification/design/contract.json` が `current` を返す。

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `Mac mini の Claude Code（swarm なし）` at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. PR-1 は動く仕組みを変えないので、trunk と head の比べ方はない。そのことを記録し、本番の観察として、Muse 宛てに試験メールを 1 通送って次の予定時刻まで待つ。Save `pr1-lane1-muse-read.png`. Pass when 15 分以内に既読になる。
- [ ] Lane 2. Muse の予定タスクの一覧を Muse のアプリで開く。Save `pr1-lane2-schedule.png`. Pass when HAB の受信箱を見るタスクが 15 分間隔で有効になっている。
- [ ] Lane 3. Muse への試験メールに返信を求める本文を入れる。Save `pr1-lane3-reply.png`. Pass when 許可した送信元からなら `hab_reply` が記録される。
- [ ] Lane 4. `hab:admin status` を見る。Save `pr1-lane4-status.png`. Pass when Muse の受け方が `poll` 15 分で、`poll_overdue` が出ていない。
- [ ] Lane 5. 文書の Muse の節を開く。Save `pr1-lane5-doc.png`. Pass when 根拠の出典が付録 A と同じで、外から起こす公開手段が確認できなかったと書いてある。
- [ ] Lane 6. 文書の表を開く。Save `pr1-lane6-table.png`. Pass when Muse の行と本文の記述が食い違わない。
- [ ] Lane 7. Muse に M-1 の質問をした画面を開く。Save `pr1-lane7-muse-answer.png`. Pass when 公開されている起動手段についての回答が写っている。
- [ ] Lane 8. 設計検証を流す。Save `pr1-lane8-audit.txt`. Pass when `status` が `current`。
- [ ] Lane 9. `wake-model.md` の Muse の行を開く。Save `pr1-lane9-wake-model.png`. Pass when 分類 D（製品の予定）と書いてある。
- [ ] Lane 10. 文書内のリンクを開く。Save `pr1-lane10-links.txt`. Pass when 切れたリンクが 0 件。

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. 本番の観察で、試験メールの送信から Muse の既読までの秒数。PR-1 は仕組みを変えないので、trunk と head の差は測らない。
- [ ] Probe. 試験メールを 1 時間に 2 通送り、本番の `audit.jsonl` の送信時刻と既読時刻の差を取る。
- [ ] Baseline. 2026-11-20 の実機の値（予定タスクで既読）を基準として記録する。
- [ ] Rule. どの 1 通も 1,800 秒（間隔の 2 倍）を超えたら不合格。

**Review gate.** None. PR-1 is not review-gated.

**Merge.**

- [ ] head の SHA で clean の判定がある。
- [ ] Codex レビューと CodeRabbit の振り分けが済んでいる。
- [ ] 判定のあと trunk に追従し、patch-id が変わっていない。
- [ ] 本人がマージする。

## Deliver approved handoffs with codex queue (PR-2)

**Depends on.** 付録 A の Q2 の合格。PR-1 には依存しない。

**Files.**

- [ ] Edit `src/agent-notify/codex.ts`。
- [ ] Edit `scripts/hab-notify.ts`。
- [ ] Create `test/agent-notify-codex-queue.test.js`。
- [ ] Edit `test/hab-notify-cli.test.js`。
- [ ] Edit `docs/connections/agent-setup.md`。
- [ ] Edit `.claude/skills/verify-hab/SKILL.md`。
- [ ] Edit `verification/design/contract.json`。

**Build.**

- [ ] Codex の `screen.queue` に、アプリ同梱の `codex_bin` の絶対パスと、準備済みのローカル Unix ソケットの絶対パス `daemon_socket` を明示する。既存の `thread_id` を使い、対象の会話は導入時に利用者が確認する。既存の `app_server` 設定はそのまま使える。両方が設定された場合は起動時に設定エラーとする。どちらも省略した場合は従来どおり表示だけが使える。
- [ ] 通知記録は従来どおり HAB 接続・受信者・製品セッションに結び付ける。キュー経路の結び付けには正規化したローカルソケットのパスと対象の `thread_id` を使う。既存の WebSocket 設定の結び付けは維持する。経路を切り替えるときは未処理の通知を確認してから、経路ごとの通知記録を使う。戻す手順では元の設定と記録を再利用する。
- [ ] `AgentScreen.show()` と `show-again` は従来どおり通知を画面に出す。未読を保ち、`codex queue` の呼び出しやモデルの起動は「対応する」の処理に限る。
- [ ] 手動の「対応する」か、既存の ADR-023 のルールで自動受付された後に、既存の `accepting` の記録と既読処理を経て `codexHandoff` へ渡す。キュー経路は登録した `thread_id` と承認済みの `handoff_prompt` を引数の配列で `codex queue --thread … --message … --remote …` に渡し、20 秒で打ち切る。自動受付では既存のルール名と権限制限を含む文面を使う。
- [ ] 終了コード 0 は `queued`（キュー受付）とする。対象の会話が存在せず入力を受け付けなかったと確実に分かる場合は `unsupported`。タイムアウトや結果を判定できない異常終了はエラーを返し、既存の notifier が `unknown` を記録する。既存の SQLite の選択記録が、同じ対象・`sender_id`・`message_id` の再実行を防ぐ。結果が不明でも再実行せず、別の会話や経路に切り替えない。
- [ ] 手動の選択と結果は既存の通知記録で確認できるようにする。自動受付では実行前のルール・送信元・メッセージ識別子と結果の既存監査を使い、引き渡しの本文や認証情報をログへ追加しない。
- [ ] ローカル CLI の結果は引き渡しの結果にだけ反映する。HAB host の `recipient_absent` は、ADR-032 が定める対象セッション宛ての署名付き呼び鈴への `410 session_gone` 応答を数えて決める。PR-2 ではその検出・応答を追加しない。
- [ ] 運用者が daemon を準備し、ソケットと対象の会話を確認してからキュー経路を有効にする。notifier の役割は設定済みのソケットへの接続に限る。WebSocket 経路からの切り替えと戻し方を接続手順に記載する。

**You see.**

- [ ] 新着で通知が表示され、既定では未読のまま待つ。「対応する」を選ぶと、Codex の試験用の会話に依頼が入り、通知記録に `queued` が残る。Codex 側では同じ会話の turn が始まったことを確認できる。

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] 偽の `codex` コマンドで引数と呼び出し回数を確認する。表示と再表示、承認前、既読処理に失敗したときは起動しない。手動承認と、ルールに一致する自動受付では、承認済みの文面と対象の会話を 1 回だけ渡す。ルール外の送信元・種類は手動の選択を待つ。二重操作と再起動でも再実行しない。
- [ ] キュー受付、明確な会話不在、結果不明の異常終了と時間切れを試し、それぞれ `queued`、`unsupported`、`unknown` になることを確認する。別経路への再送や `410 session_gone` は発生しない。
- [ ] 既存の `app_server` 設定と保存済みの通知記録で WebSocket 経路を選べる。経路なしでは表示だけ、両方指定では設定エラーになる。キューのソケットや対象会話が異なる設定では、元の通知記録の流用を拒む。Run `node --test test/agent-notify-codex-queue.test.js test/agent-notify-auto-accept.test.js test/hab-notify-cli.test.js`。
- [ ] 全体の `npm test` と設計台帳の監査を通す。

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `Mac mini の Claude Code（swarm なし）` at the PR head, per the boot recipe.

- [ ] Lane 1. 既存の WebSocket を設定した試験用の会話で、trunk と head の「対応する」後の引き渡し結果を比較する。Save `pr2-lane1-websocket.png`. Pass when 既存の設定と経路が head でも動く。
- [ ] Lane 2. 作業中のローカル会話向けに「対応する」を選ぶ。Save `pr2-lane2-busy.png`. Pass when 進行中の作業が続き、区切りで同じ会話に引き渡される。
- [ ] Lane 3. 自動受付を設定せずに試験メールを送り、通知を出し直す。Save `pr2-lane3-unread.png`. Pass when 通知を確認でき、既読・キュー受付・新しい turn が発生しない。
- [ ] Lane 4. ADR-023 の対象外の送信元または種類の試験メールを送る。Save `pr2-lane4-no-approval.png`. Pass when 通知が未読のまま利用者の選択を待つ。
- [ ] Lane 5. ADR-023 のルールに一致する試験メールを送る。Save `pr2-lane5-auto-accept.png`. Pass when ルールによる選択と結果が監査に残り、同じ会話に 1 回だけ届く。
- [ ] Lane 6. 待機中の会話で「対応する」を選ぶ。Save `pr2-lane6-accept.png`. Pass when 既読の後に `queued` が記録され、同じ会話に承認済みの依頼で turn が始まる。
- [ ] Lane 7. 設定済みの試験用の会話を消し、「対応する」を選ぶ。Save `pr2-lane7-missing-thread.png`. Pass when 確実な受付拒否なら `unsupported`、受付結果を判定できなければ `unknown` になり、再送されず、host の相手不在の状態は変わらない。
- [ ] Lane 8. キューの daemon と通信できない状態で「対応する」を選ぶ。Save `pr2-lane8-no-daemon.png`. Pass when `unknown` が記録され、自動で daemon を起動せず、次の確認でも再送しない。
- [ ] Lane 9. Codex アプリと notifier を再起動する。Save `pr2-lane9-app-restart.png`. Pass when 以前の承認分を再投入せず、新たに承認した分は同じ会話に届く。
- [ ] Lane 10. 試験メールを 3 通送り、各 1 回選ぶ。1 通は承認の操作を繰り返す。Save `pr2-lane10-burst.png`. Pass when 各依頼が 1 回ずつ同じ会話に届く。

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. 待機中の会話で、承認からキュー受付までと、承認から実際の turn 開始までをそれぞれ測る。
- [ ] Probe. 1 分おきに 5 通を送り、各試験の承認、キュー受付、実際の turn 開始の時刻を記録する。
- [ ] Baseline. trunk の WebSocket 経路が使える比較用の会話では同じ手順で承認から turn 開始までを測る。ローカルのアプリ会話で trunk の経路が使えない場合は、その接続条件を記録する。
- [ ] Rule. 待機中の会話で turn 開始までの中央値は 30 秒以内、最長は 60 秒以内。個々の CLI 呼び出しは 20 秒で打ち切る。作業中の会話は lane 2 で確認する。

**Review gate.** The operator reviews before merge.

- [ ] lane 3、lane 5、lane 6 の screenshot（画面写真）を `docs/history/media/pr2-review-<slug>.png` に写す。
- [ ] lane の Mac mini で、手動の承認から同じ会話の turn 開始が分かる 30 秒から 60 秒の video（動画）を撮り、`docs/history/media/pr2-review.mp4` に置く。
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

**Q1. Muse を外から起こす口はあるか。** 公開情報で確認できた自動実行は予定タスク。第三者の試験では最短 1 分、30 秒は受け付けなかった（[SmartScope](https://smartscope.blog/en/blog/claude-code-delegate-tasks-meta-muse-using-spreadsheets-2026/)、[dev.to](https://dev.to/ying_liao_0a481102ff971b4/automating-real-work-with-muse-connectors-scheduled-tasks-58co)）。Webhook、メールの到着、MCP のイベントで動く記述はない。nenwa も Muse を起こせない相手として扱う（[nenwa DESIGN.md](https://github.com/nogu66/nenwa/blob/b9b87731da65b3f62876c0797e88d53a342eddb3/DESIGN.md)）。2026-11-20 には予定タスクが自動で `hab_inbox` と `hab_reply` まで進んだ。未確認なのは Muse 自身の答え（M-1）だけで、本人が Muse のチャットで 1 問聞く。

**Q2. `codex queue` は Codex アプリの会話に届くか。** ローカルの会話には届く（2026-11-21 14:49 JST、Mac mini で合格）。調べた順に書く。

- `codex` は 2 つある。`~/.local/bin/codex` が 0.149.0、ChatGPT アプリ同梱の `/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex` が 0.171.0-alpha.13。`--resume` は 0.171 だけにある。
- `codex queue` の接続先は daemon の制御ソケット `~/.codex/app-server-control/app-server-control.sock` で、`thread/queue/add` を送る。存在しないスレッドへの試し送り（`--remote unix://`）は、両方の版でソケットがないと言って exit 1 で終わった。会話には何も入っていない。
- アプリの app-server は ChatGPT アプリの子プロセスで、`--listen` がなく stdio だけで動いている。TCP の待ち受けも名前付きのソケットもない。daemon は動いていない。
- アプリと CLI の会話は同じ `~/.codex`（`sessions/`、`queue_1.sqlite`、`state_5.sqlite`）に入っている。バイナリには `queued_items` の表と、変わったことを知らせる revision の仕組みがある。
- ここから推測できること（未確認）。daemon を起動すれば queue は共有の `queue_1.sqlite` に積まれ、アプリの app-server が revision でそれを拾って会話に流す可能性がある。版の差（daemon 0.149 とアプリ 0.171）で弾かれる可能性もあるので、試すときは同梱の 0.171 を使う。
- 本人の了承（14:12 JST）のあと試した。同梱の 0.171 で `codex app-server daemon start`（exit 0、`~/.codex/packages/app-server-daemon` に 439MB を導入、制御ソケットができた）、`codex queue --thread 01a1fc9c-… --message "HAB の試験です。『受け取りました』とだけ答えてください。"` を 14:49:05 に送った（exit 0、`Queued message …`）。
- 結果。アプリの待機中の会話 hab-probe で 14:49:10 に turn が始まり、14:49:12 に Codex が「受け取りました」と答えた。送信から 7 秒で、人の操作はない。`--resume` は要らなかった。会話の記録を開いていたのはアプリの app-server で、daemon ではない。daemon は queue の受け口で、実行はアプリ側がしたと見ている（推測）。
- 後片付け。`daemon stop` で止め、ソケットが消えたこと、アプリの app-server が動き続けていることを確かめた。導入物 439MB は残っている。
- 最初の試しは Mac mini の内蔵ディスクの空き不足（約 330MB）で daemon の導入に失敗した。本人が古い HAB リリースを整理してから再試行した。
- 届かないもの。ChatGPT のプロジェクト内の会話は `~/.codex/sqlite/codex.db` に一覧があるだけで（source_kind=chatgpt）、中身はクラウドにある。`codex queue` の対象外（Q4）。

**Q4. ChatGPT のプロジェクト内の会話を起こせるか。** 未確認。本人の要望（14:38 JST）。ChatGPT のチャットはすでに HAB アプリにつながっていて（`whoami` で `stallone@dot.hab`）、Dots は MCP イベントの呼び鈴とイベントタスクで起きている（2026-11-21 0:22 JST に返信まで確認）。調べることは、イベントタスクを特定のプロジェクトの会話に結び付けられるか、プロジェクト内の Codex（クラウド）にも同じ口があるか。結果で PR-3 を足すか決める。

**Q3. Codex の hooks で起こせるか。** 起こせない。`~/.codex/hooks.json` の `Stop` や `PostToolUse` は会話が動いているときだけ走るので、待機中の会話は起きない（[Codex hooks](https://learn.chatgpt.com/docs/hooks)）。補助として使う余地はあるが、この計画には入れない。

## Appendix B. Alternatives rejected

- **ローカルのアプリ会話に既存の WebSocket 経路を使う。** Q2 で観測したアプリの app-server は stdio で動いていた。WebSocket を提供する既存環境は従来の設定を使い、ローカルのアプリ会話向けにキューを選べるようにする。
- **`thread/inject_items` で本文を入れる。** 承認していない本文がモデルの履歴に入る（ADR-021 で退けた）。
- **notifier が自分で app-server か `codex exec` を起動する。** 利用者が見ている会話の外で動く。
- **Codex の hooks を主にする。** 待機中の会話を起こせない（Q3）。
- **Muse の間隔を 1 分に縮める。** 起こす口がない問題は変わらず、Muse の利用枠を多く使う。本人が望んだときだけ変える。
- **呼び鈴をアドレスごとでなく製品ごとにまとめる（PR-6）。** 本人の判断で後回し。この計画は今のアドレスごとの呼び鈴のまま進める。

## Appendix C. Risks

- **C-1. daemon とアプリの app-server が同じ `~/.codex` を同時に書く（PR-2）。** `thread-writer-locks/` があるので排他はあると見ているが未確認。持ち主は lane 9 と lane 10 で会話の記録が壊れないかを見る。
- **C-2. daemon の準備（PR-2）。** Q2 では送る間だけ daemon を起動して届いた。起動・常駐・停止は運用者の作業として接続手順に記録する。Mac mini の設定変更は本人が承認した導入時に行う。
- **C-6. 内蔵ディスクの空き（PR-2）。** daemon の導入に 439MB 要り、空き不足で一度失敗した。doctor と `hab:admin status` で空きの少なさを知らせるかを検討する。
- **C-3. 版の差（PR-2）。** `~/.local/bin/codex` は 0.149 で `--resume` がない。`codex_bin` はアプリ同梱の版を指す。アプリの更新で道筋が変わったら notifier の起動時に知らせる。
- **C-4. swarm を使わない（全 PR）。** 実機が Mac mini 1 台で、Codex アプリも 1 つなので、10 lanes は持ち主が順に回す。並列の検証はできない。
- **C-5. キュー受付と turn 開始には時間差がある（PR-2）。** `queued` は CLI の受付結果で、セッションでの処理開始は試験で別に観測する。作業中やアプリ再起動後も別の経路へ自動で送り直さない。

## Appendix D. Links and reading list

- 読むもの。`docs/hab-decisions.md`（ADR-015、ADR-021、ADR-022、ADR-023、ADR-032）、`docs/receiver/arrival-notifier.md`、`src/agent-notify/notifier.ts`（`check()` と `#finishAccept`）、`src/agent-notify/codex.ts`。
- 外部の資料。[openai/codex PR #39092](https://github.com/openai/codex/pull/39092)、[Developer commands](https://learn.chatgpt.com/docs/developer-commands)、[nenwa daemon.rs](https://github.com/nogu66/nenwa/blob/b9b87731da65b3f62876c0797e88d53a342eddb3/src/daemon.rs#L400-L425)。
- PR-2 は着手前に `pstack/skills/how/SKILL.md` を通す。
- 判断の記録はこの付録とスレッドに残す。commit はしない。
