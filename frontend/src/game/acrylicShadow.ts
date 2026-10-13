/**
 * アクスタ本体（キャラのシルエット＋板の形）が地面に落とす影 (#760)。DOM / PixiJS に触れない。
 *
 * 光は左上から（板・台座のハイライトと同じ向き）。影は台座の足元を基点に、地面の上で右奥へ倒れる:
 * シルエットを縦につぶし（`castSquash`）、右へ傾け（`castShear`）、少しぼかした半透明の暗色にする。
 * 読み込み時に一度だけ「形のぼかし」テクスチャを作り（`renderGroundShadow`）、変形は Sprite の
 * scale / skew / pivot で行う（`computeShadowTransform`）。
 */
import { gaussianBlur } from './acrylicPlate'
import type { AcrylicParams } from './spriteStyle'

type ShadowParams = Pick<AcrylicParams, 'castAlpha' | 'castBlurRatio'>

export interface ShadowRaster {
  width: number
  height: number
  /** RGBA（黒・非プリマルチ。alpha だけが入る） */
  rgba: Uint8ClampedArray
}

/**
 * 板の形（0〜1）をぼかして影の alpha にする。ぼかし半径 = `castBlurRatio` × 元画像の長辺（`srcMaxSide`）。
 * 出力の寸法は板のラスタと同じ（pad も共通なので足元の位置も同じ）。
 */
export function renderGroundShadow(
  shape: Float32Array,
  width: number,
  height: number,
  srcMaxSide: number,
  params: ShadowParams
): ShadowRaster {
  const blurred = gaussianBlur(shape, width, height, Math.max(0, params.castBlurRatio) * srcMaxSide)
  const rgba = new Uint8ClampedArray(width * height * 4)
  const a = Math.min(1, Math.max(0, params.castAlpha))
  for (let i = 0; i < blurred.length; i++) {
    rgba[i * 4 + 3] = Math.round(Math.min(1, Math.max(0, blurred[i])) * a * 255)
  }
  return { width, height, rgba }
}

export interface ShadowTransform {
  scaleX: number
  scaleY: number
  /** Pixi の skew.x（ラジアン）。pivot を足元に置き、上（y が負）ほど右へずれる向きなら負 */
  skewX: number
}

/**
 * 影のスプライトの変形。`ks` は影テクスチャ 1px の描画上の大きさ（板と同じ縮尺）。
 * 足元（pivot）を基点に、縦は `ks × castSquash` につぶし、上へ行くほど `castShear × つぶした高さ` だけ右へずらす。
 * Pixi は x' = scaleX·x + sin(skewX)·scaleY·y, y' = cos(skewX)·scaleY·y なので、
 * tan(skewX) = -castShear、scaleY = ks × castSquash / cos(skewX) とすると上の通りになる。
 */
export function computeShadowTransform(
  params: Pick<AcrylicParams, 'castSquash' | 'castShear'>,
  ks: number
): ShadowTransform {
  const skewX = -Math.atan(params.castShear)
  return {
    scaleX: ks,
    scaleY: (ks * params.castSquash) / Math.cos(skewX),
    skewX,
  }
}
