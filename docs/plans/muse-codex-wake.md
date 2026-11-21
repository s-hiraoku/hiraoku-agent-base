# Muse と Codex を自動で受け取れるようにする（設計と実機確認の手順）

2026-11-21。状態：設計。実機確認の前で、コードの変更はまだない。

## 1. 目的と結論

Muse（`muse@muse.hab`）と Codex を、利用者が話しかけなくても新着を受け取れるようにする。
本人の方針（2026-11-20）は「受信は Hook が主、Hook を実装できない製品は polling（間隔は製品ごと）」。

| 製品  | 結論（案）                                                                                                 | 確定に要る実機確認 |
| ----- | ---------------------------------------------------------------------------------------------------------- | ------------------ |
| Muse  | **polling のまま確定する。** 外から Muse を起こす公開の口がない。台帳の `muse=poll 15分` を正式な受け方とする。 | M-1 の 1 問だけ    |
| Codex | **Hook にする。** 受信側の notifier が呼び鈴を受けたら `codex queue --thread` で決まった一文を会話に入れる。      | C-1〜C-5           |

HAB の境界（ADR-015「HAB から押し出さない」、ADR-022/029 の中身なしの呼び鈴）は変えない。
Codex を起こすのは受信側の notifier で、HAB は今の運用者呼び鈴（`127.0.0.1` 宛て）を鳴らすだけ。

## 2. Muse

### 2.1 調べたこと

- Muse の自動実行は「予定タスク（繰り返し）」だけ。公式ヘルプは毎日・毎週・任意間隔の繰り返しを案内し、メールやメッセージの到着、Webhook で動く仕組みは書いていない。
  第三者の試験では最短 1 分の間隔が設定でき、30 秒は受け付けなかった。
  [SmartScope（2026-10-27）](https://smartscope.blog/en/blog/claude-code-delegate-tasks-meta-muse-using-spreadsheets-2026/) ·
  [dev.to: Connectors + Scheduled Tasks](https://dev.to/ying_liao_0a481102ff971b4/automating-real-work-with-muse-connectors-scheduled-tasks-58co)
- SmartScope の「wake-on-change」は Muse の機能ではなく、作者が 60 秒ごとの確認で組んだやり方。中身は polling。
- WhatsApp は Muse と話す画面の一つで、外から作業を始める入口ではない。MCP の通知やイベント（ChatGPT の MCP Events にあたるもの）を Muse が受ける資料は見つからない。
- nenwa も Muse を「押し込めない相手」として受信箱に置き、Muse 自身が `check_inbox` を呼ぶ形にしている。
  [nenwa DESIGN.md](https://github.com/nogu66/nenwa/blob/b9b87731da65b3f62876c0797e88d53a342eddb3/DESIGN.md)
- 実機では 2026-11-20 に予定タスクが自動で `hab_inbox` を呼び、`hab_reply` まで返した（受信と返信は確認済み）。

### 2.2 決めること

- 受け方は `poll` のまま。Hook の実装はしない。
- 間隔は今の 15 分を既定とする。短くすると Muse の利用枠を多く使うので、縮めるのは本人の希望があるときだけ（最短 1 分）。
- 止まったときは PR-5 の `poll_overdue`（間隔の 2 倍で警告）で気づく。

### 2.3 実機確認

- **M-1（本人が Muse のチャットで 1 問聞くだけ。接続や設定はしない）。**
  「外部のサービスから、あなたのタスクをすぐ始めさせる方法はありますか。Webhook の URL、メールの宛先、コネクタからのイベントなど。予定タスク以外で」。
  - 「ない」なら 2.2 で確定。
  - 「ある」と答えたら、その方式の名前と設定画面を聞いて、この文書に追記してから改めて設計する（その場では作らせない）。

## 3. Codex

### 3.1 調べたこと

- **`codex queue`。** 既存のセッションに文を入れるコマンドが Codex に入った（openai/codex PR #39092、2026-08-17 マージ）。
  `codex queue --thread <UUID か正確なセッション名> --message <文>` で、app-server の `thread/queue/add` に渡す。
  文字だけ（画像は不可）。名前が重なると拒否。v0.166 で、読み込まれていないスレッドを再開させる `--resume` が付いた（実行中のローカル daemon か `--remote` のサーバーが要る）。
  作業中のスレッドには区切りの良いところで入り、待機中のスレッドがすぐ作業を始めるかは資料に書いていない。
  [PR #39092](https://github.com/openai/codex/pull/39092) ·
  [v0.166 の解説](https://dev.to/aicoding-guide/codex-cli-v0166-adds-codex-queue-resume-and-codex-doctor-network-only-5ae0) ·
  [Developer commands](https://learn.chatgpt.com/docs/developer-commands)
- nenwa は Codex への配達にこれを使い、20 秒で打ち切る。待機中でも作業中でも会話に入る（待機中ならそこで動き出す）と書いている。失敗したら Codex の hooks で受け渡す。
  [nenwa daemon.rs](https://github.com/nogu66/nenwa/blob/b9b87731da65b3f62876c0797e88d53a342eddb3/src/daemon.rs#L400-L425)
- **Codex の hooks。** `~/.codex/hooks.json`（または `config.toml` の `[hooks]`）に `SessionStart`・`PostToolUse`・`Stop` などを書ける。`Stop` で `decision: "block"` を返すと続けて作業する。
  利用者が信頼するまで動かない。デスクトップアプリにも「Review hooks」「Settings > Hooks」がある。
  [Codex hooks](https://learn.chatgpt.com/docs/hooks)
  hooks は会話が動いているときにしか走らないので、待機中の会話を起こす手段にはならない。補助にとどめる。
- 2026-11-20 の確認では、Codex アプリ内の app-server は stdio だけで外から入れず、`codex app-server daemon version` も失敗した。
  今の `src/agent-notify/codex.ts` は WebSocket で app-server に入り `thread/resume`→`turn/start` する作りなので、アプリの会話には届かない。

### 3.2 仕組み（案）

```
送信者 ─ hab_send ─▶ HAB host ─ 運用者呼び鈴（127.0.0.1, whsec_ 署名）─▶ notifier
                                                                        │ codex の受信アドレス宛てに未読があれば
                                                                        ▼
                                       codex queue --thread <台帳の thread> --message <決まった一文>
                                                                        │
                                                                        ▼
                                       Codex の会話が動き、自分の HAB MCP で hab_inbox → 見せる → hab_reply
```

- 入れる文は**決まった一文だけ**にする。例：「HAB に新着があります。hab_inbox を呼んで、届いたメールを notice のとおり見せてください。」
  送信者の本文は入れない。本文は Codex が `hab_inbox` で受け取り、`notice` の「送信者が書いたデータ」の枠のまま見せる。
  これで、承認していない本文がモデルの履歴に入らない（ADR-021 で `thread/inject_items` を退けた理由と同じ）。
- **起こす道と引き渡しの道は分ける。** 今の notifier では、呼び鈴は `notifier.check()` を動かして画面の `show()` を呼ぶだけで、`codexHandoff` は「対応する」か `auto_accept` のあとにしか走らない。しかも `#finishAccept` は引き渡しの前に既読にする。
  そのため、起こす一文は **`show()` の側（届いた時点、未読のまま）** で `codex queue` を呼ぶ。メッセージは未読のまま残るので、Codex の既定の `hab_inbox`（未読だけ）で読める。
  「対応する」後の今の引き渡し（既読にしてから、承認済みの本文を `handoff_prompt` で渡す）はそのまま残し、送り方だけを WebSocket から `codex queue` に替える。
- 会話の特定は台帳（Registry、ADR の「アドレスとセッションは 1 対 1」）に Codex の thread（UUID）を書く。セッション名は重なると拒否されるので使わない。
- `codex queue` が失敗した（終了コードが 0 でない、20 秒を超えた）ら、その回は `unknown` とし、再送しない（今の notifier の約束と同じ）。保険は今の確認間隔（5 分）。
- `codex queue` がスレッドを見つけられない（スレッドがない）と言ったら、PR-7 の `recipient_absent`（相手のセッションがいない）として扱う。
- hooks は**任意の補助**とする。`Stop` で未読があれば `hab_inbox` を促す。会話が動いている最中に届いた分を取りこぼさないため。C-4 の結果を見てから入れるか決める。

### 3.3 実機確認（C-1〜C-5）

実機作業は本人がスレッドに直接書いた了承のあとに行う。Codex がある Mac（Mac mini か手元の Mac か）は本人に確認する。
どの段も Codex の設定ファイルを変えるときは事前にバックアップを取る。

- **C-1 版と口の確認（読むだけ）。** `codex --version`、`codex queue --help`、`codex app-server daemon --help`。
  Pass：`queue` があり、`--thread`・`--message` を受ける。`--resume` の有無を記録する。
- **C-2 アプリの会話に届くか（核心）。** Codex アプリで試験用の会話を 1 つ開き、`/status` で Session UUID を控える。
  その会話を待機状態にしたまま、ターミナルで `codex queue --thread <UUID> --message "試験です。『受け取りました』とだけ答えてください。"`。
  Pass：アプリの同じ会話に文が出て、Codex が答える。
  記録：終了コード、出力、アプリに出るまでの秒数、待機中に自動で動き出したか。
  - 届かない場合は、`codex app-server daemon start` を起動してからもう一度試す。daemon 経由でアプリの会話に届くかを記録する。
  - それでも届かない場合は、C-5 へ進んで「アプリの会話には外から入れない」と確定する。
- **C-3 作業中の会話。** Codex に長めの作業（例：大きめのファイルの要約）をさせている最中に C-2 と同じ queue を送る。
  Pass：作業を壊さず、区切りで文が処理される。
- **C-4 HAB を通した往復。** Codex に HAB の MCP をつなぎ、その会話用のアドレス（例：`codex@codex.hab`）を台帳に登録する。
  手で `codex queue` を打つ代用はしない。4 章の実装を入れた notifier（試験用ブランチ）を使い、別のエージェントから試験メールを送る。
  Pass：呼び鈴→notifier の `show()`→`codex queue`→メッセージは未読のまま→Codex が `hab_inbox` で読む→`notice` を見せる→`hab_reply`→送信者に届く。所要秒数を記録する。
  C-4 は実装ブランチの上で行い、合格してからその PR をマージする。
- **C-5 だめだった場合の確定。** C-2 で daemon 経由でも届かなかったら、Codex の受け方は `on_request`（話しかけたときだけ）で確定し、`docs/connections/agent-setup.md` の Codex の節を「外から起こせない」と理由付きで書く。
  CLI（`codex` の TUI）で動く会話なら届く、という結果なら、「CLI の会話を受信用にする」案を本人に出す。

## 4. 実装（実機確認のあと）

C-2 が合格したら、次の 1 本の PR を作り、C-4 をそのブランチで確かめてからマージする。

1. `src/agent-notify/codex.ts`：起こす道として、画面の `show()`（届いた時点）で `codex queue --thread <id> --message <決まった一文>` を 20 秒で打ち切って呼ぶ。既読にはしない。コマンドは引数の配列で渡し、シェルを通さない。
   「対応する」後の `codexHandoff` は残し、WebSocket での `thread/resume`→`turn/start` を `codex queue`（承認済みの `handoff_prompt`）に替える。
2. `scripts/hab-notify.ts`：`codex` の設定から `app_server` を外し、`codex_bin`（既定 `codex`）と `thread_id` だけにする。
3. 台帳の受け方：Codex を `hook` にする（Muse は `poll` 15 分のまま）。
4. テスト：`test/` に、成功・失敗・時間切れ・スレッドなし（`recipient_absent`）・起こす一文に本文が入らないこと・起こしたあともメッセージが未読のままのこと・「対応する」後の引き渡しが今どおり動くことの件を足す。`npm test` を通す。
5. 文書：`docs/connections/agent-setup.md` の Codex の節と、verify-hab の機能マップ。

hooks の補助（3.2 の最後）は、C-4 で取りこぼしが見えたときだけ別の PR にする。

## 5. 本人に聞くこと

1. Codex を使っているのはどの Mac か（実機確認の場所）。
2. C-1〜C-4 を実機でやってよいか（Codex の設定に HAB の MCP と試験用アドレスを足す）。
3. Muse の M-1 を Muse のチャットで聞いてもらえるか。
