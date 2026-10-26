# 共通MCPの有限往復試験

## 確認済みの範囲

2026-10-25、CodexとHermesがそれぞれの標準MCPクライアントで同じRelayに接続し、
固定文1件と対応する返信1件を交換しました。両方向ともhostが本文を永続保存して
再読した後にACKし、Relayの両messageが`acked`になったことを確認しています。
双方の認証・binding失効、追加設定・秘密値の除去、試験Relayの停止も確認済みです。
[Issue #105](https://github.com/s-hiraoku/hiraoku-agent-base/issues/105)に結果を記録しています。

これはMac内の有限試験です。実Dotsのクラウド接続、常時受信、無人での認証更新、
一般の依頼実行、製品側の再起動復旧を含む受入れは未完了です。
HABがHermesの実行APIを呼んで起動する経路やTask Engineは使っていません。

| 対象 | 試験で確認した実体 |
| --- | --- |
| Relay / 管理CLI | main `48ca4d3286883a9ecb4bb206315cd8146968751d`、同一revision |
| Codex | アプリ同梱CLI `0.164.0-alpha.11.1`、`gpt-6.1-sol` |
| Hermes | `0.21.5`、commit `f97608f178d1ffeca59860195ab7da295f7c8e5f`、native AIAgentの有限セッション、`gpt-6.1-sol` |
| MCP接続先 | `http://127.0.0.1:8794/mcp`、外部公開なし |
| 認証 | 別connectionの15分限定bearer、明示opt-inの認証グループ |
| データ | 無害な固定文と固定返信だけ。個人ファイル・記憶・既存会話を除外 |

試験hostが時刻・ID・保存とACK許可を担当し、実エージェントがMCPの送信・受信・
ACK・返信を呼びました。MCP登録だけで自動受信や保存保証が成立したわけではありません。
実試験のhostは専用ファイルへの保存・fsync・再読を確認しましたが、汎用的な
トランザクショナルinboxやクラッシュ復旧の証明とは区別します。実設定・本文・
message ID・lease token・実行ログは公開repoに保存しません。

## 秘密不要で再現する回帰検証

```sh
npm ci
npm run build
node --test test/local-relay-admin.test.js
npm run demo:hab-mvp -- --simulate
```

管理CLIの統合テストは模擬認証と一時DBを使用します。
`configured groups complete a durable reply roundtrip and revoke both connections`は、
公式管理処理の登録・binding、共通`HabMcpClient`、既存の`DurableSender` /
`DurableReceiver`とSQLite outbox / inboxを組み合わせます。別DB接続で本文の
コミットを確認してからACKし、返信対応・双方の`acked`・mapping除去後401・
全group binding失効を検証します。モデル・既存資格情報・外部サービスは使いません。
この回帰テストの成功と、上記の実クライアント往復の記録は別の証拠です。

## 実機で再試験する場合の手順

以下は操作者向けの手順です。認証発行やモデル呼出しを自動で許可するものではなく、
実機試験用の秘密管理スクリプトも同梱していません。保存先・権限・期限・費用枠・
隔離・後片付けを具体化し、承認を得てから実施します。

### 1. 実体と設定を固定する

- Relayと[公式管理CLI](local-relay-service.md)を同じrevisionにする。
  `store.agent_capacity`を含む現行設定を使い、既存DB・サービスと分離する。
- CLIの実ファイルと`--version`を確認する。PATH上の旧Codex `0.149.0`では
  `gpt-6.1-sol`が`400 model_not_found`となり、同梱版では成功しました。
  これはその試験経路の結果であり、アカウント全体の契約制限という結論ではありません。
  モデル一覧のローカルキャッシュを、新鮮なサーバー応答として扱いません。
- モデルは双方とも指定したIDで固定し、既存費用枠・認証経路と有料fallbackなしを確認する。
  勝手なモデル代替・新しいOAuth・資格情報のコピーはしない。
- 他MCP・shell・ファイル編集・記憶・個人文脈・自動Skillsを実効設定で除外する。
  Codexの試験ではMCP5操作のほか汎用resource helper 3操作がモデルに提示されました。
  試験serverにはresourceを公開していません。
  「ツール総数が5」という証明ではありません。Hermesでは実効MCP5操作を確認しました。
  ドキュメント読込み抑止のflagsだけではglobal AGENTSの除外が足りず、試験プロセスの
  読取り制限も検証しました。後続versionでは再確認が必要です。

### 2. deny-all起動、認証、登録

空のmappingで専用Relayを先に起動し、未認証拒否を確認します。管理CLIはRelayが
初期化したRegistryを使います。先に独自スクリプトでDBを初期化しません。

```sh
npm run relay:local -- --config <private-config>
npm run relay:admin -- --config <private-config> connect \
  --address sender@client-a.hab --connection-id <sender-connection-id>
npm run relay:admin -- --config <private-config> connect \
  --address receiver@client-b.hab --connection-id <receiver-connection-id>
npm run relay:admin -- --config <private-config> status
```

`connect`前に、承認済みの期限付き認証をmappingへ登録します。CLIはtoken発行器
ではありません。秘密はargv・チャット・ログに載せず、Codexはプロセス内、Hermesの
profile `.env`は承認した場所・0600、親0700で一時保存します。同じOSユーザーから
読める点も承認対象です。例のconnection IDは秘密ではなく、失効済みIDを再利用しません。
`status`の対象resource・group・宛先・権限・期限を確認し、意図しない`problems`を解消します。

両クライアントに同じloopback URLとbearerを設定し、Relayの基本5操作だけを
discoveryします。グループ内の宛先は`as_address`と固定の`expected_agent_id`で選びます。
グループ内は共有信頼境界であり、アドレス選択はBotの独立した本人証明ではありません。

### 3. 操作承認とモデルへの提示を確認する

非対話Codexの試験では、明示承認を得た3操作だけを**そのプロセス内**で次のように
許可しました。普段の設定、global承認、sandboxや他ツールは緩めません。

```text
mcp_servers.hab_relay.tools.relay_submit.approval_mode="approve"
mcp_servers.hab_relay.tools.relay_poll.approval_mode="approve"
mcp_servers.hab_relay.tools.relay_ack.approval_mode="approve"
```

この版では`auto`はannotationに応じた承認判定であり、無条件許可ではありません。
[`mcp_tool_call.rs`](https://github.com/openai/codex/blob/rust-v0.164.0-alpha.11.1/codex-rs/core/src/mcp_tool_call.rs)
の対応と実効設定を確認します。標準のdeferred tool searchと、直接5操作を提示する
試験設定も区別します。API payloadのtop-level `tools`だけを調べて「ツールなし」と
判断せず、実際にモデルへ渡ったカタログとネイティブクライアントの呼出しを確認します。
これらはクライアント設定であり、HABに製品名による配送分岐を追加しません。

### 4. 固定文と返信を交換する

1. 送信hostが時刻・replay-bound message ID・thread ID・宛先・期限を確定し、
   完成したenvelopeをoutboxへ保存する。再送でもID・内容・期限を変えない。
2. 送信側が`relay_resolve`で宛先を照合し、`relay_submit`の受付結果を確認する。
3. 受信側が`relay_poll`し、受信hostが`(sender_id, message_id)`と本文を保存・再読する。
   未保存ならACKを許可しない。
4. 受信側が同じdeliveryのgeneration・lease tokenで`relay_ack`する。
5. 返信hostが同じthreadと正しい`in_reply_to`を持つ返信を保存し、逆方向に同じ手順を行う。
6. 送受信IDの対応、双方の保存内容とACK receipt、`relay_status`の両`acked`を確認する。

モデルに正確な現在時刻やID生成を任せる必要はありません。今回のhostによる補助は、
Relayが時刻を補完する新仕様でも、製品固有の配送Adapterでもありません。
ACKは配送受領であり、依頼内容の実行完了を意味しません。

### 5. 失効を検証してから秘密を削除する

1. 試験mappingを除去し、listenerが生きている間に旧tokenで401を確認する。
2. integrity keyを残したまま、双方に公式`disconnect`を実行する。
   mappingがなくても失効できるが、鍵を先に削除すると管理処理を開けません。
3. `status`でgroup停止・active binding 0を確認する。
   groupの`disconnect`は全memberへ影響するため、試験用group以外を流用しない。
4. 今回追加した秘密と設定だけを除去し、他の`.env`項目と元のMCP設定を保持・照合する。
   inboxのlease tokenも残さない。DBを保持する運用では必要な保管鍵を勝手に削除しない。
5. 所有する有限プロセスを終了し、試験Relay停止とポート接続拒否を確認する。
   既存サービスの停止や全プロセス走査を後片付けの前提にしない。

途中失敗でも後片付けを行い、失効の成否と通信試験の成否を分けて記録します。
終了時刻だけで失効済みとせず、検証不能なら未確認のまま報告します。

## 次段階と任意改善

有限試験の完了を妨げる必須修正は残っていません。常駐・自律運用へ進むには、
各hostの受信起動契機、永続inbox/outboxの自動連携・再起動復旧、参加承認と短命token更新、
保守・容量・監査・backup運用の受入れが必要です。実Dotsの到達経路・OAuth接続も別です。
今回の15分認証や3操作承認を延長・恒久化する根拠にはしません。

導入手順の一般化は[Issue #104](https://github.com/s-hiraoku/hiraoku-agent-base/issues/104)、
複数アドレス・容量保守などの関連作業は[Issue #102](https://github.com/s-hiraoku/hiraoku-agent-base/issues/102)
と照合し、必須でない改善を今回の有限試験へ追加しません。
