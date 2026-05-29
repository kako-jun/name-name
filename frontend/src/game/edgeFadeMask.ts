/**
 * 端フェードマスク生成ユーティリティ (#250 / #252)。
 *
 * #250 で NovelRenderer.buildEdgeFadeMask として導入したロジックを、
 * #252 の VideoLayer からも流用できるよう純粋関数として切り出したもの。
 * 背景・動画レイヤの双方が同じマスク生成ロジックを共有する。
 */

import { Sprite, Texture } from 'pixi.js'
import { BackgroundFade } from './GameState'

/**
 * 各端の生 fade 値（parser / セーブデータ由来）を正規化して BackgroundFade | null を返す。
 *
 * - 非数値・負・0・NaN は「指定なし」として落とす
 * - 全端が指定なしなら null（マスク不要）
 */
export function normalizeEdgeFade(
  raw:
    | { top?: number | null; bottom?: number | null; left?: number | null; right?: number | null }
    | null
    | undefined
): BackgroundFade | null {
  if (!raw) return null
  const norm = (v: number | null | undefined): number | undefined => {
    if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) return undefined
    return Math.round(v)
  }
  const top = norm(raw.top)
  const bottom = norm(raw.bottom)
  const left = norm(raw.left)
  const right = norm(raw.right)
  if (top === undefined && bottom === undefined && left === undefined && right === undefined) {
    return null
  }
  const result: BackgroundFade = {}
  if (top !== undefined) result.top = top
  if (bottom !== undefined) result.bottom = bottom
  if (left !== undefined) result.left = left
  if (right !== undefined) result.right = right
  return result
}

/**
 * 端フェードマスク Sprite を生成する (#250)。
 *
 * screenWidth × screenHeight の Canvas を白(不透明)で塗り、各指定端について
 * 端→内側に向かう線形グラデーション(alpha 0→1)を destination-in 合成で重ねる。
 * これにより複数端が重なる角は乗算的により透明になる（4辺すべてが寄与した角も正しく透明）。
 * 決定論的（時間・乱数を使わない）。背景・動画レイヤ双方で流用できる純粋な生成ロジック。
 *
 * 全端が 0/None なら null を返す（マスク不要）。
 *
 * 返した Sprite は呼び出し側が所有・破棄する。canvas 由来テクスチャは
 * textureCache に乗らないため `destroy({ texture: true, textureSource: true })` で確実に解放すること。
 */
export function buildEdgeFadeMask(
  fade: BackgroundFade | null,
  screenWidth: number,
  screenHeight: number
): Sprite | null {
  if (!fade) return null
  const top = fade.top ?? 0
  const bottom = fade.bottom ?? 0
  const left = fade.left ?? 0
  const right = fade.right ?? 0
  if (top <= 0 && bottom <= 0 && left <= 0 && right <= 0) return null

  const w = Math.round(screenWidth)
  const h = Math.round(screenHeight)
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')
  if (!ctx) return null

  // ベースは完全不透明な白で塗る
  ctx.fillStyle = 'rgba(255,255,255,1)'
  ctx.fillRect(0, 0, w, h)

  // 各端のフェードを destination-in で乗算的に重ねる。
  // destination-in は「既存ピクセル alpha × 新ソース alpha」になるため、角が正しく重なる。
  // 各端ごとに画面全体を
  // 「帯部分は 0→1 勾配、帯より内側は alpha1(勾配の clamp で自動的に 1)」で塗る。
  // CanvasGradient は描画範囲外を端の stop 色で clamp するため、全画面 fillRect すれば
  // 帯の内側は alpha1 のまま残り、帯部分だけ 0→1 になる。
  // これを destination-in で重ねると、帯どうしが重なる角は ×(0..1) を複数回受けて
  // 乗算的により透明になる（4辺すべてが寄与した角も正しく透明）。
  ctx.globalCompositeOperation = 'destination-in'

  // 上端: y=0(端) で alpha0、y=top(内側境界) で alpha1。
  if (top > 0) {
    const grad = ctx.createLinearGradient(0, 0, 0, top)
    grad.addColorStop(0, 'rgba(255,255,255,0)')
    grad.addColorStop(1, 'rgba(255,255,255,1)')
    ctx.fillStyle = grad
    ctx.fillRect(0, 0, w, h)
  }
  if (bottom > 0) {
    const grad = ctx.createLinearGradient(0, h, 0, h - bottom)
    grad.addColorStop(0, 'rgba(255,255,255,0)')
    grad.addColorStop(1, 'rgba(255,255,255,1)')
    ctx.fillStyle = grad
    ctx.fillRect(0, 0, w, h)
  }
  if (left > 0) {
    const grad = ctx.createLinearGradient(0, 0, left, 0)
    grad.addColorStop(0, 'rgba(255,255,255,0)')
    grad.addColorStop(1, 'rgba(255,255,255,1)')
    ctx.fillStyle = grad
    ctx.fillRect(0, 0, w, h)
  }
  if (right > 0) {
    const grad = ctx.createLinearGradient(w, 0, w - right, 0)
    grad.addColorStop(0, 'rgba(255,255,255,0)')
    grad.addColorStop(1, 'rgba(255,255,255,1)')
    ctx.fillStyle = grad
    ctx.fillRect(0, 0, w, h)
  }

  ctx.globalCompositeOperation = 'source-over'

  const texture = Texture.from(canvas)
  const maskSprite = new Sprite(texture)
  maskSprite.x = 0
  maskSprite.y = 0
  maskSprite.width = screenWidth
  maskSprite.height = screenHeight
  return maskSprite
}
