/**
 * アクリル板テクスチャの生成 (#760)。画像読み込み時に 1 回だけ、長辺 `PLATE_WORK_MAX_SIDE`(192px) の作業解像度でオフスクリーン canvas から作る
 * （板は輪郭のぼかしなので、これ以上高くしても見た目は変わらず時間だけかかる。描画側は mipmap で拡縮する）。
 * 前提: テクスチャは resolution=1 で、アトラスの一部ではなく画像全体（`source.pixelWidth` = 論理幅、frame は全体）。
 * BattleScreen の配置（`placeAcrylic`）も論理幅 `texture.width` と板の縮尺を同じ前提で結ぶ。
 * 形・質感の計算は純粋関数 `renderAcrylicPlate`（acrylicPlate.ts）。ここは canvas ↔ Texture の橋渡しだけ。
 * canvas が使えない環境（jsdom 等）・画像が読み出せない（CORS で汚染された canvas など）ときは null（板なしで描く）。
 */
import { Texture } from 'pixi.js'
import { renderAcrylicPlate } from './acrylicPlate'
import { renderGroundShadow } from './acrylicShadow'
import type { AcrylicParams } from './spriteStyle'

export interface AcrylicPlate {
  texture: Texture
  /** 板テクスチャ上で元画像の左上がある位置(px・板テクスチャの px)。配置時にこのぶん左上へずらす */
  pad: number
  /** 板テクスチャの 1px が元画像の何 px か（板は縮小した解像度で作る。生成時間を抑えるため）。省略は 1 */
  scale?: number
  /** 地面の影 (#760) のテクスチャ（板と同じ寸法・pad）。作れなければ省略 */
  shadow?: Texture
  /** 足元（スプライト下端の中央）の板テクスチャ上の位置(px)。影の pivot */
  foot?: { x: number; y: number }
}

/** 板を作る作業解像度の長辺(px)。板は輪郭のぼかしなので、これ以上高くしても見た目は変わらず時間だけかかる */
export const PLATE_WORK_MAX_SIDE = 192

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
    // 作業解像度へ縮小して alpha を取る（ブラウザの縮小描画は速い）
    const ws = Math.min(1, PLATE_WORK_MAX_SIDE / Math.max(w, h))
    const ww = Math.max(1, Math.round(w * ws))
    const wh = Math.max(1, Math.round(h * ws))
    const src = document.createElement('canvas')
    src.width = ww
    src.height = wh
    const sctx = src.getContext('2d', { willReadFrequently: true })
    if (!sctx) return null
    sctx.drawImage(resource, 0, 0, ww, wh)
    const data = sctx.getImageData(0, 0, ww, wh).data
    const alpha = new Uint8Array(ww * wh)
    for (let i = 0; i < alpha.length; i++) alpha[i] = data[i * 4 + 3]
    // 台座が無いときは浮き量が効かない（幾何の liftPx=0 と揃え、板も伸ばさない）
    // 帯（ステム）も台座へつなぐものなので、台座が無いときは出さない (#848)
    const plateParams = {
      ...params,
      spriteLiftRatio: params.hasBase ? params.spriteLiftRatio : 0,
      stemWidthRatio: params.hasBase ? params.stemWidthRatio : 0,
    }
    const raster = renderAcrylicPlate(alpha, ww, wh, plateParams)
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
    // 地面の影: 板の形をぼかしたテクスチャ（板と同じ寸法・pad なので足元は同じ位置）
    let shadow: Texture | undefined
    const sh = renderGroundShadow(
      raster.shape,
      raster.width,
      raster.height,
      Math.max(ww, wh),
      params
    )
    const sc = document.createElement('canvas')
    sc.width = sh.width
    sc.height = sh.height
    const sctx2 = sc.getContext('2d')
    if (sctx2) {
      sctx2.putImageData(
        new ImageData(sh.rgba as Uint8ClampedArray<ArrayBuffer>, sh.width, sh.height),
        0,
        0
      )
      shadow = Texture.from(sc)
      shadow.source.autoGenerateMipmaps = true
      shadow.source.scaleMode = 'linear'
    }
    return {
      texture,
      pad: raster.pad,
      scale: w / ww,
      shadow,
      // 足元は差し込み線の高さ（浮き量ぶん下）。接地影は台座側に残す (#802)
      foot: { x: raster.pad + ww / 2, y: raster.pad + wh + raster.extend },
    }
  } catch {
    return null
  }
}
