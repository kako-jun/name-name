---
name: resume-demo
description: 状態を用意して起動する。セーブ JSON を localStorage に入れ /play/sit-by-me?resume=0（旧経路は field.html?resume=0&config=<世界設定のURL>）で任意の局面（パーティ・所持品・現在地・戦闘中）から再開して確認する。デモ・不具合再現・機能の実機確認に使う
---

任意の局面をセーブ JSON として先に用意し、そこから再開して確認する。専用のサンプルマップや `?fixture=dummy` の入口は無い（#1051 で廃止）。現行の読み先は `/play/sit-by-me`（#1144）で、入口は sit-by-me の `play/README.md`（再開点の一覧・手順）、サンプルMAPの仕様の入口は同 `docs/demo/README.md`。

**正本は [docs/guide/resume-demo.md](../../../docs/guide/resume-demo.md)**。書式・例・持ち越し規則・未対応事項はそこを読む（ここには再掲しない）。

## 手順

1. セーブ JSON を用意する（形式は `frontend/src/game/rpgSave.ts` の `RpgSaveState`。書き方と例は正本の「セーブの書き方」）
2. localStorage のキー `name-name-save-sit-by-me-<slot>`（現行）に入れる。sit-by-me の再開点は `play/saves/<再開点ID>.save.json`
3. `/play/sit-by-me?resume=0`（slot 0。`1` / `2` / `quick` も可）で開く。**旧経路**: キー `name-name-save-field-<slot>` ＋ `field.html?resume=0&config=<世界設定のURL>`（`?config=` は必須で同梱の既定設定は無い。寺町の世界設定は現在無いので、そのままでは動かない）
4. `window.field.rpg()` で今の局面をセーブ形式で読み、意図どおりか確認する（`saveRpg(slot)` で書き戻せる）

## 自動操作の注意

- playwright は node 直起動（MCP / CDP は不可）。rAF と `performance.now` は仮想時計で進める
- 他者のプロセス・8765 番ポートを止めない（衝突したら空きポートを使う）
- sit-by-me のルートを CORS 付きで配信して素材を読ませる
- 本番ビルドを静的配信して確認する。symlink worktree の dev サーバーでは実検証しない
- TUI/実機の最終判定は kako-jun 本人

## 機能別の確認例

- 刀: 正本「刀の確認」(#1035)。旧経路の手順で、寺町セーブの読み込み先の世界設定が現在無いので、そのままでは成り立たない（現行は `/play/sit-by-me` の再開点）
- 台帳に定義が無い機能（状態異常・敵レベル・装備のアビリティ等）はデモを作らず、vitest で確認する。実際の設定＋実際のセーブの確認（旧経路）: 正本「実際の設定＋実際のセーブでの確認」(#1051)
