---
spec_id: message-relay
version: 1
status: approved
title: HAB ローカルMVPのメッセージ送受信の振る舞い仕様
owner: "@s-hiraoku"
---

## 目的
HAB が、模擬エージェント 3 個体の間で登録・送受信・返信・停止・再開を一つの有限コマンドで再現できることを、ガーデンが変更のたびに確認できるようにします。
詳しい合格条件は [ローカルMVP](../local-mvp.md) の 13 段階表を正とします。

## 受け入れ条件
- **AC-001**: `.node-version` と `package.json` の `packageManager` が指定する Node.js と npm で依存を導入でき、`npm run check:toolchain` が成功する。
- **AC-002**: `node scripts/hab-mvp-demo.mjs --simulate` が終了コード 0 で JSON を返し、13 段階すべてが `passed`、配送 4 件がすべて ACK され（`deliveries == acked == ack_receipts == 4`）、待ち受けの停止と一時状態の削除が記録される。

## 不変条件
- **INV-001**: 確認は実運用の認証情報・実メッセージ・既存の runtime DB を使わず、`production_connected` は常に `false` である。
- **INV-002**: 実行依頼（execution_request）は保存と ACK までで、受信側では実行されない。
