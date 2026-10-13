/**
 * 台座テクスチャ (#760)。全キャラ共通の形なので、パラメータごとに 1 枚だけ作ってキャッシュし、全 view で共有する
 * （破棄しない。枚数はパラメータの組の数）。mipmap + linear で縮小する。canvas が使えない環境では null（Graphics に戻す）。
 */
import { Texture } from 'pixi.js'
import { BASE_TEXTURE_WIDTH, renderAcrylicBase, type BaseRaster } from './acrylicBase'
import type { AcrylicParams } from './spriteStyle'

export interface AcrylicBaseTexture {
  texture: Texture
  layout: Omit<BaseRaster, 'rgba'>
}

const cache = new Map<string, AcrylicBaseTexture | null>()

export function getAcrylicBaseTexture(params: AcrylicParams): AcrylicBaseTexture | null {
  const key = [
    params.baseHeightRatio,
    params.shadowScale,
    params.shadowAlpha,
    params.baseThicknessRatio,
    params.baseFillAlpha,
    params.baseSideAlpha,
    params.slitAlpha,
    params.lineColor,
    params.lineAlpha,
  ].join('|')
  if (cache.has(key)) return cache.get(key) ?? null
  const made = build(params)
  // 作れなかった（canvas 無し）場合はキャッシュしない: 環境が変わらない限り毎回すぐ null になるだけ
  if (made) cache.set(key, made)
  return made
}

function build(params: AcrylicParams): AcrylicBaseTexture | null {
  try {
    if (typeof document === 'undefined') return null
    const raster = renderAcrylicBase(BASE_TEXTURE_WIDTH, params)
    const canvas = document.createElement('canvas')
    canvas.width = raster.width
    canvas.height = raster.height
    const ctx = canvas.getContext('2d')
    if (!ctx) return null
    ctx.putImageData(
      new ImageData(raster.rgba as Uint8ClampedArray<ArrayBuffer>, raster.width, raster.height),
      0,
      0
    )
    const texture = Texture.from(canvas)
    texture.source.autoGenerateMipmaps = true
    texture.source.scaleMode = 'linear'
    const { rgba: _rgba, ...layout } = raster
    void _rgba
    return { texture, layout }
  } catch {
    return null
  }
}
