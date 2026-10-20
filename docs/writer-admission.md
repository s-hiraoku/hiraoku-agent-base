# 検証済み個体のrateと公平writer受付

[README](../README.md) · [正式仕様](hab-relay-spec.md) · [公平poll](relay-fair-poll.md)

`WriterAdmission` はtransport・HAB・DBに依存しない任意のhostコンポーネントです。1プロセスのwriter候補を最大1 callbackずつ進め、待っている個体をround robinで選びます。callbackを呼ぶ前に待つため、queue内ではregistry／Relay／uploadのDB lockを保持しません。認可済みの個体IDと候補を渡す同期host portが必要で、未設定・例外・Promise・不正IDは拒否します。tool引数やアドレス、credentialの文字列をkeyにはしません。

## 有限policy

hostは `max_individuals`、`max_waiting_per_individual`、`requests_per_window`、`window_ms`、`max_wait_ms` を明示します。最大256個体、個体queue最大64件、待機総枠の積最大4096件、待機最大30秒です。これらは実装上限で、本番の数値を自動採用しません。

個体ごとに `requests_per_window` 件分のburstを持つtoken bucketを1つ共有します。単調時刻の整数msで比例補充し、固定window境界で2倍のburstを許す方式にはしません。受付済みの試行を1件消費し、再送・操作種別の変更・queue取消しでも返却しません。本人の上限超過・slot不足は、既存のmessage IDや元期限を変更せずbackpressureとして扱います。

個体の識別とメモリーも有限です。spent tokenや待機中・activeな個体を追い出して新bucketを作り直すことはありません。idleかつ全token補充済みになった個体だけ回収します。したがって、異なる有効個体が上限を超えれば新候補は拒否されます。hostは登録上限と受付上限を揃えます。

## 再確認・取消し・終了

待機候補はFIFOで保持し、選択時と実際のcallback呼出し直前に現在の個体ID・操作権限を確認します。失効・IDの付替えでは拒否し、新しい個体のbucketへ自動移動しません。callback内の本来のサービス認可・peer／kind・期限・容量・lease検査も必須です。queue内で得た一時的な認可objectを持ち出しません。

待機中のAbortSignal・有限timer・単調deadline・closeで候補を取り除き、後からcallbackを呼びません。active callbackは、呼出元が切断・timeout・abortしても実際のPromiseがsettleするまで枠を保持します。queueのcloseは待機を拒否し、activeを成功扱いしたり枠を再使用したりしません。callbackの中から同じwriterを再入して待つ構成は使いません。自動retry・新message・Taskを作りません。

clock逆行・不正時刻はfail-closedです。既定clockはprocessの単調時刻で、テストでは同期clock portを使います。時刻値・queue・個体一覧や要求本文を外部へ公開しません。

## 適用範囲

これは**1プロセスで共有する1インスタンス**の受付境界です。複数gatewayで同じinstanceを使います。rateと待機queueは揮発性で、process再起動によりbucketが初期化され、候補は失われます。永続outbox／receipt／Task・run照合の代わりにはなりません。再起動を越えるrate、別process／別replicaや直接SQL・保守writer全体のfairness、DB lock取得時間、byte量・実行時間・遅延SLOは保証していません。

認証前のHTTP connection・body・rate上限は別の保護境界です。入口で拒否された要求には、このqueueの順番保証はありません。active callbackや監査providerが止まれば、fail-closedでwriterも止まります。監視・停止・照合と実負荷での本番値決定はhostの責務です。

このPRではcoreだけを追加し、既定runtime／MCP catalogは有効化しません。次の任意HTTP配線では、認証済みcontextからIDを解決し、送信・状態照会・poll・ACK・directory・添付の全tool操作で共有します。現在のRelay／HABサービス認可を残し、呼出元のtimeout後も未完了tool監査がsettleするまで枠を保持する必要があります。

## 検証

`node --test test/relay-writer-admission.test.js` の20シナリオで、巡回順・1 active、個体別bucket／比例補充・queue上限・有限個体map、取消し／期限・失効・rebind・呼出し直前のmicrotask・clock逆行、未認証・async port・policy copy・closeを検証します。実エージェント・credential・listenerを起動しません。
