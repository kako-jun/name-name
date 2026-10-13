/**
 * アクリルスタンドの透明な台座のラスタを作る純粋関数 (#760)。DOM / PixiJS に触れない。
 *
 * 台座は全キャラ共通の形なので、高解像度（幅 `BASE_TEXTURE_WIDTH`）で一度だけ作って縮小して使う。
 * 構成（光は板と同じく左上から）:
 *   - 接地の柔らかい影: 台座の足元の楕円を、縁へ向けてぼかして落とす
 *   - 側面の厚み: 上面の楕円を下へ `baseThicknessRatio * ry` だけ押し出した帯。上面より少し濃い透明で、下端に明るい縁
 *   - 上面: ごく薄い白〜水色の透明面（背景がうっすら透ける）。縁に細いハイライト（左上を強く・右下を弱く）
 *   - 板の差し込み口: 上面の奥側に細いスリット（暗い透明＋手前側の縁に明るい線）
 *
 * 座標系は上面の楕円の中心 (cx, cyTop) 基準。出力は RGBA 非プリマルチ。影は上面ではなく足元（cyTop + 厚み）中心。
 */
import type { AcrylicParams } from './spriteStyle'

/** 台座テクスチャの幅(px)。影の楕円の幅がこれに一致する */
export const BASE_TEXTURE_WIDTH = 512
const MARGIN = 2

type BaseParams = Pick<
  AcrylicParams,
  | 'baseHeightRatio'
  | 'shadowScale'
  | 'shadowAlpha'
  | 'baseThicknessRatio'
  | 'baseFillAlpha'
  | 'baseSideAlpha'
  | 'slitAlpha'
  | 'lineColor'
  | 'lineAlpha'
>

export interface BaseRaster {
  width: number
  height: number
  rgba: Uint8ClampedArray
  /** 上面の楕円の中心（テクスチャ上の px） */
  cx: number
  cyTop: number
  /** 上面の楕円の半径(px) */
  rx: number
  ry: number
  /** 影の楕円の半径(px)。`shadowRx` はテクスチャ幅の半分 − 余白 */
  shadowRx: number
  /** 側面の厚み(px) */
  thickness: number
}

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v))
const smooth = (e0: number, e1: number, x: number): number => {
  const t = clamp01((x - e0) / (e1 - e0))
  return t * t * (3 - 2 * t)
}

/** 台座の寸法（px）。影の楕円の半幅を基準に、上面・影・厚み・テクスチャ高さを決める */
export function computeBaseLayout(
  texW: number,
  p: Pick<BaseParams, 'baseHeightRatio' | 'shadowScale' | 'baseThicknessRatio'>
): Omit<BaseRaster, 'rgba'> {
  const shadowRx = Math.max(1, texW / 2 - MARGIN)
  const rx = shadowRx / Math.max(1, p.shadowScale)
  const ry = rx * p.baseHeightRatio
  const thickness = ry * Math.max(0, p.baseThicknessRatio)
  const shadowRy = ry * Math.max(1, p.shadowScale)
  const height = Math.ceil(2 * Math.max(shadowRy, ry) + thickness + MARGIN * 2)
  return {
    width: texW,
    height,
    cx: texW / 2,
    cyTop: height / 2 - thickness / 2,
    rx,
    ry,
    shadowRx,
    thickness,
  }
}

export function renderAcrylicBase(texW: number, params: BaseParams): BaseRaster {
  const L = computeBaseLayout(texW, params)
  const { width: W, height: H, cx, cyTop, rx, ry, thickness: t, shadowRx } = L
  const shadowRy = ry * Math.max(1, params.shadowScale)
  const out = new Uint8ClampedArray(W * H * 4)
  const aa = 1.5 / Math.max(1, ry) // q 単位の縁のぼかし幅（約 1.5px）
  const rimC = [
    ((params.lineColor >> 16) & 0xff) / 255,
    ((params.lineColor >> 8) & 0xff) / 255,
    (params.lineColor & 0xff) / 255,
  ] as const
  const FILL = [0.9, 0.96, 1] as const
  const SLIT = [0.16, 0.22, 0.3] as const
  const [lx, ly] = [-Math.SQRT1_2, -Math.SQRT1_2]
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const px = x + 0.5
      const py = y + 0.5
      let r = 0
      let g = 0
      let b = 0
      let a = 0
      const over = (c: readonly [number, number, number], ca: number): void => {
        if (ca <= 0) return
        const na = ca + a * (1 - ca)
        r = (c[0] * ca + r * a * (1 - ca)) / na
        g = (c[1] * ca + g * a * (1 - ca)) / na
        b = (c[2] * ca + b * a * (1 - ca)) / na
        a = na
      }
      const dx = px - cx
      // 1) 接地の柔らかい影（足元 = cyTop + t 中心の楕円を縁へ向けてぼかす）
      const qs = Math.hypot(dx / shadowRx, (py - (cyTop + t)) / shadowRy)
      over([0, 0, 0], params.shadowAlpha * (1 - smooth(0.45, 1, qs)))
      // 2) 側面: 上面の楕円を下へ t だけ押し出した領域から上面を除いた帯
      const dySweep = py - cyTop - Math.min(t, Math.max(0, py - cyTop))
      const qSide = Math.hypot(dx / rx, dySweep / ry)
      const qTop = Math.hypot(dx / rx, (py - cyTop) / ry)
      const coverSwept = clamp01(0.5 - (qSide - 1) / aa)
      const coverTop = clamp01(0.5 - (qTop - 1) / aa)
      const sideCover = coverSwept * (1 - coverTop)
      if (sideCover > 0) {
        // 光側（左）をやや明るく
        const lit = clamp01(0.5 - dx / (2 * rx))
        over(FILL, params.baseSideAlpha * (0.8 + 0.4 * lit) * sideCover)
        // 下端の明るい縁（足元の楕円の手前側）
        const qFoot = Math.hypot(dx / rx, (py - cyTop - t) / ry)
        const foot = smooth(0.9, 1, qFoot) * (py > cyTop + t ? 1 : 0)
        over(rimC, params.lineAlpha * 0.9 * foot * sideCover)
      }
      // 3) 上面: ごく薄い透明面 + 縁のハイライト（左上を強く）
      if (coverTop > 0) {
        over(FILL, params.baseFillAlpha * coverTop)
        const nx = dx / rx
        const ny = (py - cyTop) / ry
        const nl = Math.hypot(nx, ny) || 1
        const lit = clamp01(((nx / nl) * lx + (ny / nl) * ly) * 0.5 + 0.5)
        const ring = smooth(0.9, 0.99, qTop) * coverTop
        over(rimC, params.lineAlpha * ring * (0.25 + 0.75 * lit * lit))
        // 4) 板の差し込み口: 奥側の細いスリット（暗い透明 + 手前側の縁に明るい線）
        const sy = cyTop - ry * 0.28
        const qSlit = Math.hypot(dx / (rx * 0.5), (py - sy) / (ry * 0.075))
        const slit = clamp01(0.5 - (qSlit - 1) / 0.25)
        over(SLIT, params.slitAlpha * slit * coverTop)
        const qLip = Math.hypot(dx / (rx * 0.5), (py - (sy + ry * 0.085)) / (ry * 0.05))
        over(rimC, params.lineAlpha * 0.6 * clamp01(0.5 - (qLip - 1) / 0.3) * (1 - slit))
      }
      const i = (y * W + x) * 4
      out[i] = Math.round(r * 255)
      out[i + 1] = Math.round(g * 255)
      out[i + 2] = Math.round(b * 255)
      out[i + 3] = Math.round(clamp01(a) * 255)
    }
  }
  return { ...L, rgba: out }
}
