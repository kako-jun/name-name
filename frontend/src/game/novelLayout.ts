/**
 * `NovelRenderer` の純粋計算（幾何・色パース・URL/フォント解決・シーンルックアップ）。
 *
 * `NovelRenderer.ts`（god-object）の肥大トレンド監視と漸進分離 (#260) の一環。
 * 入力→出力が決定論的で、`this` / PixiJS / DOM / TimeController に一切依存しない計算だけを
 * ここに集約する。`screenEffects.ts`（時間→値）/ `raycastProjection.ts`（射影幾何）/
 * `easing.ts` と同じ流儀。NovelRenderer 側は「いつ計算するか」「結果をどの表示オブジェクト・
 * オーディオに当てるか」だけを保持する。
 *
 * 各関数は抽出前に NovelRenderer 内へ直書きされていた式と数値・文字列が完全に一致する
 * （挙動不変）。リファレンス等価性は novelLayout.test.ts で機械的に担保する。
 */

import type { BackgroundFade, NovelGameState } from './GameState'
import type { SaveSlotData } from './SaveManager'
import type { EventScene } from '../types'

/** カバーフィット後の背景スプライト寸法と配置（px）。 */
export interface CoverFit {
  /** sprite.width に設定する表示幅（px） */
  width: number
  /** sprite.height に設定する表示高さ（px） */
  height: number
  /** sprite.x に設定する左上 X（中央寄せのオフセット） */
  x: number
  /** sprite.y に設定する左上 Y（中央寄せのオフセット） */
  y: number
}

/**
 * 背景画像をアスペクト比維持で画面いっぱいに「カバー」し、中央寄せした寸法を返す純粋関数。
 *
 * 元 `NovelRenderer.applyCoverFit` と同一:
 *   scaleX = screenW / texW
 *   scaleY = screenH / texH
 *   scale  = max(scaleX, scaleY)         // 短辺を画面に合わせ、長辺は溢れさせる（cover）
 *   width  = texW * scale
 *   height = texH * scale
 *   x = (screenW - width) / 2            // 溢れた分を左右（または上下）に等分して中央寄せ
 *   y = (screenH - height) / 2
 *
 * `Math.max(scaleX, scaleY)` で「画面を覆う最小倍率」を選ぶため、画像は必ず画面全体を埋め、
 * はみ出した方向は中央でトリミングされる（contain ではなく cover）。
 *
 * NovelRenderer 側はこの結果を sprite.{width,height,x,y} にそのまま代入するだけ。
 * texture サイズと screen サイズはどちらも純粋な数値で、PixiJS Sprite には触れない。
 */
export function computeCoverFit(
  textureWidth: number,
  textureHeight: number,
  screenWidth: number,
  screenHeight: number
): CoverFit {
  const scaleX = screenWidth / textureWidth
  const scaleY = screenHeight / textureHeight
  const scale = Math.max(scaleX, scaleY)
  const width = textureWidth * scale
  const height = textureHeight * scale
  return {
    width,
    height,
    x: (screenWidth - width) / 2,
    y: (screenHeight - height) / 2,
  }
}

/**
 * `#RRGGBB` 形式（またはプレフィックス省略の `RRGGBB`）を PixiJS 用の数値色に変換する純粋関数。
 *
 * 元 `NovelRenderer.parseHexColor` と同一:
 *   clean = hex の先頭 '#' を 1 つだけ除去
 *   n     = parseInt(clean, 16)
 *   結果  = NaN なら 0xffffff（白フォールバック）、それ以外は n
 *
 * `replace('#', '')` は最初の '#' のみ除去する元実装をそのまま踏襲する。
 * `parseInt(_, 16)` の寛容な解釈（途中までパース・先頭空白許容等）も元と一致。
 * 不正値で白にフォールバックするのは Flash/Fade のオーバーレイ色が消えないようにするため。
 */
export function parseHexColor(hex: string): number {
  const clean = hex.replace('#', '')
  const n = parseInt(clean, 16)
  return isNaN(n) ? 0xffffff : n
}

/**
 * CSS カラー文字列（"#1a4a7a" / "#222" / "1a4a7a"）を Pixi の数値カラーに変換する純粋関数 (#270 / #273)。
 *
 * 元は `underline.ts` にあったものを、色解決の純関数置き場であるこのモジュールへ集約した
 * （`parseHexColor` の隣）。下線ビーム（#270）・タイトル文字色（#273）・背景色（#273）が共有する。
 * `underline.ts` は後方互換のためここから re-export する。
 *
 * `parseHexColor` との違い:
 *  - 3 桁短縮形（#222 → #222222）を展開する。
 *  - 純 hex（`[0-9a-fA-F]`）以外（`+1a4a7` 等の符号付き）は fallback に倒す。
 *  - fallback を任意指定できる（`parseHexColor` は白固定）。
 *  - `undefined` を受けたら fallback を返す（「指定なし」を呼び出し側でハンドルしやすい）。
 *
 * 解釈不能なら `fallback` を返す。Math.random など非決定要素は使わない。
 */
export function parseColorToNumber(color: string | undefined, fallback: number): number {
  if (color === undefined) return fallback
  let s = color.trim()
  if (s.startsWith('#')) s = s.slice(1)
  if (s.length === 3) {
    // #rgb → #rrggbb
    s = s
      .split('')
      .map((c) => c + c)
      .join('')
  }
  if (s.length !== 6) return fallback
  // 純粋 hex 16 進数のみ受理する。Number.parseInt は '+1a4a7'/'-1a4a7' のような符号付き
  // 文字列を解釈してしまい fallback に倒れないため、parseInt 前に純 hex 判定で弾く。
  if (!/^[0-9a-fA-F]+$/.test(s)) return fallback
  const n = Number.parseInt(s, 16)
  if (!Number.isFinite(n) || Number.isNaN(n)) return fallback
  return n
}

/** アセット URL の種別。`images/` か `sounds/` のサブディレクトリに対応する。 */
export type AssetKind = 'images' | 'sounds'

/**
 * アセットの相対パスを配信用の絶対 URL に解決する純粋関数。
 *
 * 元 NovelRenderer 内に 5 箇所直書きされていた式を 1 つに集約:
 *   `${baseUrl}/${kind}/${path.replace(/^\//, '')}`
 * 背景画像（images）と BGM/SE/voice/復元 BGM（sounds）で同形だった。
 *
 * `path.replace(/^\//, '')` は path 先頭の '/' を 1 つだけ落とす（`/bgm/a.mp3` →
 * `bgm/a.mp3`）。baseUrl と kind の間・kind と path の間は常に '/' 1 つで連結する。
 * baseUrl 末尾の '/' 正規化はしない（元実装どおり。呼び出し側は baseUrl を末尾スラッシュ
 * なしで渡す前提）。
 */
export function resolveAssetUrl(baseUrl: string, kind: AssetKind, path: string): string {
  return `${baseUrl}/${kind}/${path.replace(/^\//, '')}`
}

/**
 * セーブスロットデータ (`SaveSlotData`) を復元用の `NovelGameState` に変換する純粋関数。
 *
 * 元 `NovelRenderer.loadFromSaveData` 内に直書きされていた state 構築ブロックと同一の
 * フィールド対応・後方互換フォールバックを集約する:
 *   sceneId        = data.sceneId（呼び出し側で非 null を保証してから渡す）
 *   eventIndex     = data.eventIndex
 *   textIndex      = data.textIndex
 *   flags          = data.flags
 *   backgroundPath = data.backgroundPath
 *   backgroundColor = data.backgroundColor ?? null  // 古いセーブには無い → 地色なし (#273)
 *   backgroundFade = normalizedFade（呼び出し側で normalizeBackgroundFade 済みを渡す）
 *   video          = data.video ?? null      // 古いセーブには無い → 動画なし
 *   isBlackout     = data.isBlackout ?? false
 *   characters     = data.characters ?? []
 *   currentBgmPath = data.currentBgmPath ?? null
 *
 * `backgroundFade` の正規化（`normalizeBackgroundFade` / `edgeFadeMask`）は PixiJS を間接
 * 参照するため、このモジュールを PixiJS 非依存に保つ目的で「正規化済みの値」を引数で受け取る。
 * これにより本関数は `data` の読み取りと定数フォールバックだけの純粋写像になる。
 *
 * `data.sceneId` は型上 `string | null` だが、呼び出し側（`loadFromSaveData`）が null を
 * 早期 return で弾いた後に呼ぶ前提。元実装も同じ前提で `state.sceneId = data.sceneId`
 * としていたため、ここでもそのまま代入する（挙動不変）。
 */
export function saveSlotToGameState(
  data: SaveSlotData,
  normalizedFade: BackgroundFade | null
): NovelGameState {
  return {
    sceneId: data.sceneId,
    eventIndex: data.eventIndex,
    textIndex: data.textIndex,
    flags: data.flags,
    backgroundPath: data.backgroundPath,
    backgroundColor: data.backgroundColor ?? null,
    backgroundFade: normalizedFade,
    video: data.video ?? null,
    isBlackout: data.isBlackout ?? false,
    characters: data.characters ?? [],
    currentBgmPath: data.currentBgmPath ?? null,
  }
}

/**
 * フォント解決の優先順チェーンを 1 箇所に集約する純粋関数 (#147 / #260)。
 *
 * 元 NovelRenderer 内で 2 箇所に直書きされていた同形の式:
 *   - `render()`:      `perLineFontFamily ?? this.gameDefaultFontFamily ?? RUNTIME_DEFAULT_FONT_FAMILY`
 *   - `processDirective()` の `TitleShow`:
 *                      `ts.font_family ?? this.gameDefaultFontFamily ?? RUNTIME_DEFAULT_FONT_FAMILY`
 * どちらも「per-line override → per-game default → runtime default」の同じ 3 段フォールバック。
 *
 * `??`（nullish coalescing）の元挙動を忠実に踏襲する:
 *  - `perLine` が `null`/`undefined` のときだけ `perGameDefault` に落ちる。
 *  - `perGameDefault` も `null`/`undefined` のときだけ `runtimeDefault` に落ちる。
 *  - 空文字 `''` は「指定あり」として扱う（`??` は `''` を素通しする。元実装と同じ）。
 *
 * 引数は `string | null | undefined` を受けるが、`runtimeDefault` は必ず非 null の文字列を
 * 渡す前提（元実装の `RUNTIME_DEFAULT_FONT_FAMILY` 定数）。戻り値は常に非 null の family 文字列。
 */
export function resolveFontFamily(
  perLine: string | null | undefined,
  perGameDefault: string | null | undefined,
  runtimeDefault: string
): string {
  return perLine ?? perGameDefault ?? runtimeDefault
}

/**
 * シーンカウンターの表示文字列を返す純粋関数 (#260)。
 *
 * 元 `NovelRenderer.updateCounter` の `this.counterText.text = \`${displayIndex} / ${this.displayEventCount}\``
 * と同一のテンプレートリテラル。`displayIndex`（1-based 現在位置）と `total`（表示イベント総数）を
 * `"{displayIndex} / {total}"` に整形するだけ。数値の書式変換（ロケール・桁区切り等）は一切しない。
 */
export function formatCounterText(displayIndex: number, total: number): string {
  return `${displayIndex} / ${total}`
}

/** SeekBar.update に渡す現在位置と総数。 */
export interface SeekBarPosition {
  /** SeekBar.update の第 1 引数 `current`（0-based。ratio = current/(total-1) で塗り幅を出す） */
  current: number
  /** SeekBar.update の第 2 引数 `total`（表示イベント総数） */
  total: number
}

/**
 * SeekBar に渡す `{current, total}` を算出する純粋関数 (#125 / #260)。
 *
 * 元 `NovelRenderer.updateSeekBar` と同一:
 *   current = Math.max(0, displayIndex - 1)   // 1-based displayIndex を 0-based に変換
 *   total   = displayEventCount
 * SeekBar 側は `ratio = current / (total - 1)` で塗り幅を出すため、`displayIndex` を
 * 1-based のまま渡すと末尾で ratio が 1 を超える。ここで 1 を引いて 0-based に直し、
 * 先頭（displayIndex=0、まだテキスト未到達）でも負にならないよう `Math.max(0, …)` でクランプする。
 */
export function computeSeekBarPosition(displayIndex: number, total: number): SeekBarPosition {
  return { current: Math.max(0, displayIndex - 1), total }
}

/** デバッグ HUD 用に 1 イベントから取り出した種別と本文プレビュー。 */
export interface DebugEventDescriptor {
  /** イベント種別。`Dialog` / `Background` 等のキー名。判定不能は `'(none)'` / `'(unknown)'` */
  kind: string
  /** 本文プレビュー。取り出せないときは `undefined` */
  text: string | undefined
}

/**
 * 1 つの `Event` からデバッグ HUD 用の `{kind, text}` を取り出す純粋関数 (#260)。
 *
 * 元 `NovelRenderer.getDebugState` 内に直書きされていた抽出ロジックと同一:
 *   - object でなければ `kind='(none)'`, `text=undefined`
 *   - object なら `kind = Object.keys(event)[0] ?? '(unknown)'`
 *   - その値 `v = event[kind]` が object のとき、本文を以下の優先順で 1 つ取り出す:
 *       1. `v.text` が長さ 1 以上の配列 → `JSON.stringify(v.text[0]).slice(0, 120)`
 *       2. `v.line` が string → そのまま
 *       3. `v.path` が string → そのまま
 *       4. `v.target` が string → そのまま
 *       いずれにも当たらなければ `text=undefined`
 *
 * `this` / PixiJS / DOM に触れず、入力イベントだけから決定論的に値を導く。HUD 表示専用で
 * ゲーム進行には影響しない。`text` は最大 120 文字に切り詰める元挙動（配列ケースのみ）を踏襲。
 *
 * 引数型を元の `Event` から `unknown` に広げているのは任意入力耐性のため（HUD デバッグ用途で
 * `resolvedEvents` 由来の想定外・不正形なイベントを渡されても落ちず `'(none)'`/`'(unknown)'`
 * に落とす）。内部でガードしてから読むため `unknown` でも安全。
 */
export function describeEventForDebug(event: unknown): DebugEventDescriptor {
  let kind = '(none)'
  let text: string | undefined
  if (event && typeof event === 'object') {
    kind = Object.keys(event)[0] ?? '(unknown)'
    const v = (event as Record<string, unknown>)[kind]
    if (v && typeof v === 'object') {
      const maybeText = (v as { text?: unknown; line?: unknown; path?: unknown; target?: unknown })
        .text
      if (Array.isArray(maybeText) && maybeText.length > 0)
        text = JSON.stringify(maybeText[0]).slice(0, 120)
      else if (typeof (v as { line?: unknown }).line === 'string')
        text = (v as { line: string }).line
      else if (typeof (v as { path?: unknown }).path === 'string')
        text = (v as { path: string }).path
      else if (typeof (v as { target?: unknown }).target === 'string')
        text = (v as { target: string }).target
    }
  }
  return { kind, text }
}

/**
 * シーン ID から該当シーンを線形探索する純粋関数 (#260)。
 *
 * 元 NovelRenderer 内に同形で複数箇所直書きされていた `this.allScenes.find((s) => s.id === id)`
 * を 1 つに集約する。具体的には以下の「シーン本体を引く」用途が同一の式だった:
 *   - `jumpToScene(sceneId)`:        `this.allScenes.find((s) => s.id === sceneId)`
 *   - `loadFromSaveData(data)`:      `this.allScenes.find((s) => s.id === data.sceneId)`
 *   - `startFrom(opts)`:             `this.allScenes.find((s) => s.id === opts.sceneId)`
 *   - `resolveSceneTitle` 内部:       title を引くための同じ scene ルックアップ
 *
 * 見つからなければ `Array.prototype.find` の素の挙動どおり `undefined` を返す（元実装と同じ。
 * 呼び出し側が `if (!scene)` で未発見時の分岐／警告／フォールバックを各自で行う前提）。
 * `===` による厳密一致で、先頭から最初に一致した 1 件を返す（重複 id は先勝ち）。
 * `this` / PixiJS / DOM / audio に一切触れない決定論的写像。
 */
export function findSceneById(scenes: EventScene[], sceneId: string): EventScene | undefined {
  return scenes.find((s) => s.id === sceneId)
}

/**
 * 現在のシーン ID からセーブ表示用のシーンタイトルを解決する純粋関数 (#260)。
 *
 * 元 NovelRenderer 内で `quickSave()` と `openSaveMenu()` の 2 箇所にバイト単位で重複していた式:
 *   `this.currentSceneId
 *      ? (this.allScenes.find((s) => s.id === this.currentSceneId)?.title ?? null)
 *      : null`
 * を 1 関数に集約する（`resolveAssetUrl` / `resolveFontFamily` と同じ「2 箇所以上の重複を集約」）。
 *
 * 段階を元実装どおり忠実に踏襲する:
 *  - `sceneId` が falsy（`null` / `undefined` / 空文字 `''`）なら、scene を引かずに即 `null`。
 *    元の `this.currentSceneId ? … : null` の三項を踏襲する（空文字も「シーン未確定」として `null`）。
 *  - scene が見つからなければ（`find` が `undefined`）`?.title` が `undefined` になり `?? null` で `null`。
 *  - scene の `title` が（型上はあり得ないが）`undefined`/`null` でも `?? null` で `null` に落とす。
 *  - それ以外は scene の `title` 文字列を返す。
 *
 * scene 本体の線形探索は `findSceneById` に委譲する（探索ロジックの一元化）。
 */
export function resolveSceneTitle(
  scenes: EventScene[],
  sceneId: string | null | undefined
): string | null {
  if (!sceneId) return null
  return findSceneById(scenes, sceneId)?.title ?? null
}
