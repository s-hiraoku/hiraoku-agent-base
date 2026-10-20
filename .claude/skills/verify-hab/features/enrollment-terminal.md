# Enrollment terminal

A human operator registers a bot from a terminal: choose a product, propose a bot name, confirm the permanent `<bot>@<product>.hab` address, bind the verified connection, choose operations, and activate. Each confirmation requires typing the exact address. The demo uses a temporary DB and synthetic authority and deletes its data on exit.

## Sub-features

- `enroll-complete` the full flow ends with `模擬登録完了: <address> / active` and exit code 0.
- `enroll-abort` typing anything other than the exact address at a confirmation stops the flow (`模擬登録中断: <stage>`).
- `enroll-resume` (non-interactive) `--simulate` pauses after binding, reopens the DBs and completes activation.

## How to get to it (user POV)

- `npm run demo:hab-enrollment -- --interactive` in a real terminal (a TTY is required).
- `npm run demo:hab-enrollment -- --simulate` for the scripted pause/resume run.

## Driving it with verify-hab

Preconditions:

- Node ≥ 24 on PATH (`. $S/_node.sh`), `tmux` installed, repo root as cwd. No Relay stack is needed.

- **Start.** Run `T=hab-enroll-$$; tmux new-session -d -s "$T" -x 160 -y 50 "bash -c '. $S/_node.sh; node scripts/hab-enrollment-demo.mjs --interactive; echo DEMO_EXIT=\$?; sleep 60'"`. Helper to wait: `w(){ for i in $(seq 1 40); do tmux capture-pane -pt "$T" | grep -qF "$1" && return 0; sleep 0.25; done; echo "TIMEOUT $1"; return 1; }`.
- **Choose product.** `w '番号 / q'`, then pick grok-bot's number from the screen: `N=$(tmux capture-pane -pt "$T" | sed -n 's/^\([0-9]\)\. grok-bot$/\1/p'); tmux send-keys -t "$T" "$N" Enter`.
- **Bot name.** `w 'bot_name'`, then `tmux send-keys -t "$T" demo-a Enter`. The screen shows `demo-a@grok-bot.hab を確定します`.
- **Confirm reserve.** `tmux send-keys -t "$T" demo-a@grok-bot.hab Enter`. Screen shows `に検証済み接続「Synthetic local bot A」を結び付けます`.
- **Confirm bind.** `tmux send-keys -t "$T" demo-a@grok-bot.hab Enter`. The five operations are listed.
- **Choose operations.** `w 'カンマ区切り'`, then `tmux send-keys -t "$T" 1,2,3,4,5 Enter`. Screen shows `を有効化します。許可する操作: ack, poll, resolve, status, submit`.
- **Confirm activate.** `tmux send-keys -t "$T" demo-a@grok-bot.hab Enter`, then `w DEMO_EXIT`. Screen shows `模擬登録完了: demo-a@grok-bot.hab / active` and `DEMO_EXIT=0`.
- **Abort path.** Repeat, but answer `no` at the first confirmation. Screen shows `模擬登録中断: unconfirmed` and `DEMO_EXIT=0`; no address was activated.
- **Scripted resume.** Run `node scripts/hab-enrollment-demo.mjs --simulate; echo "exit=$?"`. Output contains `接続済み・送受信無効のまま中断し、DBを閉じて再開します。`, `再開後の模擬確認: activate research@grok-bot.hab`, `模擬登録完了: research@grok-bot.hab / active`, `exit=0`.
- **Proof.** Save `tmux capture-pane -pt "$T" -S - > "$RUN/evidence/enroll-<sub-feature>.txt"` before killing the session (`tmux kill-session -t "$T"`). Confirm no `hab-enrollment-demo-*` dir remains in `$TMPDIR` (or `/tmp`).

## Gotchas

- The product list order is not alphabetical and can differ between runs; read the number next to the product name instead of hard-coding `1`.
- Each prompt times out after 60 s idle and the flow then pauses; keep sends prompt-gated.
- Any confirmation input other than the exact address aborts; a stray trailing space aborts too.
- `--interactive` refuses without a TTY (`enrollment_demo_requires_terminal`); pipes or here-docs do not work, use tmux.
