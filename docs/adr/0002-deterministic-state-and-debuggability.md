# ADR 0002: 決定論的状態管理とデバッグ可能性

- 起票日: 2026-05-11
- ステータス: Accepted
- 関連 Issue: #220

## Context（背景）

ノベルゲームエンジンは「テキストを順番に表示し、選択肢で分岐する」という構造を持つ。
素朴な実装では「クリックを N 回繰り返せばシーン X に到達する」という手順でしか
特定状態を再現できない。バグ報告を受けた場合、開発者は手動で同じ操作を繰り返す
必要があり、再現コストが高い。

name-name ではこの問題を設計原則として解決する。

## 設計原則: ゲーム状態は完全にスナップショット化できる

ノベルゲームの「状態」は以下の情報で完全に表現できる:

```typescript
interface NovelGameState {
  sceneId: string | null       // どのシーン
  eventIndex: number           // そのシーンの何番目のイベント
  textIndex: number            // そのイベントの何行目
  flags: Record<string, FlagValue>  // フラグ（選択肢の結果等）
  backgroundPath: string | null     // 表示中の背景
  isBlackout: boolean               // 暗転中か
  characters: Array<{ name, expression, position }>  // 立ち絵
  currentBgmPath: string | null     // BGM
}
```

BGM / SE のフェード途中、タイプライターアニメーション中、フェードイン中といった
**演出の中間状態**はスナップショットに含めない。スナップショットは「次のユーザー操作
を待っている安定した状態」のみを表現する。

この設計により:

- `applyState(snapshot)` を呼ぶだけで任意の状態を完全再現できる
- セーブ/ロードはスナップショットの JSON シリアライズそのもの
- 巻き戻し（goBack）はスタックから前のスナップショットを取り出すだけ
- シークバーは各テキストイベントに対応するスナップショットへのランダムアクセス

## 設計原則: 操作列は決定論的に状態を生成する

同一の初期状態と操作列（advance × N、choice → sceneId）を与えれば、
環境に関わらず同一のゲーム状態に到達する。

```
初期状態 + [advance, advance, choice('1-3'), advance] → 決定論的な状態 S
```

これは `resolveEvents` がフラグ状態に対して純粋関数であることと、
`advance()` / `jumpToScene()` が副作用を `NovelGameState` に集約していることで保証される。

この性質を活用すると:

1. **バグの再現**をコード1行で記述できる
2. **テスト**で特定シーンの特定行の状態を assert できる
3. **URL クエリ**でデバッグ起点を共有できる

## Decision（決定）

### 1. スナップショット方式を状態管理の唯一の手段とする

`NovelRenderer` は内部状態を `NovelGameState` のみで表現し、
`applyState(state)` で任意の状態に遷移できることを保証する。

副作用（BGM・立ち絵フェード等）はスナップショット復元時に即時状態から再開する
（フェード途中は持たない）。

### 2. `playScript(steps)` API を提供する（#220 Phase 1）✅ 実装済み（2026-06-01）

クリック操作列を配列として受け取り、決定論的に状態を進める API。
タイプライターをスキップ（msPerChar=0）して高速実行する。
実装: `NovelRenderer.playScript`、`Step` 型は `GameState.ts`。再入ガード（実行中の再呼び出しは throw）+ 完了・例外時の msPerChar 復元（try/finally）。`wait` ステップを追加（将来の非同期イベント待機用）。vitest 17 ケース。

```typescript
type Step =
  | { type: 'advance' }
  | { type: 'choice'; jump: string }
  | { type: 'wait'; ms: number }  // 非同期イベント待機

await renderer.playScript(steps: Step[]): Promise<void>
```

用途:
- バグ再現スクリプトをコードで記述・共有する
- vitest テストで特定シーンの状態を assert する

### 3. `startFrom(state)` API を提供する（#220 Phase 2）✅ 実装済み（2026-06-01）

sceneId と flags を直接指定して任意の状態から開始する API。
history はリセットされる（デバッグ用）。
実装: `NovelRenderer.startFrom`、`StartFromOptions` 型は `GameState.ts`。`loadFromSaveData` を手本に `applyState` を再利用。flags は置換セマンティクス、不正 sceneId は完全 no-op（検証を flags 適用より先に行う）、eventIndex/textIndex は範囲チェックなし（呼び出し側責任）。vitest 25 ケース。

```typescript
renderer.startFrom({
  sceneId: string
  flags?: Record<string, FlagValue>
  eventIndex?: number  // 省略時 = 0
  textIndex?: number   // 省略時 = 0
}): void
```

用途:
- 特定フラグ組み合わせの分岐を直接開く
- 長いシーンの後半から開発を始める

### 4. URL クエリによるデバッグ起点指定（#220 Phase 3、開発環境限定）

```
?debug_scene=1-2&debug_flags=saw_characters:true
?debug_script=advance,advance,choice:1-1
```

`import.meta.env.DEV` の場合のみ有効。本番では無視する。

## Consequences（影響）

### 利点

- バグ報告に「再現スクリプト」を添付できる
- テストで UI を模したシナリオ検証が可能
- 「ランダム要素がないから再現できるはず」という前提をコードで保証する

### 制約

- スナップショットに含めない状態（BGM フェード量、立ち絵フェード進捗）は
  巻き戻し・シーク後に「開始状態」にリセットされる（許容する）
- `playScript` はブラウザの DOM イベントを発火しない（`handleAdvance` を
  呼ばず `advance()` を直接呼ぶ）。イベントリスナー周りのバグは別途テストが必要

## 関連

- `GameState.ts`: `NovelGameState` 定義
- `NovelRenderer.ts`: `applyState`、`seekTo`、`advance`、`jumpToScene`
- `docs/architecture.md`: 「状態管理: NovelGameState」セクション
- Issue #220: `playScript` / `startFrom` 実装
