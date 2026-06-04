/**
 * `NovelRenderer` の純粋計算（幾何・色パース・URL/フォント解決）。
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
    backgroundFade: normalizedFade,
    video: data.video ?? null,
    isBlackout: data.isBlackout ?? false,
    characters: data.characters ?? [],
    currentBgmPath: data.currentBgmPath ?? null,
  }
}
