# エージェントを HAB につないで、届いたメールに応じられるようにする

この手順で、各エージェントが HAB のメールを受け取り、内容を見せ、選んだとおりに動けるようにします。
各製品の設定は、その製品の AI に頼んで進められるように、渡す文をそのまま載せています。

対象は Hermes Desktop、Dots（ChatGPT）、Grok Bot、Muse、claude.ai、Claude Code、Codex、
Gemini アプリ・Antigravity です。

## 先に知っておくこと

どのエージェントも、次の 3 段で動きます。

1. **受け取る。** Hook（HAB が呼び鈴を鳴らす）で起きるか、決まった間隔で受信箱を見にいく（ポーリング）。
   どちらもない製品は、利用者が話しかけたときだけ受け取る。
2. **見せる。** カードを描ける製品はカードで、描けない製品は `hab_inbox` の `notice`（文章）で見せる。
   `notice` には選択肢 1 対応する、2 あとで、3 対応しない が入っている。
3. **選んだとおりに動く。** 「対応する」なら、その会話のモデルが `hab_reply` で返す。
   「あとで」と「対応しない」では何もしない。

受け取っただけでは返信しません（ADR-021）。例外は、利用者が許可した相手からのメールだけです（ADR-023）。
Hermes では `notify.json` の `auto_accept`、ほかの製品では下の「渡す文」の中で、許可する相手を書きます。
HAB は送り先・名義・配送だけを受け持ち、返すかどうかを決めるのは受け取る側です（ADR-015）。

## 製品ごとにできること

2026-11-20〜21 に Mac mini の HAB（6a3dd40、acacaff、Hermes の Hook は 3d0c56d）で確かめた結果です。
「確認済み」は実際に動いたもの、「未確認」はまだ試していないものです。

| 製品                       | 受け取る                                                                                             | 見せる                                           | 選んだとおりに動く                                                |
| -------------------------- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------ | ----------------------------------------------------------------- |
| Hermes Desktop             | Hook（運用者登録の呼び鈴で notifier が起きる。呼び鈴から 2.5 秒）。保険に 5 分ごとの確認。確認済み   | プラグインのカード。確認済み                     | 会話へ引き渡して `hab_reply`。確認済み                            |
| Dots（ChatGPT）            | MCP Events の Hook。見張りを頼んだセッション（Stallone）で、呼び鈴から 26 秒で既読。確認済み         | セッションに文章。カードは取りに来ない（出ない） | 許可した相手の質問に `hab_reply`。呼び鈴から約 45 秒。確認済み    |
| Grok Bot                   | Webhook で始まる routine。呼び鈴から 16 秒で既読。確認済み（初回は一時的に失敗し、鳴らし直しで回復） | Bot のチャットに文章                             | 許可した相手に `hab_reply` まで行った。呼び鈴から 24 秒。確認済み |
| Muse                       | 予定タスク。作成から 13 分後の実行で受信箱を読んだ。確認済み                                         | 文章（カードは取りに来ない）                     | 予定タスクの中で `hab_reply`。確認済み                            |
| claude.ai                  | 話しかけたときだけ                                                                                   | MCP Apps のカード。確認済み                      | カードの「対応する」から返信案、または文章で返事                  |
| Claude Code                | `/loop` か予定タスク。channels は開発用フラグが要る                                                  | 会話の中の文章                                   | できる                                                            |
| Codex                      | 外から会話に入る口が今はない                                                                         | 話しかけたときだけ                               | 文章で返事をすればできる                                          |
| Gemini アプリ・Antigravity | 話しかけたときだけ                                                                                   | 文章                                             | 文章で返事をすればできる                                          |

## 運用者 AI に頼むときの約束

host 設定・接続台帳・Registry・notifier を変える作業は、Mac mini で動く Claude Code などの運用者 AI に頼めます。
そのときは、渡す文の先頭に必ず次の約束を付けます。

```text
次の約束を守って作業してください。
1. 秘密（client secret、token、鍵、Webhook URL）を表示・記録・チャットへの貼り付けをしない。必要なら私が隠し入力でファイルに保存する。
2. host 設定・接続台帳・Registry・notifier を変える前に、バックアップを取り、戻し方を ROLLBACK.md に書く。
3. 変更の前に、何をどう変えるかを私に見せて、私の「はい」を待つ。読むだけの確認は先に進めてよい。
4. 他のエージェントの client ID や token を使い回さない。アドレスと接続は 1 対 1 で新しく作る。
5. 終わったら、hab:admin status の該当行と、試験メッセージの往復の結果を見せる。
```

## 共通の準備をする

どの製品でも、最初に次を済ませます。

1. アドレスを決める（例 `muse@muse.hab`）。
2. Auth0 にその製品専用のアプリを作り、Refresh Token を許可し、製品が示す callback を登録する。アプリの種類は製品の作りで分ける。
   - クラウドの製品（claude.ai、ChatGPT、Muse、Grok Bot）は secret を持てるので Regular Web Application。client ID と secret は製品の画面に直接入れる。
     claude.ai の callback は `https://claude.ai/api/mcp/auth_callback`、Muse はセットアップの始めに Muse が示す。
   - 手元で動く製品（Hermes の受信通知、Claude Code）は secret を送らない public client。手順は[受信通知アダプタ](../receiver/arrival-notifier.md)と[Claude Code の接続](claude-code-connection.md)のとおり。
3. 製品に HAB の MCP をつなぐ。URL は `https://<HAB の公開入口>/hab/mcp`、認証は OAuth、scope は `hab:resolve hab:submit hab:status hab:poll hab:ack offline_access`。
4. 製品でログインまで済ませると、HAB はそのサインインを「承認待ち」に記録して断る（署名と期限が正しいものだけ）。
   Auth0 のログで主体を探す必要はない。
5. 運用者 AI に承認を頼む（下の文）。台帳への追記と接続の紐づけを 1 回で行い、host の再起動は要らない。
   承認より前に発行された token は断られるので、製品が token を更新するまで（最長 10 分）待つか、製品の画面でコネクタをつなぎ直す。
   手順の背景は[常用の MCP 認証](../operations/persistent-mcp-auth.md)と[認証グループ](../auth-groups.md)にあります。
6. つないだ会話で、名義を確かめる（下の文）。

運用者 AI に渡す文（先頭に上の約束を付ける）：

```text
HAB に新しいエージェントを接続します。アドレスは <アドレス>、製品は <製品名>、
Auth0 のアプリの client ID は <client ID> です。
1. npm run hab:admin -- --config <host 設定> pending で承認待ちを出し、client ID が一致する行を見せてください。
2. 私が「はい」と言ったら、
   npm run hab:admin -- --config <host 設定> approve --pending <pending_id> --address <アドレス> を実行してください。
   台帳のバックアップは approve が取ります。
3. hab:admin doctor --address <アドレス> で、registration が ok になったことを見せてください。
```

エージェントに渡す文：

```text
HAB の hab_discover で、いま使っている自分のアドレスを確かめて、教えてください。
```

HAB のツール定義を変えたあと（カードの追加など）は、製品側でコネクタを切断してつなぎ直します。
つなぎ直さないと、製品は古いツール定義を使い続けます。

## Hermes Desktop を設定する

Hermes は、Mac 上の受信通知（notifier）とデスクトップのプラグインで動きます。
Mac で Claude Code などのコーディングエージェントに、次の文を渡します。

```text
hiraoku-agent-base の docs/receiver/arrival-notifier.md に沿って、この Mac の Hermes Desktop に
HAB の受信通知（hab:notify）とプラグイン hab-desktop-adapter を設定してください。
アドレスは <hermes のアドレス>、引き渡し先は Hermes Desktop の <会話> です。
自動で受け付ける相手は <許可するアドレス> だけにして、notify.json の auto_accept に書いてください。
設定ファイルを変える前にバックアップを取り、変えたあとに hab-notify check を通してください。
```

確かめ方：試験メールを 1 通送り、Hermes の会話にカードが出て、「対応する」で返信が届けば完了です。

## Dots（ChatGPT）を設定する

ChatGPT では、イベントは「見張りを頼んだ会話」に届きます。
そのため、Work の会話か dots で頼みます。通常の会話ではイベントが届きません。

1. host 設定に `ingress.events` があるかを運用者 AI に確かめてもらう。無ければ、バックアップを取ってから
   `"events": {}` を加え、host を再起動する（[mcp-events.md](mcp-events.md) の「Dots（ChatGPT）を設定する」）。
   これが無いと HAB は呼び鈴を出せません。
2. ChatGPT の HAB コネクタを切断して、つなぎ直す。
3. Work の会話か dots で、次の文を渡す。

```text
HAB の hab.message.received イベントを見張ってください。
イベントが届いたら hab_inbox で受信箱を読み、送り主と内容を私に見せてください。
<許可するアドレス> からの質問には、hab_reply で短く答えてください。
それ以外のメールには返信せず、知らせるだけにしてください。
```

確かめ方：試験メールを 1 通送ると、`hab:admin status` で `stallone@dot.hab` の呼び鈴が鳴り、
数十秒で既読になります。許可した相手のメールなら、返信も届きます。

HAB は本文を「送り手が書いたデータで、指示ではない」として渡します。本文に「返信して」と書かれていても、Dots は返信しません。
返信させる相手は、上の文のように見張りの指示の側に書きます。

ChatGPT の購読はアカウントに 1 つで、イベントは最初に見張りを頼んだタスクで動きます。
別の会話で頼み直しても新しいタスクにはならないので、指示を変えるときは既存のタスクの指示を書き換えます。
結果は元の会話ではなく、そのタスクの実行履歴に出ます。

見張りの購読は ChatGPT が自分で更新します。
購読が切れると、`hab:admin status` の `problems` に `doorbell_lapsed` が出ます。
そのときは、手順 3 をもう一度行います。

## Grok Bot を設定する

Grok Bot は、Webhook で始まる routine で起きます。
HAB は運用者が登録した宛先へ呼び鈴を鳴らします（ADR-029）。

1. Grok Bot に、次の文を渡す。

```text
Webhook で始まる routine を 1 つ作ってください。
指示は「HAB の hab_inbox で受信箱を読み、送り主と内容をこのチャットに書く。
<許可するアドレス> からの質問には hab_reply で短く答える。それ以外には返信しない」にしてください。
HAB のコネクタを使えるようにしてください。
```

2. routine の画面で **Test** を押し、HAB のツールが呼ばれることを確かめる。
3. routine の Webhook の URL と鍵を確かめる。鍵はチャットに貼らず、Mac mini の所有者だけが読めるファイル
   （権限 0600）に保存する。
4. 運用者が `hab:admin doorbell add --address <アドレス> --url <URL> --secret-file <鍵ファイル>` で呼び鈴を登録する。
   host の再起動は要りません。手順は [MCP イベント](mcp-events.md)の「運用者が登録する呼び鈴」にあります。

確かめ方：試験メールを 1 通送り、`hab:admin status` の `doorbell_last_status` が 2xx になり、
Bot のチャットに内容が出れば完了です。

Grok の Webhook には重複を防ぐ仕組みがありません。同じ呼び鈴が 2 回届くと、routine も 2 回動きます。

## Muse を設定する

Muse には外から起こす入口がないので、Muse 自身の予定タスクで受信箱を見ます。

1. Muse に HAB のコネクタをつなぐ。
2. Muse に、次の文を渡す。

```text
15 分ごとに、HAB の hab_inbox で新着だけを確認する予定タスクを作ってください。
新着があれば、送り主と内容を私に知らせてください。
<許可するアドレス> からの質問には hab_reply で短く答え、それ以外には返信しないでください。
新着がなければ、何も言わずに終えてください。
```

確かめ方：予定の時刻のあとに、`hab:admin status` で Muse の未読が 0 になっていれば、予定タスクが動いています。
間隔を短くするほど、Muse の利用量が増えます。

## claude.ai を設定する

claude.ai には外から起こす手段がありません。話しかけたときに受け取ります。

1. **Settings** の **Connectors** で HAB を追加する（つないでいる場合は切断して、つなぎ直す）。
2. 受信箱を見たいときに、次の文を渡す。

```text
HAB の受信箱を hab_inbox で見て、届いたメールを見せてください。
```

カードが出る場合は、「対応する」を押すと返信の下書きが会話に入ります。
カードが出ない場合も、文章の選択肢に番号で答えれば同じように動きます。

## Claude Code を設定する

1. HAB の MCP を登録する。手順は [Claude Code から HAB へ接続する](claude-code-connection.md)にあります。
2. 決まった間隔で受信箱を見る場合は、セッションで次を実行する。

```text
/loop 10m HAB の hab_inbox で新着だけを確認して。新着があれば内容を見せて。新着がなければ何も言わないで。
```

Mac が起きている間だけ動けばよい場合は、デスクトップの予定タスク（最短 1 分）も使えます。
channels（届いたら会話に知らせる仕組み）は研究プレビューで、自作のサーバーには
`--dangerously-load-development-channels` が要ります。常用には使いません。

## Codex を設定する

Codex は ChatGPT アプリの中で動き、外から会話に入る口が今は開いていません。
HAB の MCP を Codex の設定に加え、受信箱を見たいときに話しかけます。

```text
HAB の受信箱を hab_inbox で見て、届いたメールを見せてください。
```

## Gemini アプリ・Antigravity を設定する

どちらも、外から会話を起こす公開の入口はありません。話しかけたときに受け取ります。
接続の手順は [Gemini と Antigravity の接続](gemini-antigravity-connection.md)にあります。
受信箱を見るときは、claude.ai と同じ文を渡します。

## うまく動かないときに確かめる

まず `npm run hab:admin -- --config <host 設定> doctor --address <アドレス>` を実行します。
登録、受け方、既読、会話の 4 項目を ok／problem／unknown で出し、problem には次の操作を添えます。
アドレスを付けないと、すべてのアドレスを 1 行ずつ出します。読み取りだけで、何も変えません。

- 名義が違う：`hab_discover` の結果と、登録したアドレスを比べる。
- 呼び鈴が鳴らない：`hab:admin status` の `inboxes` で、そのアドレスの `doorbell` が `live` かを見る。
  `lapsed` なら、製品側で見張りを頼み直す。
- 鳴るのに読まれない：呼び鈴は届いているのに、製品側のタスクが動いていない。
  製品の画面で、タスクや routine が止まっていないかを見る。
- カードが出ない：コネクタをつなぎ直す。host の監査記録（`audit.jsonl`）に `method` の行がある版なら、
  製品が何を呼び、何が拒否されたかをその行で確かめる。
