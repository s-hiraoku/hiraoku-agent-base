# 汎用テキストの NATS 配送と再起動復旧

**履歴文書（削除済みの実装）**：本書が説明する `src/generic-nats/`、`packages/relay-nats/src/text-port.ts`、`scripts/prove-generic-nats.mjs`、P7の generic-nats 群は削除しました。本番の呼出し元がなく、送信の認可を Registry ではなく JetStream backend 自身の認可 callback で判断していたためです。以下は削除前の契約の記録であり、現在のコードや手順を表しません。現在の配送は[配送store](../delivery-store.md)（ADR-018で`packages/relay-nats`も削除）、標準接続は[ADR-016](../hab-decisions.md)を参照してください。

この文書は明示構成する任意Task連携の契約です。標準の[共通MCP接続](../common-mcp-connection.md)と[受信supervisor](../receive-supervisor.md)はTaskなしで使えます。内容判断・実行・既存の権限や承認は受信エージェント側に残し、Hermes固有runnerを接続条件にしません。

この経路は、[汎用 A2A/MCP profile](../profiles/async-text-v1.md)の Task を、既存の JetStream 配送で受信 runtime へ接続する opt-in の実行ポートです。TaskService が Task の正本です。broker や配送 journal に別の Task エンジンを追加しません。本番の認証・起動設定、実 Hermes、所有者承認、保護対象 tool、自動返信は有効化しません。

## 配送と実行の境界

`NatsTextClient.runs(routeId)` は既存 `Adapter` が使う `Runs` です。`createText()` は同じ Task key に対応するローカル配送ジョブを永続化し、その実在するハンドルを返します。この時点で外部 runtime の実行は受理されていません。Task の `working` は coordinator の処理開始を表し、受信者でモデルが動いた証拠ではありません。

Adapter がハンドルを Task に保存したこと、現在の worker・owner/client・完全な binding・fence・権限世代・lease を private gate で確認してから、元の要求を送信します。`TaskService.get()` と既存の認可境界を使い、外部本文から Principal を作りません。

受信側は実際に届いた要求を `SQLiteInbox` へ保存し、保存 ACK を返します。`receiveOnce()` は実行しません。別の `executeOnce()` が現在の権限を再確認し、永続的な初回実行予約を取ってから、設定済み runtime の `createText()` を呼びます。実際の runtime ID と、配送ハンドルは別に保存します。確認済みの実行証跡が戻るまで Task は完了しません。結果は Task の get/Artifact として返し、利用者宛の answer 自動送信には別の policy が必要です。

同じ coordinator mailbox の返信は、単一の永続 receiver/router が受け取ります。認証された peer、設定 route、scope、元要求、key、fingerprint、実行 ID を照合して対応するポートへ振り分けます。受信者ごとの worker journal と inbox は独立です。別 route の返信で Task を完了できません。無効な protocol メッセージは完全な受信内容を容量制限付き journal に隔離してから本文を解放します。権限待ちや保存失敗の正当なデータは保持し、後続の再確認で復帰します。

## 再送と結果不明

JetStream の配送は少なくとも一度です。[NATS の配送・ACK 契約](https://docs.nats.io/learn/jetstream/delivery-and-acknowledgment)を、任意の外部操作の exactly-once 保証へ拡張しません。既存 Relay は受付 journal、PubAck、受信側保存 ACK、consumer ACK、本文削除を別々に記録します。

このポートも、送信前に要求と元 ID・本文・時刻を保存します。同じ実行 key は既存の `hub-${task.id}` です。受信者は SQLite の比較更新で初回呼出しを制限します。process 内の busy flag を複数 consumer の排他保証にしません。

runtime への呼出しが不明になった場合、保存済みの実行 ID を `get()` で照会します。ID がなければ、対応 runtime の `lookupText(key)` だけで照合します。応答がない、記録がない、照合機能がない、保証期間を過ぎたという理由で `createText()` を再実行しません。結果不明を保留します。runtime 呼出しの時間切れや abort は、外部操作が停止した証拠ではありません。

確認済みの結果と返信 outbox は同じ private transaction に保存します。結果返信が失われた場合は同じ結果を再配送します。期限後の照会は同じ key の読み取りであり、新しい実行にはなりません。`Runs.get()` と Task の reconciliation は実行要求を送信しません。

既存の reconciliation は確認済み成功だけを閉じます。lease 後の failed/running/unknown は既存の安全な保留条件を維持します。claim と最初の worker journal 保存の間で停止した場合も、無条件の自動復旧とは表現しません。配送ハンドルの紐付け前に外部効果を起こさないことが、この段階の保証です。

## 時刻・保存・容量

実行要求の `first_sent_at` は不変の Task `acceptedAt` です。配送期限はそこから1時間です。再起動や古い送信 journal への復元で延長しません。待機が長く、最初の配送までに1時間を過ぎた要求も新規実行へ送りません。作業期限と runtime の重複防止保持期限は別に確認します。

結果と照会返信には、それぞれ永続化した独自の送信時刻と1時間の配送期限があります。既知の実行結果は元要求の配送期限を過ぎても照会できます。期限切れは外部効果がなかったという意味ではありません。

本文と結果は、NUL と孤立サロゲートを除く正しい Unicode、UTF-8最大32,768バイトです。JSONでのエスケープを含む実サイズを検査します。data は256 KiB、Relay envelope は384 KiB、broker message は512 KiB以上が必要です。既存の小さい fixture 設定を、そのまま汎用本文へ流用しません。

private journal は owner 専用の通常ファイル、FULL同期、設定 binding と key を照合する metadata、各行の binding 付き MAC を使います。他用途の DB を開いて移行しません。破損・誤った key・異なる binding・容量超過は拒否し、既存証跡を捨てて継続しません。能動的な重複防止情報を空き容量のために削除しません。送信 client は保持128ジョブ、各ジョブの明示照会32回を上限とします。到達時は新規受付・照会を拒否し、既存証跡を保全します。長期の常駐組み込みでは、これらの予算と保持記録の運用手順も受入対象にします。

## 組み込みと検証

`src/generic-nats/` が private protocol、journal、Task gate、client、recipient を持ちます。`packages/relay-nats/src/text-port.ts` の `jetStreamTextPort()` は、既存の実 JetStream backend と認可 context を固定したポートを作ります。接続先や権限はメッセージから指定しません。実行証跡を返す peer は、ホストが信頼する実行サービスに限定します。一般の送信者がその名義で `generic_text_evidence` を発行できる認可設定にはしません。実製品へ接続する前に、この送信名義と kind の分離も検証します。

client と recipient の constructor は listener や常駐 loop を開始しません。ホストが有限 step を呼び、必要な supervisor を別に構成します。`close()` 後も注入した inbox・journal・runtime・transport は呼出し側が所有します。閉じる順番と pending operation の完了を確認してから保存先を閉じます。有限走査の1回に進捗がないことを、全 pending 要求がなくなった証拠にしません。

検証は隔離環境で行います。固定 Node/npm と lockfile を使い、公式 archive を project 内へ用意します。

```sh
npm ci
npm ci --prefix packages/relay-nats --ignore-scripts
node packages/relay-nats/scripts/install-server.mjs
NODE_NO_WARNINGS=1 node scripts/prove-generic-nats.mjs --nats-server /absolute/path/to/nats-server
```

proof runner は実行前に binary の固定サイズ・SHAを検査し、別の scratch へ検証済みの byte だけを stage します。任意 binary や本番 server URL は実行対象にできません。実 JetStream の要求・結果を公式 manager で観測し、異なる2つの合成 runtime、保存後 ACK、逆順の結果、応答喪失、broker/receiver の停止と再開、独立した疑似外部 API 台帳の重複防止を試験します。LLM と実エージェントには接続しません。

これは、宣言した重複防止・照合契約の範囲での試験です。実製品の tool 隔離、電源断、物理 SSD 障害、本番権限、移設先 volume の保証にはしません。本番配置・実認証・実製品の接続は、別の受入と運用手順を通します。

P7 の必須 `broker-startup` 群は、同じ検証済み公式 binary で起動前の signal 終了、3秒遅延、起動期限超過、spawn 失敗、非ゼロ終了を確認します。試験 fixture の起動待ちは単調時計による10秒期限です。子の終了を検知したら待機を終了し、自動で起動し直しません。認証付き NATS 接続で ready を確認し、接続後も死活と期限を再確認します。失敗理由・試行数・経過時間・終了 code/signal・限定した接続 error code を TAP に残します。credential・URL・path・生の error/stderr は公開診断へ含めません。この起動予算は試験用であり、本番の性能目標、配送 lease、TTL を変更しません。
