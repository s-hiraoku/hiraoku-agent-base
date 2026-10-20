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

## 任意のHTTP配線

Relay／HAB／添付の各HTTP gatewayは、verifier引数の次に任意の同じWriterAdmission instanceを受け取ります。HABは同期port `habWriterIdentity(registry)` で、検証済みcontextから現在のbindingと操作権限を確認します。portは短いregistry guardの中で不変IDだけを返し、認可objectやlockを待機queueへ持ち出しません。実際のサービスは待機後に本来のregistry → Relay → upload guardを取り直します。

```ts
const writer = new WriterAdmission(writerPolicy, habWriterIdentity(registry));
const gateway = new HabAttachmentHttpGateway(
  relay, attachments, wirePolicy, httpPolicy, audit, verify, writer,
);
```

writerPolicy等はhostが用意する既存port／明示設定です。この例は登録・credential発行・listener起動をしません。基本RelayもHABと同じ受付coreを使い、HAB固有の個体解決は上の別portへ分離します。

認証・request bytes・protocol前処理の後、SDKのtool dispatch前に受付します。submit／status／poll／ACK／resolveと添付の全6toolは同じ個体bucketを共有します。uploadの操作はsubmit権限、attachment readはpoll権限で照合し、peer・kind・bindingの実検証は本来のtoolで行います。別gateway・modern／legacy framing・同じIDの再送でbudgetを分けません。tools/list・initialize等は既存の認証と全体HTTP制限を通り、個体のwriter tokenは消費しません。未知toolや未対応mappingはdispatchしません。既知toolのschema不正はSDKで拒否し、その受付試行は消費します。

認証失敗は401、現在binding／操作の拒否は403、個体rateは429、queue上限／queue期限／close等は503、HTTP全体deadlineは504、呼出元のabortは408です。新しい拒否は空bodyと既存audit categoryで返し、個体ID・queue数・原例外を漏らしません。queue・HTTPのtimeoutや429は未commitの証明ではないため、送信側は元ID・元intent・receiptで照合します。

slotはSDK応答の有限読取・handler closeに加え、未完了toolの開始／完了auditが実際にsettleするまで保持します。HTTP応答が先にtimeoutしてもslotを再使用せず、遅れて戻ったauditから期限後にtoolを始めません。

未指定時の既存gateway挙動・catalog数は変わりません。設定したadmissionに個体resolverがなければ403となり、public／no-authへfallbackしません。通常runtimeへは自動配線しません。

## 検証

`node --test test/relay-writer-admission.test.js` の20シナリオで、巡回順・1 active、個体別bucket／比例補充・queue上限・有限個体map、取消し／期限・失効・rebind・呼出し直前のmicrotask・clock逆行、未認証・async port・policy copy・closeを検証します。実エージェント・credential・listenerを起動しません。

HTTP側は `node --test test/relay-writer-http.test.js` の26シナリオで、modern／legacy・gateway共用・全添付tool・directory、認証／引数偽装、queue競合・取消し・期限・現在失効・独立registry更新、開始／完了auditのtimeout後slot保持、揮発budget再生成とdurable receipt照合を確認します。うち1件は使い捨てのloopback listenerで、合成Bearerと一時SQLiteだけを使います。
