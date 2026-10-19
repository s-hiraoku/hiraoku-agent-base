# 添付のMCP転送境界

[README](../README.md) · [管理添付](managed-attachments.md) · [配送と削除](attachment-deletion.md)

## 任意のcatalog

[AttachmentHttpGateway](../src/relay/attachment-http.ts)は既定のRelay 4 toolsへ6 toolsを追加する。[HabAttachmentHttpGateway](../src/hab/attachment-http.ts)ではアドレス解決を含め計11 toolsとなる。通常のRelay／HAB factoryは4／5 toolsのままであり、公開entryや既存runtimeが自動でimport・登録・起動することはない。

| tool | version 1の入力 | 権限と保存点 |
| --- | --- | --- |
| `relay_attachment_begin` | 元のUploadIntent | 現在のsubmit主体、宛先・kindと固定した時刻拘束request ID |
| `relay_attachment_status` | version、attachment_id | 所有者だけ。保存済みnext_offsetから再開 |
| `relay_attachment_put` | version、attachment_id、offset、data_base64 | 所有者だけ。1回1chunk、同じoffset／bytesは冪等 |
| `relay_attachment_finalize` | version、attachment_id | 所有者だけ。全体byte長・SHA検証後に確定 |
| `relay_attachment_cancel` | version、attachment_id | 所有者だけ。生きたmessage bindingの早期解除は拒否 |
| `relay_attachment_read` | version、sender_id、message_id、attachment_id、offset | 現在の受信主体とpoll権限、元message・kind・確定参照を検証 |

入力のagent名・owner・receiver、token、URL、path、任意range、余剰fieldを受け付けない。readのsender IDは検索用であり認証に使わない。maintenance、物理削除、権限付与、shell、登録、credential発行のtoolは追加しない。upload／readとACKは別操作であり、内容を実行しない。

## version付きcodecと有限量

[attachment-wire.ts](../src/relay/attachment-wire.ts)は厳密なversion 1のJSON契約を持つ。put／readのbinaryは標準alphabet・padding付きのcanonical base64だけで表し、URL-safe文字、空白、余剰padding、不正padding bitsを拒否する。受信文字数を確認してからdecodeし、復元後のbyte長と再encode一致も検証する。readの元期限・宛先・manifest・offset・next_offset・EOFと固定chunk policyを検証し、filenameをpathへ変換しない。

hostはupload backendと同じ有限`max_attachment_bytes`／`chunk_bytes`を明示する。実装上限は添付256 MiB、chunk 1 MiB、1添付最大1024 chunksで、本番capacityの推奨値ではない。空ファイルはchunkなしでfinalizeし、readは空のEOFを返す。status／finalize／cancelは元の進捗・期限を保持し、terminalを再開しない。

base64には約4/3のサイズ増加があり、MCP応答ではtext contentとstructuredContentの両方へ同じ値を格納する。hostはHTTP request／response上限へこの増加とmetadata・framingを含める。byte量の上限は有限chunkの制限とHTTP gatewayの総byte制限の両方で確認し、自動で上限を拡大しない。

## 認証・監査とhost組立て

hostは固定したupload／readサービス、Relay operations、wire policy、HTTP policy、AuditSink、検証済みcontext resolverを明示する。HABでは既存のupload／acceptance／read guardを組み立て、registry → Relay → upload DBの順を守る。添付messageのsubmitはprepare／commit／confirmのcoordinatorへ接続し、poll／ACKには別途明示delivery policyが必要である。

全6 toolsは既存の認証付きHTTP gatewayを通り、接続先resource、Origin、Bearer verifier、監査、入力／応答bytes、同時要求数、rate、timeoutの制限を維持する。認証未接続は401となり、同期host portがPromiseを返した場合も拒否してrejectionを消費する。公開エラーは固定codeだけに限定し、任意例外、DB内容、token、chunk bytesをauditへ渡さない。

ACKを受けたserverは通常取得を直ちに閉じ、削除outboxへ移る。物理削除は別の明示maintenance workerが実行する。受信者は全bytesのdurable保存と検証を終え、local inbox／ACK journalへ保存してからACKする。

## 応答不明と再照合

HTTP timeout・切断・監査後段失敗・応答上限超過は、storeが未commitだった証明にはならない。元intentとrequest IDを送信前にdurable保存し、beginの応答不明は同じintentで照合する。chunkは同じoffset／bytesの再送またはstatusのnext_offsetから再開する。finalize／cancelの再試行も同じattachment IDを使う。新しいID・元期限の付替え・無限retryは行わない。実transportとjournalの起動・保守契機はhost側で明示する。

## 現在の検証範囲

18件のテストで実HAB登録・upload DB・Relay DB・認可guardをHTTP gateway／MCP SDKへ組み合わせ、任意catalogと既定catalogの分離、認証拒否、外国体・未confirm拒否、再送、binaryと空EOF、上限1 MiBのcodec、破損、停止・block、digest不一致、監査前後の障害、HTTP byte制限を検証する。この層はRequest／Responseをin-processで使用し、listenerや実エージェントを起動しない。

固定接続先clientとの組立て、native loopback経由のdurable受信・ACK消失復旧、整合backup／restoreと本番配線は後続である。HTTP adapterの構築はデプロイや本番3者接続の完了を意味しない。
