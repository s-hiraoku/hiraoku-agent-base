# 製品ごとの Auth0 アプリ作成をなくす（DCR と承認待ち）

2026-11-21 JST、本人の判断で方式を決めた（「DCR＋HAB の承認待ち」）。この文書は設計と実装の計画で、Auth0 の設定変更と実装はこの文書の了承後に行う。2026-11-21 に 2 つのモデルで設計を攻撃的にレビューし、その指摘を 5〜8 章に入れた。

関連：[エージェントの接続と導入を簡単にする](agent-connection-and-receive.md)（2 章の承認待ちが前提）・[認証グループ](../auth-groups.md)（ADR-014）・[OAuth 入口](../operations/oauth-ingress.md)・[常用 MCP 接続](../operations/persistent-mcp-auth.md)

## 1. 何を変えるか

今は新しい製品をつなぐたびに、Auth0 の管理画面で製品専用のアプリを作っている（種類の選択、callback の登録、Refresh Token の許可、client ID と secret を製品の画面へ貼る）。[設定手順書](../connections/agent-setup.md)の共通の準備 2 がこれにあたる。

変えたあとは次の 3 手になる。

1. Auth0 で DCR を開き、製品の画面で HAB の MCP（公開 URL）を追加し、本人がログインして同意する。製品が Auth0 にアプリを自分で登録する（DCR、RFC 7591）。終わったら DCR を閉じる。
2. Mac mini で `hab:admin pending` を見て、利用者が製品から始めた接続の client ID と、Auth0 に登録された callback URL の全件を 7 章の手順で照合する。
3. `hab:admin approve --pending <id> --address <bot@agent.hab>` で登録する。

## 2. 安全の境界は変わらない

HAB は Auth0 にアプリがあることを信用の理由にしていない。token の署名・issuer・audience・scope・期限を確かめたうえで、主体と client ID の組が接続台帳にあるかで通すか決める（`src/host/oauth-auth.ts`）。台帳に行を足すのは運用者の `approve` だけである（ADR-014、承認待ちの計画 2 章）。DCR で誰かが Auth0 にアプリを作っても、その組は承認待ちに入るだけで、HAB の操作は何もできない。

変わるのは「Auth0 にアプリを作れる人」が本人だけから誰でもに広がること。これは Auth0 の中の話で、HAB の境界の外である。その影響は 7 章で抑える。

## 3. 製品ごとの見込み（公開文書で確認、実機は未確認）

| 製品 | DCR | 再接続のとき | 注意 |
| --- | --- | --- | --- |
| claude.ai | 既定で対応。CIMD が広告されていればそちらを優先 | 新しく接続するたびに新しいアプリを登録する | `scopes_supported` に `offline_access` があれば付けて refresh token を取る |
| ChatGPT（Dots） | 対応。CIMD があれば優先 | 接続 1 つにつき 1 回登録して使い回す | Auth0 の strict mode で `openid` や ID token を使わずに接続できるか確かめる |
| Grok | 対応 | 再接続のたびに登録する報告がある | Auth0 相手に識別用の scope が「不正」と断られた報告がある |
| Muse | 不明 | 不明 | 実機で確かめる |
| Hermes・hab-notify・Claude Code | 手元の public client | — | 今のアプリのままにする（移行しない） |

参考：[ChatGPT の認証](https://developers.openai.com/plugins/build/auth)・[Claude のコネクタ認証](https://claude.com/docs/connectors/building/authentication)・[Auth0 と Grok の報告](https://community.auth0.com/t/auth0-grok-mcp-invalid-oauth-scopes-and-repeated-dynamic-client-registration/204524)・[ChatGPT の openid の報告](https://community.openai.com/t/missing-openid-scope-in-dynamically-registered-oauth-clients/1368690)

いまつながっている接続（Dots・Muse・Grok・claude.ai・Hermes）は、手で作ったアプリのまま動かし続ける。DCR は新しくつなぐ製品と、つなぎ直すときだけに使う。

## 4. Auth0 の設定（本人の了承後に行う）

[Auth0 の DCR](https://auth0.com/docs/get-started/applications/dynamic-client-registration) の条件に合わせる。1〜3 は一度だけ、4 はつなぐたびに行う。

1. HAB の API に、外部アプリ（third-party）用の既定の権限として 5 scope（`hab:resolve hab:submit hab:status hab:poll hab:ack`）を付ける。Allow Offline Access を有効のままにする。DCR を開く前に、テナントで新規クライアントに strict mode が適用されることを確かめる。旧テナントの permissive mode では既定の client grant が適用されず、HAB の承認待ちに必要な API scope が欠ける。旧クライアントのモードは登録時に決まるため、strict mode の試験には新しい登録を使う。strict mode で使えない `openid`、`profile`、`email`、ID token に製品が依存する場合は、その製品の手動登録を使う。 [Auth0 の strict mode](https://support.auth0.com/center/s/article/enable-strict-dcr-mode-for-tenant)
2. 本人がログインに使う接続を domain-level に上げる。DCR のアプリ（client ID が `tpc_` で始まる）は domain-level の接続しか使えない。上げると、テナントの外部アプリはすべてこの接続でログインできるようになる。テナントには HAB の API しかないことを先に確かめる。戻すときは domain-level を外す。
3. 外部アプリから利用できるすべての domain-level 接続で、本人として許可した主体だけが HAB 用の token を取れることを先に確かめる。database 接続では Disable Sign Ups に加えて、ログインできる既存ユーザーを確認する。social 接続などで対象の主体を絞る必要があれば、対象を限定した Post-Login Action で許可した主体だけを通す。試験用の外部アプリで所有者の許可とその他の主体の拒否を確認してから DCR を開く。外部アプリの同意画面は表示する。 [Auth0 の domain-level 接続](https://auth0.com/docs/authenticate/identity-providers/promote-connections-to-domain-level)
4. Tenant Settings → Advanced で DCR を開く。製品が登録したら閉じる。承認と `hab_status` の確認は閉じた状態で行う。試験を中断した場合も閉じる。閉じたことは、Auth0 の `/.well-known/openid-configuration` に `registration_endpoint` が無いことで確かめる。

DCR を閉じても、すでに登録されたアプリのログインと refresh は続く。登録の口（`/oidc/register`）が閉じるだけである。

## 5. 実機で決まる 3 つの問い（試験の合否にする）

レビューで、次の 3 つは文書からは決まらず、製品の動きで決まると分かった。HAB の変更をここに先回りして作らない。8 章の試験で製品ごとに確かめ、結果で 6 章の追加を決める。

1. **承認前の 401 で、製品は何をするか。** 承認待ちの組は 401 で断る（`src/host/mcp/http.ts`、`WWW-Authenticate` に `resource_metadata` と `scope`）。MCP の仕組みでは、401 を受けた製品は認可をやり直してよい。claude.ai と Grok は、やり直すたびに新しいアプリを登録する見込みなので、承認待ちの行が増えるだけで、承認した組が使われない恐れがある。承認後も、承認前に出た token は `token_before_approval` で断るので、製品が同じアプリのまま refresh して初めて通る。
   - 合格：承認後、同じ `tpc_` の client ID で `hab_status` が通る。
   - 不合格のとき：承認待ちの組への返事を、認可のやり直しを誘わない形（`WWW-Authenticate` を付けない 403 など）に変える案を、その製品の結果を見て決める。
2. **refresh token が出るか。** HAB の protected resource metadata の `scopes_supported` は 5 scope だけで、`offline_access` が無い（`src/host/mcp/oauth-resource.ts`）。今の手作りの接続では、人が製品の画面で `offline_access` を足している（[設定手順書](../connections/agent-setup.md)の共通の準備 3）。DCR には入れる欄が無い製品がある。claude.ai は「認可サーバーの metadata にあれば付ける」と書いていて、Auth0 側の metadata を読むなら今のままで出る（推測）。
   - 合格：Auth0 のログで、その `tpc_` のアプリに refresh token が出ている。access token の期限（最長 600 秒）を過ぎても、つなぎ直しなしで `hab_status` が通る。
   - 不合格のとき：`scopes_supported` と 401 の `scope` に `offline_access` を足す（`oauth-resource.ts` の 2 か所と、`test/oauth-auth.test.js`・`test/host-oauth.test.js` の期待値）。手作りの製品にも同じ値が見えるので、今の 5 製品が切れないことも確かめる。
3. **アプリを消すと、その refresh token は止まるか。** 7 章の付け替えは、古い `tpc_` のアプリを Auth0 で消すことに頼る。
   - 合格：消したアプリの refresh token で新しい access token が出ない（Auth0 のログで確かめる）。

## 6. HAB の変更

承認待ち（[導入計画](agent-connection-and-receive.md) 2 章、別スレッドで実装中）に、次の 1 つを足す。最初の案では「コードの追加は要らない」としたが、レビューで次の穴が分かったので撤回する。

- `hostAdminConnect`（`src/host/admin.ts`）は、アドレスがすでにグループに入っていれば、新しい接続を同じグループへ `bindGroup` する。つなぎ直した新しい組を、今のアドレスへ `approve` することはできる。
- ただし、引用した試験（`test/host-admin.test.js`「a fresh connection id rebinds the address in its existing group」）は、古い接続を `disconnect` で外したあとの場合である。DCR のつなぎ直しでは、古い接続の行も結び付けも `active` のまま、承認期限（最長 1 年）まで残る。
- [常用 MCP 接続](../operations/persistent-mcp-auth.md)は、止めるときに host 側の `revoked` と Auth0 側の取り消しの両方を求めている。Auth0 でアプリを消すだけでは足りない。
- `hab:admin disconnect` はグループの全接続を外すので、今つながっている手作りの接続まで止めてしまう。台帳を手で書き換えるのは、承認待ちでなくしたい手作業そのものであり、書き損じると台帳全体が読めなくなる（同じ組の重複や 100 行超えで `parseOAuthConfig` が失敗する）。

**足すもの：`hab:admin revoke --connection <connection_id>`。** 1 つの接続だけを止める。2026-11-21 に実装した（`src/host/admin-pending.ts` の `hostAdminRevoke`、`src/host/admin.ts` の `hostAdminRevokeBinding`、試験は `test/host-participation.test.js` の「DCR plan 6」）。

1. 台帳を読む前に `approve` と同じ台帳単位のプロセス間書き込みロックを取る。host と同じ規則で台帳を読み、設定された ingress のリソースと照合する。その行を `state: revoked` にし、バックアップを取って一時ファイルから置き換える。Registry の結び付けを外すまで、同じロックを持つ。`connect` も接続を読み直して結び付けるまで同じロックを使う。
2. Registry のその接続の結び付けだけを `revokeGroupBinding` で外し、グループの他の接続は残す。
3. どちらかが済んでいれば飛ばすので、途中で止まっても再実行で揃う。

つなぎ直しの片付けにも、試験の戻し方にも、このコマンドを使う。`approve` に付け替え用の引数は足さない（コマンドを 1 つにする）。

テスト（`test/host-participation.test.js`）：古い接続が `active` のまま新しい接続を同じアドレスへ承認できること。`revoke --connection` のあと古い組の token が断られ、新しい組とグループの他の接続は通ること。台帳だけ済んだ状態からの再実行で揃うこと。同じ台帳で新しい組の `approve` と古い接続の `revoke --connection` を並行実行しても、承認と失効の両方が残ること。

承認待ちを実装するスレッドに伝えること：

- `approve` が `hostAdminConnect` の既定の操作（5 つ全部）で呼ぶと、すでに絞ってあるアドレスの操作が広がる。すでに接続のあるアドレスへの `approve` では今の操作を保つ。
- 台帳の行を足したあとで結び付けが失敗した場合、再実行が同じ組の行を二重に足さないこと（重複は台帳全体を壊す）。
- 承認待ちが 32 行で埋まったときの扱いを決めること（見知らぬ主体の行で本人の行が押し出されないように）。

## 7. リスクと抑え方

| リスク | 抑え方 |
| --- | --- |
| 登録の口は token なしで誰でも使える（Auth0 自身が警告）。その間に登録されたアプリは閉じたあとも使える | 開く前に Applications の `tpc_` の一覧を控え、閉じたあとに比べる。削除対象は試験で作ったことを client ID で確認できたアプリに限る。由来が不明なアプリがあれば、運用者が確認するまで次の試験を保留する |
| 表示名や登録 callback だけで承認すると、利用者が意図した製品とは別のクライアントを通すおそれがある。登録者は複数の callback URL を指定できる | 利用者が対象製品から開始した認可要求で、client ID と実際の redirect URI を確認する。client ID は承認待ちの行と照合する。Auth0 に登録された callback URL 全体は、その製品用に確認した URL の集合と完全一致させ、実際の redirect URI がその集合に含まれることも確認する。証拠が得られない製品は承認を保留し、手動登録を使う |
| 偽のアプリを今のアドレスへ承認すると、ADR-014 によりグループの全アドレスを使われる（同じグループ内のなりすましの許容は、グループの正当な仲間についての判断である） | つなぎ直しと分かっているとき以外は、新しいアドレスに承認する |
| つなぎ直しのたびに台帳の行（上限 100）と Registry の結び付け（例の設定で `max_bindings` 40）を 1 つずつ使い、止めた行も消さない決まりなので、いずれ上限に当たる | つなぎ直しは製品の画面でコネクタを外して入れ直したときだけ起きる見込みで、件数は少ない。`hab:admin status` の件数を見て、上限の 8 割に近づいたら、止めた行の整理の方針を別に決める |
| 製品が要る scope を取れない（ChatGPT の `openid`、Grok の識別用 scope） | 試験で 1 製品ずつ確かめる。だめな製品は手作りのアプリのまま（手順書に両方を残す） |
| DCR を閉じ忘れる | 4 の確かめ方（`registration_endpoint` の有無）を手順の最後に置く |

なりすまし対策（DPoP など）は本人の判断（2026-11-14）で範囲外のまま。

CIMD（製品の公開 URL を client ID にする）なら、誰でも使える登録の口・偽のアプリ・`tpc_` の片付け・つなぎ直しごとの増加がまとめて無くなる。claude.ai と ChatGPT は、認可サーバーが CIMD を広告すれば DCR より優先する。Auth0 の自動登録の CIMD は Early Access で、無料プランで使えるかは未確認。本人の判断は DCR なので、ここでは比べた結果だけを残す。

## 8. 進め方

1. この文書の了承。
2. 承認待ち（導入計画 2 章）の実装を待ち、6 章の `revoke --connection` を足す。
3. 本人の了承を得て Auth0 の 1〜3 を設定する。
4. 試験は、使い捨てのアドレス（例：`dcr-trial@claude.hab`）と新しいグループで行う。今のアドレスと手作りの接続には触らない。
   1. `tpc_` の一覧を控え、DCR を開き、claude.ai に 2 つ目のカスタムコネクタとして HAB を足してログインする。
   2. DCR を閉じ、閉じたことを確かめて一覧を比べる。承認前に、試験用 client ID の要求が HAB の 5 scope を満たし、`pending` に現れることを確かめる。見えなければ監査理由と Auth0 の API 設定を確認して試験を止める。7 章の client ID と callback URL の照合が済んだら `approve` し、5 章の問い 1（同じ client ID で通るか）を記録する。
   3. 10 分以上おいて、問い 2（refresh token）を確かめる。
   4. 一覧を控えて DCR をもう一度開き、コネクタを外して入れ直す。登録後は DCR を閉じて一覧を比べる。新しい組も手順 4.2 の照合条件を満たしたら、同じ試験用アドレスへ `approve` する。古い試験接続を `revoke --connection` し、記録した client ID のアプリを消して、問い 3 を確かめる。
5. ChatGPT・Grok・Muse は、claude.ai の結果を見てから、それぞれの試験用アドレスで同じ手順を行う。今の接続のつなぎ直しでは試さない。
6. 結果を ADR として `hab-decisions.md` に、手順を[設定手順書](../connections/agent-setup.md)に書く。共通の準備 2 を「DCR でつなぐ（既定）」と「手でアプリを作る（DCR が通らない製品）」に分ける。

戻し方：DCR を閉じる。試験で作ったことを client ID で確認できた `tpc_` のアプリを Auth0 で消し、試験の接続を `revoke --connection` で止める。必要なら 4 章の 1・2 を戻す。手で作ったアプリと今の接続には触らないので、そのまま動く。
