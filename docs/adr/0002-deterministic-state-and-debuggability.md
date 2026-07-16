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
実装: `NovelRenderer.startFrom`、`StartFromOptions` 型は `GameState.ts`。`startFrom` は 2 経路に分岐する（#399）: **`eventIndex=textIndex=sentenceIndex=0`（本番の `?scene=` は常にこれ）は通常入場と同じ fresh-start 経路**（`gameState.fromJSON(flags)` → `startScene` → `resetAndStartEvents`）に乗せ、冒頭の `[背景:]`/`[BGM:]` を実行し最初の話者の立ち絵を出してから最初のテキストで止まる。**`eventIndex>0` 等の途中局面指定（DEV の `debug_scene`）だけ**、宣言的復元コア private `restoreToScene(scene, state)`（フラグ設定 → 選択肢/待機リセット → resolveEvents → applyState → history リセット → render）にフォールバックする。この `restoreToScene` は `loadFromSaveData`（セーブ復元＝完成 state を持つ）と共通化済み（#256）。従来は startFrom も常に restoreToScene を通していたため冒頭ディレクティブが実行されず、埋め込み開始時に背景も立ち絵も出ず `eventIndex=0` で止まっていた（#399 の症状）。fresh-start 経路は `resetAndStartEvents` が index を 0 にリセットしてしまうため途中局面を再現できず、そのため index 指定時だけ `restoreToScene` に倒す。シーン探索と「見つからない場合の挙動」は呼び出し側の責務で、`startFrom` は不正 sceneId で完全 no-op（フラグも復元しない）、`loadFromSaveData` はシーン欠落時もフラグだけ復元する。flags は置換セマンティクス、検証を flags 適用より先に行う、eventIndex/textIndex は範囲チェックなし（呼び出し側責任）。vitest 30 ケース（#399 の fresh-start 経路 3 ケースを追加）。

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

### 4. URL クエリによるデバッグ起点指定（#220 Phase 3、開発環境限定）✅ 実装済み（2026-06-01）

```
?debug_scene=1-2&debug_flags=saw_characters:true
?debug_script=advance,advance,choice:1-1
```

`import.meta.env.DEV` の場合のみ有効。本番では無視する。
実装: 純粋パーサ `frontend/src/game/debugQuery.ts` の `parseDebugQuery(search)` が `{script}` / `{scene}` / `null` を返し、`NovelPlayer.tsx` が `setScenes` 後に DEV ガード付きで `playScript`/`startFrom` を呼ぶ。`debug_script` 優先。vitest 20 ケース。**これで #220 の全 Phase（1 playScript / 2 startFrom / 3 URL クエリ）が完了。**

### 5. `?scene=` ディープリンク + confinement（在圏）+ 終劇（`storyEnded`）（#386、production 対応）✅ 実装済み（2026-07-04）

Phase 3 の `debug_scene` は開発環境限定のデバッグ起点だった。production でも常時有効な
「特定シーンへの直接ディープリンク」は別系統として追加する。両者の違い:

| | `debug_scene`（#220 Phase 3） | `?scene=`（#386） |
| --- | --- | --- |
| 有効ビルド | DEV のみ（`import.meta.env.DEV`。production は配線ごと tree-shake） | production 含め常時 |
| 指定できる状態 | scene + flags + eventIndex + textIndex | scene（sceneId）のみ |
| 用途 | バグ再現・デバッグ起点の共有 | 特定シーンの直接埋め込み（theo-hayami の会話劇セル1本を外部ページに埋め込む用途） |
| パーサ | `debugQuery.ts` の `parseDebugQuery` | `sceneQuery.ts` の `parseSceneQuery` |
| 遷移範囲 | 無制限（通常のハブ経由フローと同じ） | 対象ファイル自身に confinement（在圏）される |

`NovelPlayer` は両方を配線するが、`initialSceneId`（`?scene=` 由来）を `debug_scene` ブロックより
前に評価するため、DEV で両方指定された場合は `debug_scene` が後勝ちで優先される（デバッグ目的の
上書きを production 経路より優先させる）。

`?scene=` 単独埋め込みは対象ファイル外（hub・他ファイル）への choice ジャンプを許さない
（theo-hayami #20: 他ファイルへの遷移は choice ではなく埋め込み外側の HTML リンクで行う設計）。
`PlayerScreen` が対象ファイル自身の sceneId 一覧（entry doc/hub 自身は除く）を
`NovelRenderer.setConfinedSceneIds` に渡す。圏外への遷移を検知すると通常のシーン遷移をせず
`endStory()` を呼ぶ。終劇の判定箇所は 2 つある: **選んだ jump 先**が圏外なら `jumpToScene`
（choice 確定後）が終劇する。加えて **全 option の jump 先が圏外の `[選択]` に到達した場合**は、
選択肢を描画せず `processDirective` の Choice 分岐で先回りして終劇する（#398）。後者が無いと、
全 option 圏外の choice は「クリックするまで」`jumpToScene` に届かず、`storyEnded` の
postMessage（#395/#397）が発火しないため埋め込み側で既読化されなかった。既読化
（`markCurrentSceneRead`）を済ませてから終劇するので、選択肢を出さずに完読を通知できる。
`?scene=` が hub 自身の sceneId を指した場合は confinement を組まず無制限フローにフォールバック
する（`confinedSceneIds === null` では両判定とも短絡しない。hub → 各お題への通常 choice 遷移を
壊さないため）。

`endStory()` は `NovelGameState.storyEnded` という**宣言的フラグ**を true にする。この設計は
本 ADR の核心（演出の中間状態を持たない・完全にシリアライズ可能）にそのまま従う: 背景・立ち絵の
フェードアウト自体は一度きりの見た目でしかなく、状態として確定するのは「背景も立ち絵もない
終劇後」という終端値だけである。`getSnapshot()`/`applyState()` は他のフィールドと同様に
`storyEnded` をそのまま往復し（goBack/seekTo/startFrom/loadFromSaveData いずれも即時反映、
フェードの再生はしない）。ただしセーブだけは例外で、`saveSlotToGameState` は常に `false` を返す
（セーブは終劇状態を持ち越さない設計。終劇後の eventIndex をそのままセーブすると、ロード時に
「`storyEnded=false` なのに choice イベント位置で止まっている」行き止まりになるため）。
`quickSave()`/`openSaveMenu()` は `storyEnded` 中は no-op（終劇後のセーブによる行き止まり防止）、
`quickLoad()`/`openLoadMenu()` は許可する（脱出手段として維持）。

実装: `frontend/src/game/sceneQuery.ts`（`parseSceneQuery`）、`frontend/src/game/sceneConfinement.ts`
（`isSceneIdConfined`）、`NovelRenderer.setConfinedSceneIds`/`endStory`/`setOnStoryEndedChange`、
`PlayerScreen.findConfinedSceneIds`。

**追記（#404、2026-07-16）**: `endStory()` の見た目は intermission.md 専用シーン（`assets/scripts/
intermission.md`。プロジェクト opt-in）の有無で分岐するようになった。ただし `storyEnded` を
宣言的フラグとして扱う本節の設計原則（演出の中間状態を持たない・GameState には持ち込まない）は
そのまま——intermission タブローも一度きりの見た目でしかなく、セーブ/シーク対象にはしていない。
詳細は `docs/architecture.md` の「confinement（在圏）+ 終劇」節を参照。

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
- `NovelRenderer.ts`: `applyState`、`startFrom`（`eventIndex=0` は `startScene` の fresh-start 経路、#399）、`restoreToScene`（startFrom の途中局面指定 / `loadFromSaveData` 共通コア）、`seekTo`、`advance`、`jumpToScene`、`processDirective`（Choice 短絡での終劇、#398）、`setConfinedSceneIds`、`endStory`
- `frontend/src/game/sceneQuery.ts` / `frontend/src/game/sceneConfinement.ts`: `?scene=` パーサ・confinement 判定（#386）
- `docs/architecture.md`: 「状態管理: NovelGameState」セクション、「production 向けシーン直接ディープリンク `?scene=`」セクション
- `docs/guide/debugger.md`: `debug_scene`（DEV 専用）の使い方ガイド
- Issue #220: `playScript` / `startFrom` 実装
- Issue #256: `startFrom` / `loadFromSaveData` の状態復元コア共通化（`restoreToScene`）
- Issue #386: `?scene=` ディープリンク + confinement + 終劇（`storyEnded`）
- Issue #398: 全 option 圏外の `[選択]` は描画せず `processDirective` の Choice 分岐で先回りして終劇する
- Issue #399: 埋め込み開始（`?scene=`, `eventIndex=0`）を fresh-start 経路に乗せ、冒頭ディレクティブ実行＋立ち絵表示を通す
