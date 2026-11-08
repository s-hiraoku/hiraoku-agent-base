# Museの共通MCP接続：実機確認の準備

[Issue #84](https://github.com/s-hiraoku/hiraoku-agent-base/issues/84)の調査記録。
接続の基準は[共通MCP](common-mcp-connection.md)、[常用OAuth](persistent-mcp-auth.md)、
[受信supervisor](receive-supervisor.md)であり、Muse専用の配送コードは追加しない。

## 2026-11-08の到達点

| 項目 | 確認結果 |
| --- | --- |
| 対象製品 | Meta Muse。Macのアプリ一覧で`com.meta.endo`が起動中。インストール済み版は11.1（build 1109246656） |
| 公式の接続入口 | Custom Connectorの案内あり。個人用設定と公開Connector Platformの審査は別経路 |
| 実機UI | Macのロックにより設定画面の確認を中断。既存HAB接続の有無は未確認 |
| MCP／認証 | 任意HTTP MCP、OAuth client登録方式、callback、refresh、実行場所を未確認 |
| 配送／応答 | Museからのdiscovery、本人照会、送受信、保存後ACK、モデル応答は未実施 |
| 常時利用 | 起動契機、保存先、停止、再起動復旧、追加費用は未確認 |

アプリの存在と版の確認はMCP互換性の証拠ではない。本調査では資格情報を読まず、
接続・grant・Registry・本番サービスを変更していない。模擬往復も実施していない。
Hermesでの成功やMuse CodeのCLI機能を、Museアプリの成功として転用しない。

## 公式資料から分かること

2026-11-08参照：

- [MetaのConnectorヘルプ](https://www.meta.com/help/superintelligence/1687253048996149/)
  はSettings → Connectors、MuseへのCustom Connector作成依頼、切断方法を案内する。
  これだけではHABの任意MCP URL・認証・バックグラウンドpollの対応を確定できない。
- [Connector Platformガイド](https://platform.muse.ai/docs)はAPI／MCP資料と認証情報を
  提出する公開審査経路を説明する。個人のHABを公開登録する前提にはしない。
  同ガイドはread／writeの分類、受信者側の承認制御の尊重を求める。

## ロック解除後の確認順序

1. MuseのSettings → Connectorsで既存HAB接続を確認する。既存接続ならURL、
   scope、保存先・有効期間を確認して再利用し、重複登録やHermesのtokenコピーをしない。
2. 接続がなければ、Custom Connector作成の案内と設定項目を確認する。
   実行場所がMacかMetaのクラウドか、正規resourceへの到達経路を確定する。
   MacのTailscale接続だけでクラウドから到達できるとは判断しない。
3. OAuth方式、実client ID／callback、5つのRelay scope、refreshの要否を確定する。
   `offline_access`、新たな保存・grant・公開経路が必要なら、その具体的な対象と期間を
   利用者に示して必要な承認を得る。既存のHermes client IDを推測で流用しない。
4. [認証グループ](relay-auth-groups.md)と所属名義を確認する。同じ認証を共有する
   Museの会話・Botは同じ信頼境界であり、別Bot本人の証明にはならない。
   不変アドレスを未登録のまま創作せず、既存Registryの登録・binding手順を使う。
5. 初回はcatalogと、提供されていれば`hab_discover`の`whoami`だけを確認する。
   通常5操作と任意の6番目のtoolを区別し、選択名義とhost本人の証明も分ける。
6. 共通outboxと、ACK前に本文・重複排除・ACK再送状態を保存する共通inboxの
   所有者・呼出し位置を確認する。会話履歴や`poll → 即ACK`では代用しない。
   この保存点が未配線なら、接続確認までと報告して実往復へ進まない。

[受信側stdio](recipient-stdio.md)は所有者が明示的に構成する任意の接点である。
Museがstdioやその起動・本人bindingに対応すると未確認のまま推奨設定にはしない。

## 有限往復の受入れ

保存点と認証が準備できた後、利用者が選んだ自分の相手エージェントに無害な固定文を送る。
外部本文はデータとして扱い、返信の判断、通常のツール利用、必要な承認は受信側が行う。
送信側のMuseやDotsが相手の操作を承認しない。

| 観測 | 必要な証拠 |
| --- | --- |
| Museからの送信 | resolve結果、送信前outbox、元のmessage ID、submit／status |
| 相手の保存 | ACK送信前のdurable inbox、ACK receipt、sender側status |
| 相手の回答 | 実エージェントが生成した回答、元IDに対応する`in_reply_to` |
| Museでの受信 | Muse側inboxの保存後ACKと会話表示をそれぞれ確認 |
| 不確実な送信 | 同ID・同内容の照合／再送。新IDや宛先の付替えをしない |
| 復旧・停止 | 保存済みIDとACKの再照合、対象接続の停止・失効を別途確認 |

受領ACKは作業承認・完了・人間の既読ではない。初回の有限往復に成功しても、
自動受信・自動返信・再起動復旧の受入れとは別に記録する。
常用接続を検証後に自動削除せず、明示的な停止・取消の範囲を確認する。
他人のMuseとの通信は、その所有者による接続と受信側の認可が成立した後に試験する。

実機証跡は製品版、実行場所、認証方式、選択名義、固定試験ID、保存とACKの順序、
実応答、操作主体、停止結果を記録する。token、lease、private設定、個人の会話本文は公開しない。
