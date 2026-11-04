/**
 * UI 部品の画像（手のカーソル #1067・「選択中」の円錐 #1087）。DOM / PixiJS の描画に依存しない純関数と設定の型、
 * および読み込み（失敗したら null＝従来のドット手・白い三角へフォールバック）。
 * 寸法・配置の計算が正本で、描画側（HandCursor.ts・BattleScreen）は結果を反映するだけ。
 */
import { Assets, type Texture } from 'pixi.js'
import {
  SELECT_MARK_GAP_RATIO,
  SELECT_MARK_HEIGHT_RATIO,
  SELECT_MARK_MIN_GAP,
  SELECT_MARK_MIN_HEIGHT,
  SELECT_MARK_MIN_WIDTH,
  SELECT_MARK_WIDTH_RATIO,
} from './battleLayout'

/** 設定 `ui` の解決済みの形。URL は解決済み。画像未指定のキーは出ない（従来の描画） */
export interface UiImagesConfig {
  /** 手のカーソルの画像（右向きの絵。左向きは左右反転して使う） */
  handImage?: string
  /** 「選択中」の印の画像（頂点が下の円錐） */
  selectMarkImage?: string
  /** 印の拡大率（従来の三角の枠に収めた大きさに対する倍率）。既定 `DEFAULT_MARK_SCALE` */
  markScale: number
}

export const DEFAULT_MARK_SCALE = 2
/** 拡大率の上限（誤指定で画面を覆わないように） */
export const MAX_MARK_SCALE = 10

/** `ui.markScale` の検証。未指定は既定。0 以下・非数・上限超は警告して既定へ */
export function parseMarkScale(v: unknown, warnings: string[]): number {
  if (v === undefined) return DEFAULT_MARK_SCALE
  if (typeof v === 'number' && Number.isFinite(v) && v > 0 && v <= MAX_MARK_SCALE) return v
  warnings.push(
    `ui.markScale は 0 より大きく ${MAX_MARK_SCALE} 以下の数値: ${JSON.stringify(v)}（無視して既定の ${DEFAULT_MARK_SCALE} を使います）`
  )
  return DEFAULT_MARK_SCALE
}

export type HandFacingDir = 'left' | 'right'

export interface ImageRect {
  x: number
  y: number
  w: number
  h: number
  /** 左右反転して描くか（左向きの手） */
  flipX: boolean
}

/**
 * 手の画像の矩形。`box`（ドット手の枠＝戦闘の `HandPlacement` / フィールドメニューの行に合わせた枠）の高さに、
 * 画像の縦横比を保って合わせる。指す側の端は枠の端に揃える（右向き = 右端、左向き = 左端。幅が枠と違っても指先の位置が動かない）。
 * 画像の大きさが不正（0 以下・非数）なら null（呼び出し側はドット手にする）
 */
export function computeHandImageRect(
  box: { x: number; y: number; w: number; h: number },
  facing: HandFacingDir,
  texW: number,
  texH: number
): ImageRect | null {
  if (!(texW > 0) || !(texH > 0) || !(box.h > 0)) return null
  const h = box.h
  const w = (h * texW) / texH
  const x = facing === 'right' ? box.x + box.w - w : box.x
  return { x, y: box.y, w, h, flipX: facing === 'left' }
}

/**
 * 「選択中」の印（円錐の画像）の矩形。従来の三角（`computeSelectMarkTriangle`）の幅・高さの枠に画像を縦横比を保って収め、
 * `scale` を掛ける。頭からの間隔（unit 比・最小値）と、上のログ窓の下端との最低の隙間（`minTop`）は三角と同じ規則で、
 * 画像の下端中央（円錐の頂点）が `tipY`。`cx` は絵の中央 x、`headTop` は絵（板があれば板）の上端 y。
 * 画像の大きさが不正・scale が不正なら null（呼び出し側は三角にする）
 */
export function computeSelectMarkImageRect(
  cx: number,
  headTop: number,
  unit: number,
  texW: number,
  texH: number,
  scale: number,
  minTop = -Infinity
): ImageRect | null {
  if (!(texW > 0) || !(texH > 0) || !(scale > 0) || !Number.isFinite(scale)) return null
  const boxW = Math.max(SELECT_MARK_MIN_WIDTH, unit * SELECT_MARK_WIDTH_RATIO)
  const boxH = Math.max(SELECT_MARK_MIN_HEIGHT, unit * SELECT_MARK_HEIGHT_RATIO)
  const fit = Math.min(boxW / texW, boxH / texH) * scale
  const w = texW * fit
  const h = texH * fit
  const tipY = Math.max(
    headTop - Math.max(SELECT_MARK_MIN_GAP, unit * SELECT_MARK_GAP_RATIO),
    minTop + h
  )
  return { x: cx - w / 2, y: tipY - h, w, h, flipX: false }
}

/**
 * UI 画像を読む。読めなかった・URL が空なら警告して null（従来の描画へフォールバック）。
 * `label` は警告に出す部品名。Assets のキャッシュに載るので同じ URL は 1 回だけ読まれる
 */
export async function loadUiTexture(
  url: string | undefined,
  label: string
): Promise<Texture | null> {
  if (!url) return null
  try {
    return (await Assets.load(url)) as Texture
  } catch (e) {
    console.warn(`[ui] ${label}の画像を読めませんでした（従来の描画にします）: ${url}`, e)
    return null
  }
}
