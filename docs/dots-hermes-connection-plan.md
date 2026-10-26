# Dots / Hermesの共通MCP接続準備

目標は、このDotsの会話環境でHABの5操作を使い、Hermesと継続して送受信できる状態です。
最初の受入れは実Dots → 共通Relay → 実Hermes → Dots返信の有限な往復とし、
その後に継続接続の受入れへ進みます。有限試験だけで全体完了にはしません。
[Codex / Hermes試験](finite-mcp-trial.md)は参考になる既存実績ですが、このペアの成功を
証明しません。HABがHermesの実行APIを起動する構成や旧Task MCPへ置き換えません。

## 再利用するもの

- 既存のRelay用pluginと、その公開MCP URL・OAuth client・5scope設定。
  packageの存在、desktopへの導入、DotsクラウドでのOAuth接続、tools露出は別に確認する。
  旧Task pluginを改変したり、新pluginを重複作成したりしない。
- Hermesに残る標準MCP定義。接続URL・5操作の選択を保持し、前試験で無効化した
  定義の再有効化と、削除済みの期限付き認証の再発行を区別する。
- 既存の公開proxy path・TLS・OAuthメタデータ・公開鍵。公開範囲を追加せず、
  既存の別MCP pathを保持する。無効なOAuth入口の401は未接続の正常な拒否である。
- 既存DB・固定アドレス・保管鍵。停止・失効済みの履歴を消して最初から登録し直さない。

## 接続前の確認と承認対象

| 対象 | 確認すること | 実変更前に具体化すること |
| --- | --- | --- |
| 常駐Relay | 実行設定のrelease、Node、port、現行schemaとの互換性 | 採用commit・artifact hash、既存設定との差分、停止/切替/復元の手順 |
| DB | Registry version、停止/失効済み記録、配送状態 | DBと鍵の整合backup、グループv2移行、旧runtimeへ戻す場合の復元。受入れ後の新規データを捨てるrollbackはしない |
| 公開入口 | 正確なresource、Host/path、未認証401、metadata、issuerの公開鍵 | OAuth有効化、許可するsubject/client、connection期限。追加公開や他pathの変更は別承認 |
| Dots cloud | 既存pluginの接続画面、実際のOAuth callback、5toolsの露出 | callback/grantの必要差分、token保管主体、期限・refresh有無、失効手順 |
| Hermes | MCP定義の残存/有効状態、モデル/認証経路、組込みツール/文脈の隔離 | tokenの保存先・0600/親0700・期限、名義、5操作、終了後に戻す設定 |
| 有限往復 | 固定文・返信、単一consumer、保存と再読の実行主体 | model ID・最大呼出し数・既存費用枠・fallbackなし、秘密を含まない記録範囲 |

既存設定に現行の`store.agent_capacity`がなければ、最新版を指すだけの再起動はしない。
例の設定値も自動適用せず、既存の全体容量と保持済み記録に整合する上限を選ぶ。
LaunchAgentのProgramArgumentsとWorkingDirectoryは同じ専用releaseへ揃える。
KeepAliveはRelayプロセスの再起動であり、HermesやDotsの自動受信を意味しない。

資格情報の新規発行・永続アクセス・grant・公開・起動設定変更を、コード準備の許可から
推定しない。前試験の15分許可窓を延長・流用せず、準備が揃ってから発行する。
OAuth callbackやsubjectを推測せず、実画面と検証済みOAuth結果から確認する。

## 実行順序

1. Dotsクラウド側で既存pluginの正式な接続経路とcallbackを確定する。
   未ログイン・本人確認待ち・tools未露出を明記し、desktop側の設定成功で代替しない。
2. Mac側の候補releaseと設定差分を秘密不要の模擬環境で検証し、具体的な変更承認を得る。
3. 承認後に既存Relayだけを止めてDB・設定・鍵を安全に保全し、同じport/pathで
   採用releaseを起動する。全拒否の入口で401/metadata/別サービス維持を確認する。
4. 両側の準備完了後に承認済み期限の認証を設定し、公式管理CLIで登録/bindingする。
   OAuth groupには、その共通信頼境界へ参加することを承認した宛先だけを所属させる。
5. 実Dotsが5操作を呼べること、Hermesの実効ツールと隔離を確認してから、
   固定envelopeを送る。受信hostは完全なenvelopeとACK要求を保存・別読取りで照合し、
   保存後だけACKする。逆方向も同じ手順で返信し、ID・`in_reply_to`と双方のACKを照合する。
6. 有限試験の終了時は、承認範囲のmapping/grant無効化・401・binding失効を確認し、
   試験だけの秘密と設定を除去する。以前からあるplugin、他のMCP、DBや保管鍵を
   無断で削除しない。残すRelayの状態も記録する。

## 今回の接続と次段階の境界

この手順書と模擬検証は実Dots / Hermesの往復成功を主張しません。
常駐受信・hostの自動inbox/outbox連携・再起動復旧・参加承認に基づく短命token更新は、
このペアの有限往復後の受入れです。現行OAuth verifierの接続窓は最大15分であり、
Auth0のrefreshを有効化するだけでは継続接続になりません。
参加承認と短命token更新の分離は[Issue #108](https://github.com/s-hiraoku/hiraoku-agent-base/issues/108)
で管理し、pluginの実接続は[Issue #98](https://github.com/s-hiraoku/hiraoku-agent-base/issues/98)
と照合します。
その仕様を選ぶ前に、試験のための恒久権限や製品専用配送を追加しません。
