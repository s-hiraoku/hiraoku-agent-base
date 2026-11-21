# 呼び鈴のセッション名で受信を振り分ける（設計案）

状態：**案（410 の扱いは本人判断済み）**。2026-11-21 JST。前提は [ADR-032](../hab-decisions.md) と PR #259（呼び鈴の `data` を `{to, session, arrived_at}` にする）。

## 何を決めるか

本人の方針（2026-11-20）は次のとおり。

- 会話は管理しない。アドレスとセッションは 1 対 1。
- 呼び鈴の購読は製品ごとに 1 つでよく、どのセッション宛てかは通知の中で製品が判断する。
- アドレスに結び付いたセッションがなければ「相手がいない」エラーにする。

PR #259 で、HAB は呼び鈴に台帳のセッション名 `session` を載せる。この文書は、**受け取る製品の側がその名前でどう振り分けるか**を決める。HAB 側（配送・台帳・購読）は変えない。

## 結論

| 製品            | 呼び鈴を受けるもの             | 振り分け                                                                                 | 今回の作業         |
| --------------- | ------------------------------ | ---------------------------------------------------------------------------------------- | ------------------ |
| Hermes Desktop  | notifier の受け口（127.0.0.1） | notifier 1 つで複数のセッションを持ち、`session` で 1 つを選んで確かめる。なければ `410` | 実装（下の 1〜4）  |
| Grok Bot        | xAI の Webhook（routine）      | routine 1 つ＝アドレス 1 つ。`session` は routine が自分宛てかを確かめるのに使うだけ     | 手順書の指示文だけ |
| Dots（ChatGPT） | MCP イベント（見張りの会話）   | 接続 1 つ＝アドレス 1 つ。イベントは見張りを頼んだ 1 つの会話でしか動かない              | 手順書の指示文だけ |

Grok と Dots は、1 つの購読で複数のセッションを持てる仕組みが製品の側にない（Grok の routine も ChatGPT の見張りも、1 つの会話・タスクに結び付く）。応答の HTTP 状態も製品のサーバーが返すので、`410` を返せない。だからこの 2 つは「今は 1 アドレス 1 購読のまま、`session` は自分宛ての確認に使う」にとどめる。複数セッション化は PR-6（製品ごとに 1 つの購読）と付録 B の ChatGPT の判断のあと。

## Hermes：notifier を製品ごとに 1 つにする

### 今

- notifier は 1 つの設定（`notify.json`）で 1 つのセッションに結び付く。画面（`screen.session_id`）、記録（`store`、`target` で照合）、資格（`token`、`as_address`）が 1 組。
- 受け口（`wake`）は署名だけを確かめ、本文を読まずに「今すぐ確かめる」を鳴らす。
- Hermes の会話を 2 つ HAB につなぐには、notifier を 2 つ動かし、ポートと呼び鈴も 2 組要る。

### 変えたあと

1 つの `run` が、セッションごとの設定を束ねる。セッションごとの設定ファイルは今の `notify.json` のまま使う（`events`・`action`・`statusline`・`decide` などの画面側のコマンドは 1 セッションの設定を読むので、何も変えない）。

```jsonc
// notify-hermes.json（製品の束ね。新規）
{
  "wake": { "port": 8795, "secret_file": "~/.config/hab/wake.secret" },
  "interval_ms": 300000,
  "sessions": [
    "~/.config/hab/notify-hermes-hab.json",
    "~/.config/hab/notify-hermes-research.json",
  ],
}
```

```jsonc
// notify-hermes-hab.json（今の設定に 1 項目足すだけ）
{
  "session": "hermes-hab@hermes.hab",   // 台帳のセッション名。呼び鈴の data.session と同じ
  "as_address": "hermes-hab@hermes.hab",
  "screen": { "type": "hermes-desktop", "session_id": "…", … },
  "store": "…", "token": { … }, …
}
```

1. **束ねの設定を足す。** `hab-notify --bundle <notify-hermes.json> run`。`wake` と `interval_ms` は束ねの側だけに書く（セッションの設定に `wake` があれば `bundle_wake_conflict` で起動しない）。セッションは最大 32。同じ `session` が 2 つ、または同じ `store`・同じ画面の結び付き（`bindingIdentity`）が 2 つあれば起動しない。今の `--config … run` はそのまま動く（束ねなしの 1 セッション）。
2. **呼び鈴を読む。** 受け口は署名を確かめたあと、本文を厳密に読む（`data.to`、`data.session` は文字列、ほかの項目は無視）。
   - `session` が束ねのどれかの `session` と一致し、そのセッションの `as_address`（または資格のアドレス）が `to` と一致する → `200`、そのセッションだけをすぐ確かめる。
   - 一致するセッションがない → `410` と `{"reason":"session_gone"}`。HAB は続けて 3 回でそのアドレスを「相手がいない」にする（ADR-032、PR #254）。`2xx` か新しい購読で戻る。
   - `session` が一致して `to` が違う → `409`（設定の誤り）。HAB は数えない。ログに 1 行。
   - `session` がない（#259 より前の host）→ `to` で選ぶ。それもなければ全セッションを確かめて `200`（今と同じ動き）。
   - 本文が読めない → `400`。HAB は数えない。
3. **保険の定期確認は全セッション。** `interval_ms` ごとに、束ねのセッションを順に確かめる。1 つの失敗はほかを止めない。ログの行にセッション名を足す。
4. **資格の更新を共有する。** 2 つのセッションが同じ `token.oauth.file` を指すとき、更新は 1 つの `OAuthTokenFile` で行う（回転する refresh token を 2 回使うと、使い回しの検知で grant ごと取り消される）。違うファイルなら別々。

`410` を返すのは「この notifier がその名前のセッションを持っていない」ときだけ。持っているセッションが Hermes の側で終わっていたとき（`session.resume` が会話なしと答える）の `410` は、別スレッド「終わったセッションを製品から HAB に知らせる」が受け持つ。受け口の `onWake` はそちらの PR で `"accepted" | "session_gone"` を返す形になる。束ねでは本文を読んでセッションを選び、`"bad_request"`（400）と `"mismatch"`（409）を足す。選んだセッションが終わっているかは、そちらの `sessionProbe(command, sessionId)`（`present` / `gone` / `unknown`、Hermes の `state.db` を読み取り専用で見る）をセッションごとに呼び、`gone` のときだけ `410` にする。

### 運用者の手順（Mac mini）

1. 台帳のセッション名を決める：`hab:admin session <address> <名前>`（Hermes の会話 ID でも、読みやすい名前でもよい）。
2. セッションの設定に `"session": "<同じ名前>"` を足す。
3. 束ねの設定を作り、LaunchAgent の起動を `--bundle` に替える。
4. 2 つ目の Hermes 会話をつなぐときは、アドレスを登録し、運用者の呼び鈴（ADR-029）を同じ `http://127.0.0.1:8795` に向け、束ねに設定を 1 行足して notifier を再起動する。
5. `hab:admin status` で `doorbell_missing` がないこと、テスト送信で呼び鈴の `session` が正しいセッションに届くことを確かめる。

## Grok と Dots：指示文で自分宛てを確かめる

- **Grok routine** の指示に「Webhook の `data.session` が `<このセッション名>` でなければ、何もせずに終える」を足す。`hab_inbox` はその接続のアドレスの受信箱しか返さないので、違う名前で起きても読み違いは起きないが、運用者の登録ミス（別のアドレスの呼び鈴を向けた）に気づける。
- **Dots** の見張りの指示にも同じ 1 文を足す。ChatGPT がイベントの `data` を見せるかは、実機で確かめる（見えなければこの 1 文は効かず、今と同じ）。
- どちらも `410` は返せない。セッションが終わったかどうかは、`hab:admin` の運用で扱う。

## 変えないこと

- HAB の配送、購読、台帳、`hab_inbox` の中身。`hab_inbox` に `session` は載せない（#259 のとおり）。
- 本文・送信元・ID を呼び鈴に載せないこと。
- ADR-015・021・023 の受信側の判断と承認。振り分けは「どのセッションの画面に出すか」を選ぶだけで、自動受付の規則はセッションごとの設定のまま。

## 検証

- 単体：束ねの読み込み（重複・上限・`wake` の衝突）、呼び鈴の 5 つの分岐（一致・なし・`to` 違い・`session` なし・壊れた本文）、2 セッションで片方だけが確かめられること、資格ファイルの共有で更新が 1 回であること。`node --test test/agent-notify-*.test.js`。
- verify-hab：機能マップ `features/mcp-events.md` に notifier の振り分けと `410` の条件を足す（`/maintain-verification-skill`）。
- 実機（Mac mini）：Hermes の会話 2 つを 1 つの notifier で受け、それぞれに送ったメールがそれぞれのカードにだけ出る。束ねから外したセッション宛てに 3 回送ると `hab_send` が `recipient_absent` になり、束ねに戻すと次の `2xx` で戻る。

## PR の分け方

1. この文書（docs だけ）。
2. notifier の束ねと振り分け（`scripts/hab-notify.ts`、`src/agent-notify/wake-listener.ts`、テスト、verify-hab）。#259 のマージ後。
3. Grok と Dots の手順書の指示文（docs だけ）。

## 本人の判断

- 2026-11-21 JST：束ねにない名前の呼び鈴には `410 session_gone` を返す（「相手がいない」にする）。設定の書き漏れでも 3 回で `recipient_absent` になるが、束ねに足せば次の呼び鈴で戻る。
