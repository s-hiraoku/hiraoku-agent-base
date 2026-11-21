# 呼び鈴のセッション名で受信を振り分ける（設計案）

状態：**案**。2026-11-21 JST。前提は [ADR-032](../hab-decisions.md) と PR #259（呼び鈴の `data` に `{to, session, arrived_at}` を載せる）。不在の判定は #264 で採用した規則に従う。

## 何を決めるか

本人の方針（2026-11-20）は次のとおり。

- 会話は管理しない。アドレスとセッションは 1 対 1。
- 呼び鈴の購読は製品ごとに 1 つでよい。どのセッション宛てかは、通知の中で製品が判断する。
- アドレスに結び付いたセッションがなければ、「相手がいない」エラーにする。

PR #259 で、HAB は呼び鈴に台帳のセッション名 `session` を載せる。この文書では、**受け取る製品の側がその名前でどう振り分けるか**を決める。HAB 側の配送・台帳・購読は変えない。例外は、下の `hab:admin present` だけ。

## 結論

| 製品               | 呼び鈴を受けるもの             | 振り分け                                                                               | 今回の作業          |
| ------------------ | ------------------------------ | -------------------------------------------------------------------------------------- | ------------------- |
| Hermes Desktop     | notifier の受け口（127.0.0.1） | 1 つの process に、セッションごとの単位を最大 32 持つ。`to` と `session` で 1 つを選ぶ | 実装（下の Hermes） |
| Codex・Claude Code | 同じ notifier                  | 同じ。会話の有無を確認する口がないので、会話の終了は報告しない                         | Hermes と同じ実装   |
| Grok Bot           | xAI の Webhook（routine）      | routine 1 つがアドレス 1 つ。`session` は自分宛ての確認に使うだけ                      | 手順書の指示文だけ  |
| Dots（ChatGPT）    | MCP イベント（見張りの会話）   | 接続 1 つがアドレス 1 つ。イベントは見張りを頼んだ 1 つの会話でしか動かない            | 手順書の指示文だけ  |

Grok と Dots の側には、1 つの購読で複数のセッションを持つ仕組みがない。Grok の routine も ChatGPT の見張りも、1 つの会話・タスクに結び付く。呼び鈴への応答も製品のサーバーが返すので、`410` を返せない。

## Hermes：1 つの process で複数のセッションを受ける

### 今

- notifier は 1 つの設定（`notify.json`）で 1 つのセッションに結び付く。その 1 組は次の 3 つ。
  - 画面（`screen.session_id`）
  - 記録（`store`、`target` で照合）
  - 資格（`token`、`as_address`）
- 受け口（`wake`）は署名だけを確かめる。本文は読まずに「今すぐ確かめる」を鳴らし、いつも `200` を返す。
- Hermes の会話を 2 つ HAB につなぐには、notifier・ポート・呼び鈴を 2 組ずつ用意する。

### 設定

製品ごとのファイルを 1 つ足す。セッションは、ディレクトリに置いた今の `notify.json` 1 つずつにする。

```jsonc
// ~/.config/hab/hermes.product.json（新規。製品ごとに 1 つ）
{
  "wake": { "port": 8795, "secret_file": "~/.config/hab/hermes-wake.secret" },
  "sessions_dir": "~/.config/hab/hermes.d",
}
```

```text
~/.config/hab/hermes.d/
  hab.json        # 今の notify.json をここへ移す。as_address は必須、wake は書かない
  research.json   # 2 つ目の Hermes 会話。store・画面のファイル・資格は別
```

- **セッションの一覧はディレクトリそのもの。** 一覧を別に持つと、ファイルと食い違う。
- **セッション名は新しい項目にしない。** 製品がもう持っている会話の ID から決める。
  - Hermes と Claude Code は `screen.session_id`、Codex は `thread_id`。
  - 呼び鈴の `session`、画面の結び付き、`sessionProbe` に渡す ID が同じ 1 つの値になる。
  - 台帳には `npm run hab:admin -- --config <host-config> session --address <address> --session <session-id> --request-id <request-id>` で登録する。打つ行は `units` が表示する。
- **画面側のコマンドは変えない。** `events`・`action`・`statusline`・`decide`・`show` は今までどおり `--config <1 セッションの設定>` を読む。Hermes のプロファイルの reader・actions_command は、移したファイルを指すように直すだけでよい。

### 起動と確認

```sh
hab-notify --product ~/.config/hab/hermes.product.json run     # LaunchAgent はこれに替える
hab-notify --product ~/.config/hab/hermes.product.json units   # 受け持つセッションの一覧、会話がまだあるか、台帳に登録する行
```

`hab-notify --config x.json run` も同じ実行ループで動かす。既存の単体設定では `as_address` は引き続き省略でき、呼び鈴の応答とログの形式も従来どおり。

### 呼び鈴の答え方

受け口は運用者が登録した呼び鈴の署名を確かめたあと、本文を `answerRing` に渡す。この受け口では購読の検証チャレンジを使わない。`200 session_unconfirmed` の本文は `{"reason":"session_unconfirmed"}` で、HAB の不在判定も回数も変えない。

| 呼び鈴                                                                   | 答え                                                            | ログの理由          |
| ------------------------------------------------------------------------ | --------------------------------------------------------------- | ------------------- |
| `to` と `session` が一致し、会話の存在を確認できたか、probe の設定がない | `200`。そのセッションだけ起こす                                 | なし                |
| `to` は受け持つが、`session` がアドレスと同じ（仮の名前）                | `200 session_unconfirmed`。確認できればそのセッションだけ起こす | `provisional`       |
| `to` は受け持つが、`session` が別の名前                                  | `200 session_unconfirmed`。受信箱の確認を止める                 | `session_mismatch`  |
| `to` を受け持たない                                                      | `200 session_unconfirmed`                                       | `unknown_address`   |
| `to` と `session` が一致し、probe が `gone`                              | `410 session_gone`                                              | `conversation_gone` |
| 設定済みの probe が 1.5 秒で答えない、`unknown`、失敗                    | `200 session_unconfirmed`。受信箱の確認は保留                   | なし                |
| `session` がない（#259 より前の host）                                   | `200 session_unconfirmed`。`to` で選び、確認できれば起こす      | なし                |
| 本文が読めない                                                           | `400`（HAB は数えない）                                         | なし                |

- **仮の名前と旧形式でも、受信先が確かなら起こす。** 受け持つアドレスを選び、probe が `present` を返すか probe の設定がなく、以前の名前違いによる停止がない場合は、その単位を起こす。仮の名前や旧形式で来た呼び鈴からは、会話の終了を報告しない。
- **起動中や再起動中に `410` は出ない。** 受け口は、全セッションを読み込み終えてから開く。止めるときは最初に閉じる。閉じているあいだ HAB の側は接続できないだけで、HAB はこれを数えない（`#ring` が数えるのは `410` と `session_gone` の組だけ）。
- **2 重起動はポートで防ぐ。** 同じ製品の `run` は同じポートを取りに行くので、2 つ目は起動に失敗する。
- **会話の状態と名前違いを別々に確認する。** 本人の `hab_peek` は HAB の不在判定を解除する。probe を設定した単位は、最新の確認が `present` の場合だけ受信箱を読む。名前違いで止まった単位は、台帳を直してその会話 ID の呼び鈴が来るか、設定を直して再起動すると名前違いの停止が解ける。呼び鈴と定期確認は単位ごとに `refreshPresence` の実行中の確認を共有し、時間切れ後に届いた結果は使わない。HAB が `session_gone` を数える既定間隔は 60 秒。
- **HAB の待ち時間に収める。** HAB は 10 秒で諦める。`sessionProbe` は 1.5 秒で打ち切る。

### 中の作り

```ts
// src/agent-notify/product-host.ts（新規）
export interface SessionUnit {
  readonly address: Address | undefined; // 製品ファイルの単位では必須
  readonly label: string; // 会話の ID
  readonly exclusive: { store: string; screen: string; binding: string };
  readonly interval_ms: number;
  check(): Promise<string[]>; // 今の ReceiptNotifier.check()
  presence?(): Promise<"present" | "gone" | "unknown">; // probe を設定した製品だけ
  close(): void;
}
export class SessionTable {
  static of(units: readonly SessionUnit[]): SessionTable; // アドレス・名前・store・画面・結び付きの重複を拒む。1〜32
  route(ring: Ring): Route;
}
export function answerRing(
  table: SessionTable,
  body: string,
  wake: (u: SessionUnit) => void,
): Promise<"accepted" | "session_gone" | "session_unconfirmed" | "bad_request">;
export function runProduct(
  table: SessionTable,
  options: ProductRunOptions,
): Promise<void>;
```

- **セッションの単位は今の notifier のまま。** store・画面・`target`・HAB の接続を、単位ごとに 1 組ずつ持つ。1 つの store にセッションの列を足す形にはしない。足すと、ある会話の「対応する」が別の会話に渡りうる。
- **単位ごとにループを持つ。** 待ちも単位ごとに持ち、呼び鈴は自分の単位だけを起こす。1 つの会話の引き渡しが遅くても、資格が切れていても、ほかの会話は止まらない。単位どうしで共有して書き換える状態はないので、鍵は要らない。
- **重複の確かめは 1 か所。** `SessionTable.of` がアドレス・名前・`exclusive` の各値を確かめる。新しく独占させたい資源は、`exclusive` に 1 項目足すだけでよい。
- **製品ファイルの各セッションには `as_address` が必須。** HAB への問い合わせに `expected_agent_id` が付き、HAB が本人かを確かめる。単体設定で `as_address` を省くと、呼び鈴を起点に会話の終了を HAB に報告できない。
- **資格ファイルは process の中で 1 つに束ねる（`TokenPool`）。** 同じ `token.oauth.file` を指すセッションは、1 つの `OAuthTokenFile` で更新する。起動を断るのは次の 3 つ。
  - 同じファイルを別の設定で更新しようとしている。
  - 別のファイルに同じ refresh token がある（ハッシュで比べ、表示はしない）。回転する token を 2 回使うと、使い回しの検知で grant ごと取り消される。
  - エージェント自身の token ファイルを指している。
- **受け口への接続は次の PR で行う。** #264 の `onWake` の応答に合わせて、次の 2 つを足す。
  - `onWake` に署名済みの本文を渡す。
  - 答えに `"bad_request"`（`400`）を足す。

  会話の判定は #264 の `sessionProbe` を使う。コマンドの制限時間を 1.5 秒以内にし、`reuseMs: 0` で結果の再利用を止める。呼び鈴と定期確認の間で共有するのは `SessionTable` の実行中の判定だけ。

`src/agent-notify/notifier.ts`・`sqlite-notices.ts`・`binding.ts`・`hermes-desktop.ts`・`oauth-token.ts`・`hab-client.ts` は変えない。セッションごとの囲いは、今ある場所のまま使う。

### 運用者の手順（Mac mini）

1. `hermes.d/` を作り、今の `notify.json` を移す。`as_address` がなければ足し、`wake` は製品ファイルへ移す。
2. `units` を実行し、表示された `npm run hab:admin -- --config <host-config> session --address <address> --session <session-id> --request-id <request-id>` を打つ。打たなくても、仮の名前のあいだは今までどおり届く。
3. Hermes のプロファイルの reader・actions_command を、移したファイルに向ける。
4. LaunchAgent を `--product … run` に替えて再起動する。
5. 2 つ目の会話をつなぐときの手順。
   - アドレスを登録し、`hermes.d/` に設定を 1 つ足す。
   - 運用者の呼び鈴（ADR-029）を、同じ `http://127.0.0.1:8795` に向ける。
   - notifier を再起動する。
6. `hab:admin status` で `doorbell_missing` がないことを確かめる。テスト送信で、それぞれの会話のカードにだけ出ることも確かめる。

### 相手がいない状態から戻す

「相手がいない」になると、`hab_send` が `recipient_absent` で断られ、新着の呼び鈴は鳴らない。`unknown_address` と `session_mismatch` は設定を見直すためのログで、HAB の不在判定は変えない。

1. 終了済みと判定された会話を復元するか、notifier を現在の会話に結び付け直して再起動する。新しい会話に替える場合は、前節の `session` に新しい会話の ID と新しい `--request-id` を渡す。台帳で既に名前を付けた会話を置き換える場合は、対象アドレスを確認して `--replace true` を付ける。同じ要求を再試行するときは同じ `--request-id` を使う。
2. notifier の定期確認で状態が `present` に戻り、本人の `hab_peek` が通ると不在判定が外れる。そのアドレス自身の `hab_inbox` でも外れる。運用者が呼び鈴を新しい URL で登録し直すか、購読を新規作成しても外れる。
3. 試験の 1 通を `hab_send` で送り、ツール結果が送信の受理を返すことを確かめる。

## Grok と Dots：指示文で自分宛てを確かめる

- **Grok routine** の指示に 1 文足す。「Webhook の `data.session` が `<このセッション名>` でなければ、何もせずに終える」。
  - `hab_inbox` はその接続のアドレスの受信箱しか返さない。違う名前で起きても、読み違いは起きない。
  - 運用者の登録ミス（別のアドレスの呼び鈴を向けた）に気づける。
- **Dots** の見張りの指示にも、同じ 1 文を足す。ChatGPT がイベントの `data` を見せるかは、実機で確かめる。見えなければこの 1 文は効かず、今と同じ動きになる。
- どちらも `410` は返せない。セッションが終わったかどうかは、`hab:admin` の運用で扱う。

## 変えないこと

- HAB の配送・購読・台帳、`hab_inbox` の中身。`hab_inbox` に `session` は載せない（#259 のとおり）。
- 本文・送信元・ID を呼び鈴に載せないこと。
- ADR-015・021・023 の受信側の判断と承認。振り分けが選ぶのは「どのセッションの画面に出すか」だけ。自動受付の規則はセッションごとの設定のまま。

## 検証

- 単体（`node --test`）。
  - `SessionTable.of` の重複と上限。
  - `answerRing` の表の全行。偽の単位で試し、本物の Hermes は使わない。
  - 2 セッションで、呼び鈴が片方だけを起こすこと。
  - 片方のループが止まっても、もう片方が回ること。
  - 読み込みが断る場合（`as_address` なし、単位に `wake`、資格の 3 つの衝突）。
  - `--config … run` が 1 セッションの製品として動くこと。
- verify-hab：機能マップ `features/mcp-events.md` に、署名の照合後の振り分けと `410`・`200 session_unconfirmed` の条件を足す（`/maintain-verification-skill`）。
- 実機（Mac mini）で確かめること。
  - 仮の名前のまま展開しても、Hermes の往復が今と同じ時間で通る。
  - 2 つの会話を 1 つの notifier で受け、それぞれのカードにだけ出る。
  - 設定にない宛先や名前違いで不在判定が変わらず、正しく結び付いた終了済みセッションだけが `recipient_absent` になる。

## PR の分け方

1. この文書（docs だけ）。
2. `src/agent-notify/product-host.ts` とテスト（偽の単位だけ）。#259 と別スレッドの受け口 PR のマージ後。
3. `scripts/lib/notify-product.ts`（製品ファイル・ディレクトリ・`TokenPool`・`units`）と、`run` の付け替え、テスト、verify-hab。
4. Grok と Dots の手順書の指示文（docs だけ）。

## 設計の選び方（arena の記録）

同じ課題で、2 つの案を別々に作った。

| 観点                   | 案 1：同じ process で束ねる                            | 案 2：振り分け専用の process を前に置く                          |
| ---------------------- | ------------------------------------------------------ | ---------------------------------------------------------------- |
| セッションの囲い       | 単位ごとに store・画面・接続を持つ。process は 1 つ    | セッションごとに別 process。囲いはいちばん固い                   |
| 「相手がいない」の誤り | 起動・再起動のあいだは接続できないだけで、数えられない | notifier の再起動中に `410` を返し、3 回で「相手がいない」になる |
| 運用者の手間           | process 1 つ、ポート 1 つ、ディレクトリ 1 つ           | 振り分けの process と notifier N 個、ソケット、残骸の掃除        |
| 試験                   | 偽の単位で、純粋な関数として試せる                     | ソケット・ファイル・時間が要る                                   |

案 1 を土台にした。別の model の判定役も案 1 を選んだ（23 対 19）。案 2 では再起動中に HAB が「セッションが終わった」と数えるため、再起動中は受け口を閉じる構成を採った。

案 2 から 1 つだけ移した。受け口で、選んだセッションの `to` と `session` を確かめること。案 1 ではこれを `route` の中で行う。2 重起動の防止はポートの取り合いで足りるので、案 2 のソケットの鍵は持ち込まなかった。

台帳でまだ仮の名前（アドレスと同じ）の場合も受信できるようにした。これで、展開時にすぐ台帳へ正式な会話 ID を登録できない場合も、既存のセッションを起こせる。

## 本人の判断

- 2026-11-21 JST：当初は束ねにない名前にも `410 session_gone` を返す方針だった。その後 #264 で採用した ADR-032 では、宛先と会話 ID が一致し、製品が会話の終了を確認した場合に `410` を使う。振り分けもこの条件を使う。

## 決まっていないこと（既定で進める）

- 台帳のセッション名を Hermes の会話の ID（`20261121_093000_ab12cd` のような文字列）にする。読みやすい名前を別に持つと、値が 3 つに増えて食い違う。読みやすさを優先したいなら、設定に `session` を足し、起動時に重複を確かめる形に戻せる。
- `--config … run` では `as_address` のない既存設定も使える。`--product … run` に移すときは各セッションに `as_address` を設定する。
- 会話の存在を確かめる口があるセッションでは、`refreshPresence` を定期確認の間隔で実行する。`mayPeek` で受信箱を確認できることを確かめてから `hab_peek` を呼ぶ。
