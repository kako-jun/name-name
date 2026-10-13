/**
 * アクリル板テクスチャの生成 (#760)。画像読み込み時に 1 回だけ、元画像の解像度でオフスクリーン canvas から作る。
 * 形・質感の計算は純粋関数 `renderAcrylicPlate`（acrylicPlate.ts）。ここは canvas ↔ Texture の橋渡しだけ。
 * canvas が使えない環境（jsdom 等）・画像が読み出せない（CORS で汚染された canvas など）ときは null（板なしで描く）。
 */
import { Texture } from 'pixi.js'
import { renderAcrylicPlate } from './acrylicPlate'
import type { AcrylicParams } from './spriteStyle'

export interface AcrylicPlate {
  texture: Texture
  /** 板テクスチャ上で元画像の左上がある位置(px)。配置時にこのぶん左上へずらす */
  pad: number
}

export function createAcrylicPlateTexture(
  tex: Texture,
  params: AcrylicParams
): AcrylicPlate | null {
  try {
    const source = tex.source
    const resource = source?.resource as CanvasImageSource | undefined
    const w = source?.pixelWidth ?? 0
    const h = source?.pixelHeight ?? 0
    if (!resource || !(w > 0) || !(h > 0) || typeof document === 'undefined') return null
    const src = document.createElement('canvas')
    src.width = w
    src.height = h
    const sctx = src.getContext('2d', { willReadFrequently: true })
    if (!sctx) return null
    sctx.drawImage(resource, 0, 0, w, h)
    const data = sctx.getImageData(0, 0, w, h).data
    const alpha = new Uint8Array(w * h)
    for (let i = 0; i < alpha.length; i++) alpha[i] = data[i * 4 + 3]
    const raster = renderAcrylicPlate(alpha, w, h, params)
    const dst = document.createElement('canvas')
    dst.width = raster.width
    dst.height = raster.height
    const dctx = dst.getContext('2d')
    if (!dctx) return null
    dctx.putImageData(
      new ImageData(raster.rgba as Uint8ClampedArray<ArrayBuffer>, raster.width, raster.height),
      0,
      0
    )
    const texture = Texture.from(dst)
    // 縮小描画でなめらかにする（初回アップロード前に設定）
    texture.source.autoGenerateMipmaps = true
    texture.source.scaleMode = 'linear'
    return { texture, pad: raster.pad }
  } catch {
    return null
  }
}
