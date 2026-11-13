# HAB の構成

[README](../README.md) · [文書一覧](README.md) · [設計判断（ADR）](hab-decisions.md) · [メッセージ配送の正式仕様](hab-relay-spec.md)

HAB は、エージェント同士がメッセージをやり取りするための基盤です。メールのように各エージェントへ `<bot_name>@<agent_name>.hab` 形式のアドレスを結びつけ、そのアドレスで宛先のセッションを特定します。この文書は main にある現在の構成をまとめたものです。本番配備の状況は README の「現在可能なこと」で区別します。旧 Task Hub（固定 Task・inventory・ping・Worker/D1）は 2026-11-12 に削除しました。その説明は [history](history/README.md) に残しています。

## 部品

| 部品 | 場所 | 役割 |
| --- | --- | --- |
| メッセージ契約 | `src/messaging` | message の形、`DeliveryService` interface、ツールの error code |
| Registry | `src/hab` | アドレス → 不変の `agent_id`、認証グループ、操作権限、停止・失効、改名（v3） |
| host | `src/host` | 唯一のサーバー。設定・HTTP 入口・監査・管理 CLI・MCP server（`src/host/mcp`）・任意の A2A 入口 |
| 配送 | `src/delivery` | host の状態ディレクトリにある 1 つの SQLite ファイルで受付・lease・ACK・状態照会（[配送 store](delivery-store.md)） |
| エージェント SDK | `src/agent-sdk` | 送信側の永続 outbox、保存後に ACK する受信 inbox、MCP client、受信 supervisor |
| 受信側の任意部品 | `src/adapter-host` ほか | 返信 budget、質問返信 intent、単一 owner、ACP 起動など。標準接続には不要（[receiver](receiver/)） |

host は `npm run relay:local` で起動し、アドレスの登録と接続は `npm run relay:admin` で行います。名前に残る `relay` は既存の接続設定との互換のためです。旧 HAB Relay は 2026-11-07 に廃止し（ADR-016）、配送は一時 NATS JetStream を経て、2026-11-13 から host の SQLite ファイル 1 つで行っています（ADR-018）。

## アドレスと認証

- 接続は必ず認証グループを通して結びつけます。単独のエージェントは「自分だけが所属するグループ」になります（[認証グループ](relay-auth-groups.md)）。
- 送信者の名義と受信箱は、引数のエージェント名ではなく、認証済みの接続から決まります。1 つの接続が複数のアドレスを使うときは `as_address` で名義を選び、所属しないアドレスは拒否します。
- 実際に使える操作は、グループの権限とアドレスの権限の共通部分です。グループかアドレスを止めると、その接続からの操作は止まります。
- アドレスは再利用しません。改名は同じ `agent_id` を保ったまま行い、旧名は永久に予約します（[改名](agent-address-rename.md)）。

## 送信と受信

エージェントは標準の MCP client から 5 つのツールを使います（[共通 MCP 接続](common-mcp-connection.md)）。

1. `relay_resolve` でアドレスを解決します。
2. `relay_submit` で送ります。同じ `message_id` の再送は同じ受付結果になります。
3. 受信側は `relay_poll` で lease 付きの配送を受け取り、自分の store に保存してから `relay_ack` します。保存に失敗したら ACK せず、lease が切れると再配送されます。
4. `relay_status` で配送状態を確かめます。

常駐受信はエージェント SDK の `ReceiveHost` と `ReceiveSupervisor` で組み立てます。モデルを使わずに poll・保存・ACK を繰り返し、認証が切れたら待機して、検証後に再開します（[受信 supervisor](receiver/receive-supervisor.md)）。届いた内容を判断して実行するのは受信エージェント自身で、HAB は配送を受け取っただけで Task を実行しません。

## 任意の入口と調整

- **A2A**: 設定に `a2a` section があるときだけ loopback listener を開きます。A2A Task は host 所有のアドレスから設定済みの受信者へ送られ、結果は受信者の永続返信で報告します（[A2A](a2a/a2a-relay-preview.md)）。
- **OAuth 入口**: HTTPS reverse proxy から同じ 5 ツールを受けます（[OAuth 入口](operations/relay-oauth-ingress.md)、[常用 OAuth](operations/persistent-mcp-auth.md)）。
- **アドレス照会**: 任意の `hab_discover` ツール（[エージェント照会](connections/mcp-agent-discovery.md)）。
- **配送の調整**: 個体別の容量、公平な poll、公平な writer 受付（[delivery](delivery/)）。

## 運用

起動・設定・管理 CLI は [ローカルサービス](local-relay-service.md)、常駐は [LaunchAgent](operations/local-relay-launchagent.md) にまとめています。動作は [ローカル MVP](local-mvp.md) の 1 コマンドで、一時 DB と loopback 通信だけを使って確かめられます。
