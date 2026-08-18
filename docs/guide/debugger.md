# デバッグガイド（決定論的デバッグ API）

Name×Name のノベルプレイヤーは、**任意のシーン・状態を URL 1 本／コード 1 行で再現**できる。
「フェードの途中」「タイプライタ表示中」のような演出の中間状態を持たない設計（[ADR 0002](../adr/0002-deterministic-state-and-debuggability.md)）なので、`sceneId` + フラグ + インデックスだけで局面が一意に決まる。バグ報告の再現・特定シーンの作業に使う。

エディタ／プレイヤーの基本操作は [操作ガイド](./controls.md)・[エディタガイド](./editor.md) を参照。

> **`?scene=` との違い**: このページで扱う `debug_scene` 系クエリは production ビルドでも常時
> 有効なデバッグ起点（#652）。sceneId 単体のみ指定できる production 向けの特定シーン直接
> ディープリンクは `?scene=<sceneId>`（#386）で、別系統・別パーサ（`sceneQuery.ts`）。
> `?scene=` は対象ファイル自身に confinement（在圏）されて hub 等の圏外へは「終劇」扱いになるが、
> `debug_scene` は confinement なしで任意のシーンへ遷移できる（1ルートが複数ファイルに分割された
> 構成の実機デバッグ用）。詳細は [`docs/architecture.md`](../architecture.md) の「production 向け
> シーン直接ディープリンク `?scene=`」セクションと
> [ADR 0002](../adr/0002-deterministic-state-and-debuggability.md) を参照。
>
> **隠蔽についての設計方針（#652）**: `debug_scene` 系クエリは有効化条件・認証を持たない。
> 「知らなければ踏まない URL パラメータ」自体が十分な隠蔽であるという kako-jun確定の判断による
> （過剰な設計を避ける）。

## URL クエリで起点を指定する（production ビルドでも常時有効）

`scenes` を渡す経路（`setScenes`）でのみ動く（`NovelPlayer.tsx`）。#652 以前は
`import.meta.env.DEV` ガード付きで dev ビルド限定だったが、gymnasia のような1ルートが複数
ファイルに分割された構成の実機デバッグのため production ビルドでも常時有効化した。

開発サーバー（`npm run dev`）に限らず、本番デプロイ先の URL にも以下のクエリを付けられる。

| クエリ | 意味 | 例 |
|---|---|---|
| `debug_scene` | 開始シーン ID（confinement なし。ファイル境界を無視して直接遷移） | `?debug_scene=1-2` |
| `debug_flags` | 開始時に立てるフラグ（`key:val` をカンマ区切り） | `&debug_flags=saw_characters:true,gold:100` |
| `debug_eventIndex` | 開始イベント index（省略時 0） | `&debug_eventIndex=3` |
| `debug_textIndex` | 開始テキスト index（省略時 0） | `&debug_textIndex=2` |
| `debug_script` | クリック操作列を自動再生（カンマ区切り） | `?debug_script=advance,advance,choice:2-1` |
| `debug_unlock_all` | `1` で全選択肢の `[条件: flag]` ロックを強制解放（#652） | `?debug_unlock_all=1` |

### 全ルート強制解放（`debug_unlock_all`）

`?debug_unlock_all=1` を付けると、選択肢の `[条件: flag]` ロック判定（`NovelRenderer.ts` の
Choice 分岐）が `option.condition` を一切見ずに全選択肢を選択可能にする。個別のフラグを
`debug_flags=route01_cleared:true,route02_cleared:true,...` のように積んでも同じ効果を得られる
ケースもあるが、どのフラグが必要かを事前に把握せずに全ルートを一括解放できるため、gymnasia の
ような未知/大量のルートフラグを扱う実機デバッグではこちらの方が使い勝手が良い。
`debug_scene`/`debug_flags`/`debug_script` とは独立して評価されるため、通常のハブ経由フロー
（`debug_scene` を使わない起動）でも併用できる。

```
# ハブから通常起動しつつ、以降出会う全選択肢のロックを解除する
http://localhost:5173/play/<id>?debug_unlock_all=1
```

### フラグ値の型推論（`debug_flags`）

`debug_flags` の各値は文字列から自動で型付けされる（`debugQuery.ts` の `toFlagValue`）。

- `true` / `false` → 真偽値（Bool）
- 数値文字列（`100`、`-3` 等） → 数値（Number）
- それ以外 → 文字列（String）。空文字は `0` に化けるのを避けて String 扱い

### `debug_script` のトークン

クリック相当の操作を順に自動再生する。`startFrom`（状態指定）より**優先**される。ただし空・全トークン無効で 0 件になった場合は `debug_scene` 指定にフォールスルーする（空 script が有効な scene 指定を握り潰さない）。

| トークン | 動作 |
|---|---|
| `advance` | 次のテキスト／次のイベントへ進む（クリック1回相当） |
| `choice:<jump>` | 選択肢表示をスキップして `<jump>` 先シーンへ直接遷移 |
| `wait:<ms>` | `<ms>` ミリ秒待つ（将来の非同期イベント用） |

不正トークン（未知の種別、`choice:` で jump 空、`wait:` で数値にならない等）は黙ってスキップされる。

### 例

```
# シーン 1-2 を、saw_characters フラグを立てた状態で開く
http://localhost:5173/play/<id>?debug_scene=1-2&debug_flags=saw_characters:true

# 冒頭から2回クリックして選択肢 2-1 を選んだ局面まで自動で進める
http://localhost:5173/play/<id>?debug_script=advance,advance,choice:2-1

# シーン 3-1 のイベント index 3・テキスト index 2 から再開
http://localhost:5173/play/<id>?debug_scene=3-1&debug_eventIndex=3&debug_textIndex=2
```

> URL のテンプレートは実際のルーティングに合わせて読み替える。重要なのは query string（`?debug_*=...`）の部分。

## コードから使う（テスト・自動操作）

URL クエリは、内部的に `NovelRenderer` の 2 つの public API を呼ぶだけのパーサ（`debugQuery.ts` の `parseDebugQuery`）。同じことをテストや任意のコードから直接呼べる。

### `playScript(steps: Step[]): Promise<void>`

クリック操作列を決定論的に再生する。再生中は `msPerChar=0`（タイプライタ演出を飛ばす）、再入ガードつき。完了・例外時に状態を復元する。

```ts
import type { Step } from '../game/GameState'

const steps: Step[] = [
  { type: 'advance' },
  { type: 'advance' },
  { type: 'choice', jump: '2-1' },
]
await renderer.playScript(steps)
```

`Step` は `GameState.ts` 定義の判別共用体:

```ts
type Step =
  | { type: 'advance' }            // 次のテキスト／イベントへ
  | { type: 'choice'; jump: string } // jump 先シーンへ
  | { type: 'wait'; ms: number }   // ms ミリ秒待つ
```

### `startFrom(opts: StartFromOptions): void`

任意のシーン・フラグ・インデックスから起動する。history をリセットし、flags は**置換**（省略時は空でクリア）。不正な `sceneId` は完全に no-op。

```ts
import type { StartFromOptions } from '../game/GameState'

renderer.startFrom({
  sceneId: '1-2',
  flags: { saw_characters: { Bool: true } },
  eventIndex: 0,
  textIndex: 0,
})
```

```ts
interface StartFromOptions {
  sceneId: string                          // 開始シーン ID
  flags?: Record<string, FlagValue>        // 置換セマンティクス（省略時クリア）
  eventIndex?: number                      // 省略時 0
  textIndex?: number                       // 省略時 0
}
```

## 設計背景

- `startFrom`（途中局面指定・`eventIndex>0`）とセーブ復元は、共通コア `restoreToScene(scene, state)` を経由して状態を宣言的に組み立てる（[#256](https://github.com/kako-jun/name-name/issues/256)）。復元ロジックは 1 本に集約されている。ただし `startFrom` の `eventIndex=0`（本番 `?scene=` 埋め込みの既定）だけは通常入場と同じ fresh-start 経路（`startScene` → `resetAndStartEvents`）に乗り、冒頭の `[背景:]`/`[BGM:]` を実行し最初の話者の立ち絵を出す（[#399](https://github.com/kako-jun/name-name/issues/399)）。
- 「任意の state から起動・再開できる」ことは、状態と描画が分離できている**機械的な証明**でもある。新しいレンダラ／モードを足すときは、この API で任意局面を再現できることを完了条件にする。
- 詳しい設計判断は [ADR 0002 — 決定論的状態とデバッグ容易性](../adr/0002-deterministic-state-and-debuggability.md) を参照。
