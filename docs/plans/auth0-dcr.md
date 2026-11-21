# 製品ごとの Auth0 アプリ作成をなくす（DCR と承認待ち）

2026-11-21 JST、本人の判断で方式を決めた（「DCR＋HAB の承認待ち」）。この文書は設計と実装の計画で、Auth0 の設定変更と実装はこの文書の了承後に行う。

関連：[エージェントの接続と導入を簡単にする](agent-connection-and-receive.md)（2 章の承認待ちが前提）・[認証グループ](../auth-groups.md)（ADR-014）・[OAuth 入口](../operations/oauth-ingress.md)・[常用 MCP 接続](../operations/persistent-mcp-auth.md)

## 1. 何を変えるか

今は新しい製品をつなぐたびに、Auth0 の管理画面で製品専用のアプリを作っている（種類の選択、callback の登録、Refresh Token の許可、client ID と secret を製品の画面へ貼る）。[設定手順書](../connections/agent-setup.md)の共通の準備 2 がこれにあたる。

変えたあとは次の 3 手になる。

1. 製品の画面で HAB の MCP（公開 URL）を追加し、本人がログインして同意する。製品が Auth0 にアプリを自分で登録する（DCR、RFC 7591）。
2. Mac mini で `hab:admin pending` を見て、いまログインした 1 件を確かめる。
3. `hab:admin approve --pending <id> --address <bot@agent.hab>` で登録する。

## 2. 安全の境界は変わらない

HAB は Auth0 にアプリがあることを信用の理由にしていない。token の署名・issuer・audience・scope・期限を確かめたうえで、主体と client ID の組が接続台帳にあるかで通すか決める（`src/host/oauth-auth.ts`）。台帳に行を足すのは運用者の `approve` だけである（ADR-014、承認待ちの計画 2 章）。DCR で誰かが Auth0 にアプリを作っても、その組は承認待ちに入るだけで、HAB の操作は何もできない。

変わるのは「Auth0 にアプリを作れる人」が本人だけから誰でもに広がること。これは Auth0 の中の話で、HAB の境界の外である。その影響は 5 章で抑える。

## 3. 製品ごとの見込み（公開文書で確認、実機は未確認）

| 製品 | DCR | 再接続のとき | 注意 |
| --- | --- | --- | --- |
| claude.ai | 既定で対応。CIMD が広告されていればそちらを優先 | 新しく接続するたびに新しいアプリを登録する | `scopes_supported` に `offline_access` があれば付けて refresh token を取る |
| ChatGPT（Dots） | 対応。CIMD があれば優先 | 接続 1 つにつき 1 回登録して使い回す | DCR のアプリで `openid` が抜ける報告がある（原因未解決） |
| Grok | 対応 | 再接続のたびに登録する報告がある | Auth0 相手に識別用の scope が「不正」と断られた報告がある |
| Muse | 不明 | 不明 | 実機で確かめる |
| Hermes・hab-notify・Claude Code | 手元の public client | — | 今のアプリのままにする（移行しない） |

参考：[ChatGPT の認証](https://developers.openai.com/plugins/build/auth)・[Claude のコネクタ認証](https://claude.com/docs/connectors/building/authentication)・[Auth0 と Grok の報告](https://community.auth0.com/t/auth0-grok-mcp-invalid-oauth-scopes-and-repeated-dynamic-client-registration/204524)・[ChatGPT の openid の報告](https://community.openai.com/t/missing-openid-scope-in-dynamically-registered-oauth-clients/1368690)

いまつながっている接続（Dots・Muse・Grok・claude.ai・Hermes）は、手で作ったアプリのまま動かし続ける。DCR は新しくつなぐ製品と、つなぎ直すときだけに使う。

## 4. Auth0 の設定（本人の了承後に行う）

[Auth0 の DCR](https://auth0.com/docs/get-started/applications/dynamic-client-registration) の条件に合わせる。

1. HAB の API に、外部アプリ（third-party）用の既定の権限として 5 scope（`hab:resolve hab:submit hab:status hab:poll hab:ack`）を付ける。付けないと DCR のアプリはどの API にも入れない。Allow Offline Access は今のまま有効。
2. 本人がログインに使う接続を domain-level に上げる。DCR のアプリ（client ID が `tpc_` で始まる）は domain-level の接続しか使えない。
3. その接続で新規の利用者登録（sign up）が閉じていることを確かめる。開いていると、他人も自分のアカウントで token を取れる（HAB は主体が違うので承認待ちに入るだけだが、承認待ちが埋まる）。
4. Post-Login Action で、access token に `https://hab/client_name`（`event.client.name`）を足す。承認待ちの一覧でどの製品かを見分けるためで、名前は登録した側の自己申告として扱う（5 章）。
5. Tenant Settings → Advanced で DCR を有効にする。**常時は開けず、つなぐときだけ開いて、終わったら閉じる**（5 章）。

DCR を閉じても、すでに登録されたアプリのログインと refresh は続く。登録の口（`/oidc/register`）が閉じるだけである。

## 5. リスクと抑え方

| リスク | 抑え方 |
| --- | --- |
| 登録の口は token なしで誰でも使える（Auth0 自身が警告）。アプリが溜まり、テナントのアプリ数の上限に当たると新しい登録ができなくなる | つなぐときだけ DCR を開く。開いている時間は数分。`hab:admin status` に、承認待ちと退役した接続の client ID を出し、Auth0 で消すアプリが分かるようにする |
| 偽のアプリへ本人がログインさせられ、その組が承認待ちに入る | 承認するのは「いま自分がログインした 1 件」だけ。`pending` に最初に来た時刻と、token の `client_name` を出す。時刻が合わない行、心当たりのない行は `reject` する。承認しない限り HAB は使えない |
| claude.ai・Grok は再接続のたびに新しい client ID になり、台帳の組と合わなくなる | `approve --replace <connection_id>` で、同じアドレスを新しい接続へ付け替え、古い接続を退役させる（6 章） |
| 製品が要る scope を取れない（ChatGPT の `openid`、Grok の識別用 scope） | 試験で 1 製品ずつ確かめる。だめな製品は今の手作りのアプリに戻す（手順書に両方を残す） |
| DCR のアプリは Auth0 の画面であとから設定を変えにくい（登録した側ではなくテナント所有者が直す） | 期限・回転は API とテナント側の既定で決め、アプリごとの手直しに頼らない |

なりすまし対策（DPoP など）は本人の判断（2026-11-14）で範囲外のまま。

## 6. HAB の変更

承認待ち（[導入計画](agent-connection-and-receive.md) 2 章）の実装に、次を足す。2 章の PR と同じか、その直後の PR にする。

1. **`client_name` の表示。** 承認待ちの行に `client_name`（あれば）を保存し、`hab:admin pending` に出す。表示に「自己申告」と付ける。token の他の中身は今の計画どおり残さない。
2. **付け替え。** `hab:admin approve --pending <id> --replace <connection_id>`。同じ主体の接続だけを対象にし、新しい接続を足してから、古い接続のアドレスを新しい接続へ移し、古い接続を `state: revoked` にする（行は残す。今の台帳の状態は `active` と `revoked` の 2 つで、新しい状態は足さない）。台帳ファイルの書き換えは承認と同じく一時ファイルからの置き換えとバックアップ。`--replace` なしで、すでに接続のあるアドレスを指定したら `address_already_bound` で断り、`--replace` の使い方を出す。
3. **退役した接続の一覧。** `hab:admin status` に、退役した接続の client ID（`tpc_` のもの）を出す。Auth0 で消す候補になる。HAB は Auth0 の管理 API の鍵を持たない（アプリを作れる強い鍵を Mac mini に置かない）。
4. **手順書。** [設定手順書](../connections/agent-setup.md)の共通の準備 2 を「DCR でつなぐ（既定）」と「手でアプリを作る（DCR が通らない製品）」に分ける。

テスト：`test/host-admin.test.js` に、付け替え（同じ主体だけ、古い接続の退役、途中で止まったときに前か後の台帳が残る）、`address_already_bound`、`client_name` の表示と保存を足す。`test/oauth-auth.test.js` に、`tpc_` の client ID と `client_name` の claim を持つ合成 token の承認待ち入りを足す。

## 7. 進め方

1. この文書の了承。
2. 承認待ち（導入計画 2 章）と 6 章の実装、テスト。
3. 本人の了承を得て Auth0 の 1〜4 を設定し、DCR を開く。
4. 試験：まだ HAB につないでいない入口を 1 つ選び（例：別の claude.ai のコネクタ、または Muse）、DCR でつなぐ → `pending` → `approve` → `hab_status` が通る → DCR を閉じる → 約 10 分後に refresh が通る。
5. ChatGPT・Grok は、つなぎ直しが要る機会に `--replace` で試す。通らない製品は手順書の手作りの経路のまま。
6. 結果を ADR として `hab-decisions.md` に記録する。

戻し方：DCR を閉じる。試験で作られた `tpc_` のアプリを Auth0 で消し、台帳の接続を `revoked` にする（`hab:admin disconnect`）。手で作ったアプリと今の接続には触らないので、そのまま動く。
