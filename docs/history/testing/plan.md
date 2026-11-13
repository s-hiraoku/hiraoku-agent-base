# Delivery lab作業計画

- [x] Read the Principles section of the poteto-mode skill.
- [x] Phase A: Frame. main d83ad6eで合成配送の欠落・重複・漏洩を検出できることを完了条件にする。
- [x] Phase B: Design the workflow. 既存baseline、共通契約8件、SQLite障害4件、ランナーの順。製品backend自体は変更しない。
- [x] 既存100テストのbaselineを専用SSD checkoutで保存する。
- [x] 共通契約、障害注入、隔離ランナーを実行して修正する。
- [x] 全JS回帰、lint、typecheck、Python既存検証を実行する。最終変更後のrunを別途保存する。
- [x] Phase D: Keep the audit trail. 各判断と実行証拠をdecisions.tsvへ追記する。
- [x] Phase E: Verify and hand back. diff、実行結果、未実装gate、patchを確認する。

規模は新規test/fixture/runnerと手順書の約15ファイル。既存回帰を再利用し、個人/本番設定、別checkout、CIへのpushは変更しない。新しい製品仕様やbroker設定を決める設計作業は含めない。pstack更新保留は解除済み。更新前後ともpstack本体を変更していない。

ArchitectのGroundはhowの説明、Sketchは独立3候補、Agreeはcheckpointなしで比較、Implementは採用改善の反映、Scrapは構造を維持できたため不要とした。ArenaはFrame、Fan out、Cross-judge、Pick、Graft、Verifyを独立agentの成果と実行結果で照合した。設定は全laneがinherit-parentで、cross-family reviewではない。最初のコード作成前には全phaseを実行できていない点を残す。
