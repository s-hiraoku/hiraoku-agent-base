# Grok BotからHABへ接続する

Grok Bot自身の標準custom MCPからHABを呼ぶ接続手順である。
[共通接続](../common-mcp-connection.md)と[常用認証](../operations/persistent-mcp-auth.md)を使い、
製品固有の配送分岐は追加しない。Grok APIのモデル呼出しや、MacのGrok Botを
操作する第三者製MCPは、この接続の代わりにはならない。

## 公式能力と実機の確認範囲

2026-11-08に公式の[アプリとコンピューター](https://docs.x.ai/grok-bot/computer-and-apps)、
[private network](https://docs.x.ai/grok-bot/private-networks)、
[security](https://docs.x.ai/grok-bot/security)資料を確認した。
実機にはGrok Bot 0.79.2（`com.anysphere.sand`）が導入されている。
MacのロックによりConnect apps画面は未確認。実アカウントのHAB定義、OAuth方式、
保存先、callback、scope、refreshは確認していない。

公式資料はURLとcommandによるcustom MCPを記載している。
URL接続の実行元はMacアプリ自身と決めつけない。remote MCPは製品側サーバーから
接続し、command方式はBotのcloud computerで実行する。
したがってMacの`127.0.0.1`やtailnet URLへ実機Macから到達できても、接続成立の証拠ではない。
private networkとprivate CAには製品側の承認も必要になる。

## 共有範囲と認証

公式資料ではアプリ接続はアカウント内のBotに共有される。cloud computerのfilesと
command credentialsも共有であり、Bot別の画面や名前を独立した秘密境界にしない。
OAuth tokenはconnector backendが保持すると記載されているが、HABのcustom MCPで
実際に使われる認証・保存方式は設定画面で確認する。

HAB groupもその実効共有範囲に合わせる。group内の複数名義を選べることと、
各Botの独立sessionを証明できることは別である。Hermes/Dots用tokenを渡したり、
名義指定だけで別Botの専用受信箱へアクセスできる構成にしない。

## 接続を適用する順序

1. ロック解除後、既存Connect appsと対象Botを確認する。既存接続を二重登録しない。
2. URLかcommandの正式入力形式、実行元、到達経路を確定する。MacのHABを公開する
   新規tunnelやcloud computerのtailnet参加は別のネットワーク変更として具体化する。
   desktop経由の通信設定だけでprivate networkへ接続できると扱わない。
3. 人間が選ぶHABアドレス、groupの共有範囲、正規resource、OAuth client/callback、
   5 scope、参加期間、refresh保存先、停止・失効を照合し、新規永続アクセスの確認を
   済ませてから追加・認証する。製品固有JSON形式やcallbackを推測して埋めない。
4. native MCPでdiscoveryと`hab_discover(action=whoami)`を行い、Registryの
   不変ID・アドレス・group・操作と比較する。host identity未検証はそのまま記録する。
5. [受信側の準備](../receiver/recipient-readiness.md)に沿い、durable inbox/outboxと保存後ACK、
   本文取得、受信者の現在権限と既存承認を接続する。Connect appsへの登録のみで
   自動受信や自律回答が起動したと扱わない。

command方式でも[専用stdio](../receiver/recipient-stdio.md)のowner・private launch binding・
専用storesは必要である。account-wideのcommand登録だけではBotとの一対一bindingを
証明しない。既存fixtureや固定allow-allで不足を補わない。

## 受入れと停止

最初は無害な有限質問で、実Grok Botのnative MCP、本文の永続保存後ACK、
実モデルが選んだ返信、対応する`in_reply_to`、送信元の保存後ACKを照合する。
受信後の判断と外部操作にはGrok Bot既存の承認を適用する。
Routinesの存在だけでHAB受信契機があるとは扱わない。
常駐化は頻度・停止対象・再起動と認証更新の証拠を加えて判定する。

停止では対象接続の資格情報、参加・binding、受信起動をそれぞれ止め、共有先Botへの
影響も確認する。定義の削除は永続inbox/outboxの削除と分ける。
現在はnative認証・メッセージ往復・保存後ACK・回答・常駐をすべて未実施としている。
