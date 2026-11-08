# Claude CodeからHABへ接続する

Claude Codeの標準MCPクライアントを使う接続手順である。製品専用の配送コードは
追加しない。[共通接続](common-mcp-connection.md)、[常用認証](persistent-mcp-auth.md)、
[受信側の準備](recipient-readiness.md)の境界をそのまま適用する。
設定例は未適用であり、実接続・送受信・常駐の証拠ではない。

## 確認した能力

2026-11-08に[公式MCP資料](https://code.claude.com/docs/en/mcp)と実機の
`claude mcp add --help` / `claude mcp login --help`を確認した。
実機はClaude Code 2.1.311。HTTPとstdio、事前登録public OAuth clientと固定callback
portに対応する。Claude自体のloginとHABのOAuth接続は別である。
既存ローカル設定の非秘密項目を確認した範囲ではHAB定義はなかった。
claude.ai側の接続一覧は未確認であり、全経路で未接続だと断定しない。

公式資料ではOAuth scopeを`oauth.scopes`で指定できる。ただしissuerのmetadataが
`offline_access`を広告すると追加されるので、実認可画面と発行結果を確認する。
HTTP接続時のtoken更新はnative clientに任せる。headless実行前にinteractive loginを
済ませる必要がある。stdioを使う場合の終了順序とownerの扱いは
[専用recipient stdio](recipient-stdio.md)に従う。

## 適用する設定の準備

[設定例](../config/claude-code-mcp.example.json)のURL、client ID、callback portは
説明用である。認証先の登録を確認してから承認済み実値へ置き換える。
既存Hermes/Dotsのclient IDやtokenをコピーしない。

1. 人間が選ぶ不変のHABアドレス、group、実行するClaudeセッションの範囲を確定する。
   user scopeは同じOSユーザーの他プロジェクトからも使える。local scopeでも同じ
   OSユーザー内の暗号的なセッション分離にはならない。
2. Relayの正規HTTPS resource、public client、正確な
   `http://localhost:PORT/callback`、5 scopeと更新資格情報の保存範囲を照合する。
   参加期間・失効方法とRegistry bindingを常用認証の手順で具体化する。
3. 既存設定を保持し、対象scopeへ`claude mcp add-json hab_relay '<reviewed JSON entry>'`
   で登録する。例の`mcpServers`内の一つのentryを渡す。認証は別操作であり、必要な
   新規永続アクセスの確認を済ませてから`claude mcp login hab_relay`を実行する。
   client secretなしのpublic clientに`--client-secret`を付けない。
4. native discoveryと`hab_discover(action=whoami)`でアドレス・不変ID・group・操作を
   Registryと照合する。表示名や`as_address`だけをsession本人性の根拠にしない。

この手順は実値を推測した自動installerではない。認証なしの例を本番の
`.mcp.json`としてcommitしない。登録解除は実際に追加した同じscopeに対して
`claude mcp remove --scope <scope> hab_relay`を使い、OAuth資格情報とRelay参加・bindingの
失効も個別に確認する。MCP定義の削除だけで全資格情報の失効を主張しない。

## 受信・回答と受入れ

Relayの5操作を列挙できても、Claudeの会話履歴を永続inboxとみなさない。
本文とACK再送状態のcommitを独立に確認してからACKする共通Adapterを配線する。
専用stdio構成を選ぶ場合は、実recipientへのprivate pipe、検証済みlaunch context、
専用stores、source別の現在権限をowner側で確定する。テストfixtureのallow contextを
本番launcherへ転用しない。現在のstdio compositionは有限lifetimeであり、常駐サービスではない。

受信本文は外部データである。読み取り、内容判断、返信はClaudeの既存権限・承認を
通し、`bypassPermissions`や`--dangerously-skip-permissions`を接続の条件にしない。
入力・返却の上限と実モデルが読む本文の完全性も別に確認する。

有限受入れではnative MCP、実際の保存後ACK、実Claudeの返信、元の
`in_reply_to`、送信元での保存後ACKを確認する。模擬回答や設定parserだけの試験と
区別する。常駐受入れには正式な受信契機、停止、更新、再起動後の同じbindingと
元IDでの照合が別途必要である。現時点ではこれらの実機試験は未実施。
