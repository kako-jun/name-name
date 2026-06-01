# 実装ガイドライン（name-name ハウスルール）

このディレクトリは name-name のコードを書く・直す・レビューするときの**判断基準**を置く。
「システムがどう組まれているか」は [`docs/architecture.md`](../architecture.md) と [`docs/adr/`](../adr/) が正本。
ここは「**どう書くべきか・何を守るか**」を扱う（重複させない、相互参照する）。

> 方法論の出所はフリーザの `/game-doctrine` スキル（全 PixiJS ゲーム共通）。
> このファイルはその name-name 適用版。汎用論ではなく **name-name の実体に即した規約**を書く。
> ガイドラインは固定資産ではなく**成長資産** — 実装中に気づいた改善はここに追記し続ける。

## 6 つの規律（name-name での具体形）

### 1. docs を正本にする
- セッションをまたぐと AI は全体像を読み直す。コード・記憶だけに頼らず、設計判断は `docs/` に書く
- 大きな設計判断は ADR（`docs/adr/`）、システム構成は `architecture.md`、実装規約はここ、計画は `docs/roadmap/`

### 2. マスタ／ドメイン分離 ✅ 既に守られている — 崩さない
- **マスタ（不変定義）**: `*Def` で命名統一（`MonsterDef` / `ItemDef` / `SpellDef` / `PartyMemberDef`、`frontend/src/types.ts:77-142`）。parser 側は `parser/src/master.rs` の `[モンスター…]` 等ブロック解析が正本
- **ドメイン（実行時状態）**: `NovelGameState`（`frontend/src/game/GameState.ts`）、`RPGProject` の実行時フィールド
- **規約**: 新しいゲーム要素を足すときも「不変定義は `*Def`、実行中に変わるものは GameState 配下」を守る。マスタ型に可変状態を混ぜない
- **データと処理を同時に作らない**: 型（構造）を先に確定し、それを使う処理は別ステップで実装する

### 3. GameState 完全シリアライズ + 任意局面起動 ⚠️ 内部は達成・public API が未提供
- `NovelGameState` は JSON 化可能なプレーンオブジェクト。演出の中間状態（フェード途中・タイプライター途中）は持たない（ADR 0002）
- `applyState(state)` で任意状態に復元できる（現状 private、`NovelRenderer.ts`）
- **public API 化の進捗**: `playScript(steps)`（#220 Phase 1）は実装済み — 操作列を決定論的にリプレイ（再入ガード + msPerChar 退避復元、vitest 17 ケース）。残ギャップ: `startFrom(sceneId, flags)`（Phase 2）/ URL クエリ（Phase 3）。`docs/roadmap/` 参照
- **新規レンダラ/モードを作るときの完了条件**: 「任意の state から `applyState` 相当で起動できる」ことを満たす。これは設計品質の**機械的な検証点**（状態と描画が分離できている証明）

### 4. 単一責務／網状依存の禁止 ⚠️ god-object 傾向あり
- **現状のリスク**: `NovelRenderer.ts` 1874行・`RaycastRenderer.ts` 1857行・`TopDownRenderer.ts` 925行・`DialogBox.ts` 856行。レンダラが描画・音声・セーブ・UI を抱える肥大化傾向
- **守るべき手本**: `raycastProjection.ts` / `mapValidation.ts` のように**純粋関数を切り出してユニットテストする**パターンは既に効いている。PixiJS 描画と計算ロジックを分け、計算側を pure 関数 + テストにする
- **規約**: レンダラに新機能を足すときは、計算部分を `*Projection.ts` / `*Validation.ts` 等の純粋関数に切り出してから配線する。レンダラ本体に数式を直書きしない
- 大きいファイルへの追記は「また 1874 → 1900 行」になりがち。**追記の前に切り出せる純粋関数がないか**を必ず問う

### 5. 設計先行の二段構え
- roadmap の各 task は「①詳細を記載 → ②理想設計を追記（互換性維持のためのバイパスはしない）→ ③実装」の順で進める
- 先に理想構造を確定させると、AI は既存構造への修正で力を発揮できる。設計と実装を一度に振らない

### 6. セルフレビューで guidelines を育てる
- 実装中に気づいた規約・落とし穴はこのファイルに追記する
- 区切りごとにセルフレビューを回し、結果を `docs/self-review/` に残す（下記プロンプト参照）

## セルフレビュー用プロンプト

実装後・PR 前に、以下を自分（またはサブエージェント）に問う:

```
この変更を name-name のガイドラインに照らしてレビューせよ。各観点で違反があれば file:line で指摘:
1. マスタ(*Def)に可変状態を混ぜていないか / GameState にマスタ定義を持ち込んでいないか
2. 追加した状態は NovelGameState に集約され、applyState で復元可能か（演出中間状態を持ち込んでいないか）
3. レンダラ本体に計算ロジックを直書きしていないか（純粋関数に切り出してテストすべきでないか）
4. 1モジュールが多責務を抱えていないか / 網状依存を増やしていないか
5. 設計（構造）と実装を同じ手で雑に混ぜていないか
6. テストはあるか（特に切り出した純粋関数の境界値）
should/nit も含め全件挙げよ。スコープ外として放置しない。
```

## 関連
- システム構成: [`../architecture.md`](../architecture.md)
- 状態管理の設計思想: [`../adr/0002-deterministic-state-and-debuggability.md`](../adr/0002-deterministic-state-and-debuggability.md)
- 計画: [`../roadmap/`](../roadmap/)
- レビュー記録: [`../self-review/`](../self-review/)
