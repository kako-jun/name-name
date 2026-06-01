# ロードマップ

実装計画を phase → task で整理する。**進捗の正本は GitHub Issue と `notes/dev/name-name.md`**。
ここはそれを「設計先行で進めるための構造」に整理した補助ビュー（細かい Issue 進捗をここに二重管理しない）。

各 task は設計先行の二段構えで進める: ①詳細記載 → ②理想設計追記（互換バイパスなし）→ ③実装。

## Phase: 決定論的デバッグ API の公開（最優先・設計と実装のギャップ解消）

ADR 0002 で設計済みだが public API が未提供。内部 `applyState` は達成済みなので、**設計価値を外に出す**段階。

- [x] **`playScript(steps)` API**（Issue #220 Phase 1）— クリック操作列を配列で受けて決定論的に状態を進める。再入ガード + 再生中 msPerChar=0 / 完了・例外時に復元。vitest 17 ケース。2026-06-01 実装（`NovelRenderer.playScript`、`Step` 型は `GameState.ts`）
- [ ] **`startFrom(sceneId, flags)` API**（Issue #220 Phase 2）— 任意状態から起動。長いシーンの後半から開発を始められる
- [ ] **URL クエリでデバッグ起点指定**（Issue #220 Phase 3、`import.meta.env.DEV` 限定）— `?debug_scene=…&debug_flags=…&debug_script=…`

**完了の機械的検証点**: 「コード1行 / URL 1本で特定局面を再現できる」。これが満たされれば規律3（任意局面起動）が public に達成される。

## Phase: レンダラの責務分割（god-object 傾向の解消）

肥大化したレンダラから計算ロジックを純粋関数に切り出す。`raycastProjection.ts` / `mapValidation.ts` が手本。

- [ ] `NovelRenderer.ts`（1874行）— 描画・音声・セーブ・UI 統合の責務過多。切り出せる純粋計算（レイアウト・遷移判定等）を特定して `*.ts` + テストに分離
- [ ] `RaycastRenderer.ts`（1857行）— 射影・床/壁/段差計算は `raycastProjection.ts` に切り出し済み。残る描画オーケストレーションの分割余地を評価
- [ ] `TopDownRenderer.ts`（925行）/ `DialogBox.ts`（856行）— 同様に評価

**進め方**: 一気に割らない。新機能追加のたびに「その部分だけ純粋関数化」する漸進リファクタを規約化（ガイドライン規律4）。

## Phase: 下流ゲームへの展開

name-name は基盤。下流（ogurasia / friday-1930 / skirts-colour / gymnasia 等）が動くことが価値。

- [ ] 下流ごとの parser スモークテスト fixture を追加（friday-1930 は導入済み、`parser/tests/fixtures/`）
- [ ] 各下流ゲームにも `/game-doctrine <project> init` を適用して docs を整える

---

> このロードマップは進捗で陳腐化する。Issue / `notes/dev/name-name.md` と乖離したら、ここは構造だけ残して詳細はそちらへ寄せる。
