/**
 * アクリル板（アクリルスタンドの透明な板）のラスタを作る純粋関数 (#760)。DOM / PixiJS に触れない。
 *
 * 旧 `AcrylicEdgeFilter`（描画解像度で alpha の段差を max でなぞる方式）は、縮小後の小さいテクスチャ上で
 * 動くためジャギーが出た。こちらは画像読み込み時に、長辺 `PLATE_WORK_MAX_SIDE`(192px) の作業解像度で板の形と質感を
 * 1 回だけ作り（acrylicPlateTexture.ts が縮小して渡す）、描画側はそのテクスチャを mipmap 付きで拡縮する（なめらかになる）。
 *
 *   形   : スプライトの alpha を box blur 3 回（≒ガウス）でぼかし、しきい値の smoothstep で外へ膨らませる
 *          （縁は 1px 未満の幅でアンチエイリアス。細い隙間は埋まり、角は丸い「板」の輪郭になる）
 *   質感 : 内側はごく薄い透明（わずかに白〜水色）／縁は細い明るいリムで、光が当たる左上を強く・反対側を弱く／
 *          縁の内側にごく薄い影（光と反対側）／左上寄りの斜めの鏡面ハイライトの筋
 *
 * 出力は (w + 2*pad) x (h + 2*pad) の RGBA（非プリマルチ・0〜255）。pad だけスプライトの外へ広がる。
 */
import type { AcrylicParams } from './spriteStyle'

/** 光の来る向き（左上）。単位ベクトル */
export const PLATE_LIGHT_DIR: readonly [number, number] = [-Math.SQRT1_2, -Math.SQRT1_2]
/** 形のしきい値（ぼかした alpha がこれを超えた所が板）。小さいほど遠くまで広がる */
export const PLATE_SHAPE_THRESHOLD = 0.1
/** しきい値の smoothstep 半幅（縁のアンチエイリアス幅） */
const SHAPE_EDGE_SOFTNESS = 0.04
/** しきい値 0.1 のとき、ガウスのぼかしの σ に対して縁が外へ広がる距離は約 1.28σ。広がり E から σ を求める割合 */
const SPREAD_PER_SIGMA = 1.28

export interface PlateLayout {
  /** スプライト画像の外へ広がる幅(px・この関数に渡した画像の解像度)。板の外縁まで */
  spread: number
  /** そのうち縁取り（リム）の太さ(px・この関数に渡した画像の解像度) */
  rim: number
  /** 出力ラスタの周囲の余白(px)。広がり + アンチエイリアス/ぼかしの裾 */
  pad: number
}

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v))
export function smoothstep(e0: number, e1: number, x: number): number {
  if (e0 === e1) return x < e0 ? 0 : 1
  const t = clamp01((x - e0) / (e1 - e0))
  return t * t * (3 - 2 * t)
}

/**
 * 元画像 `w x h` から板の広がり・リム幅・余白を求める。長さは画像の長辺に対する比率
 * （`marginRatio` + `lineWidthRatio` が板の広がり、`lineWidthRatio` がリム）。非有限・負は 0 扱い。
 */
export function computePlateLayout(
  w: number,
  h: number,
  params: Pick<AcrylicParams, 'marginRatio' | 'lineWidthRatio'>
): PlateLayout {
  const maxSide = Math.max(0, Math.max(w, h))
  const r = (v: number): number => (Number.isFinite(v) && v > 0 ? v : 0)
  const spread = Math.max(1, (r(params.marginRatio) + r(params.lineWidthRatio)) * maxSide)
  const rim = Math.max(1, r(params.lineWidthRatio) * maxSide)
  return { spread, rim, pad: Math.ceil(spread) + 3 }
}

/** 横方向の box blur（半径 r・端は 0 で埋める）。running sum で O(n) */
function blurRow(src: Float32Array, dst: Float32Array, w: number, h: number, r: number): void {
  const inv = 1 / (2 * r + 1)
  for (let y = 0; y < h; y++) {
    const o = y * w
    let sum = 0
    for (let x = -r; x <= r; x++) if (x >= 0 && x < w) sum += src[o + x]
    for (let x = 0; x < w; x++) {
      dst[o + x] = sum * inv
      const add = x + r + 1
      const sub = x - r
      if (add < w) sum += src[o + add]
      if (sub >= 0) sum -= src[o + sub]
    }
  }
}
function blurCol(src: Float32Array, dst: Float32Array, w: number, h: number, r: number): void {
  const inv = 1 / (2 * r + 1)
  for (let x = 0; x < w; x++) {
    let sum = 0
    for (let y = -r; y <= r; y++) if (y >= 0 && y < h) sum += src[y * w + x]
    for (let y = 0; y < h; y++) {
      dst[y * w + x] = sum * inv
      const add = y + r + 1
      const sub = y - r
      if (add < h) sum += src[add * w + x]
      if (sub >= 0) sum -= src[sub * w + x]
    }
  }
}

/** box blur 3 回（水平・垂直）≒ガウス（σ ≒ 半径）。入力は破壊しない */
export function gaussianBlur(
  src: Float32Array,
  w: number,
  h: number,
  radius: number
): Float32Array {
  const r = Math.max(0, Math.round(radius))
  if (r === 0 || w === 0 || h === 0) return Float32Array.from(src)
  const a = Float32Array.from(src)
  let b = new Float32Array(src.length)
  for (let i = 0; i < 3; i++) {
    blurRow(a, b, w, h, r)
    blurCol(b, a, w, h, r)
  }
  b = new Float32Array(0)
  return a
}

export interface PlateRaster {
  width: number
  height: number
  /** 元画像の左上がこの raster 上のどこか（= 周囲の余白 px） */
  pad: number
  /** 元画像の下端から下へ伸ばした行数(px・差し込み線まで) (#802) */
  extend: number
  /** RGBA 非プリマルチ（0〜255） */
  rgba: Uint8ClampedArray
  /** 板の形（0〜1・width x height）。地面の影 (acrylicShadow.ts) の元にする */
  shape: Float32Array
}

type PlateParams = Pick<
  AcrylicParams,
  | 'marginRatio'
  | 'lineWidthRatio'
  | 'lineColor'
  | 'lineAlpha'
  | 'plateFillAlpha'
  | 'specularAlpha'
  | 'innerShadowAlpha'
  | 'spriteLiftRatio'
>

/** 足元の帯の高さ（画像高さに対する比率）。この帯に触れる列だけを下へ伸ばす（腕など上の部位は伸ばさない） */
const FOOT_BAND_RATIO = 0.06

/**
 * スプライト下端から台座の差し込み線まで板を伸ばすための追加行数(px・この画像の解像度)。
 * 浮き量 = `spriteLiftRatio` × スプライト高さ (#802)。
 */
export function computePlateExtend(h: number, liftRatio: number): number {
  const r = Number.isFinite(liftRatio) && liftRatio > 0 ? liftRatio : 0
  return h > 0 ? Math.round(r * h) : 0
}

/**
 * alpha の最下段の不透明行を基準にした足元の帯に触れる列を、画像の下端から `extend` 行ぶん下へ伸ばした
 * マスクの追加行（長さ `w * extend`）を返す。板の下の縁が台座の差し込み線まで届く (#802)。
 */
export function extendFootMask(
  alpha: ArrayLike<number>,
  w: number,
  h: number,
  extend: number
): Float32Array {
  const out = new Float32Array(Math.max(0, w * extend))
  if (extend <= 0) return out
  let bottom = -1
  for (let y = h - 1; y >= 0 && bottom < 0; y--)
    for (let x = 0; x < w; x++)
      if (alpha[y * w + x] > 0) {
        bottom = y
        break
      }
  if (bottom < 0) return out
  const top = Math.max(0, bottom - Math.max(1, Math.round(h * FOOT_BAND_RATIO)))
  for (let x = 0; x < w; x++) {
    let a = 0
    for (let y = top; y <= bottom; y++) a = Math.max(a, alpha[y * w + x])
    if (a <= 0) continue
    for (let e = 0; e < extend; e++) out[e * w + x] = a / 255
  }
  return out
}

const FILL_COLOR: readonly [number, number, number] = [0.9, 0.96, 1]
const SHADOW_COLOR: readonly [number, number, number] = [0.2, 0.31, 0.42]
const SPEC_COLOR: readonly [number, number, number] = [1, 1, 1]

/**
 * 板のラスタを作る。`alpha` は元画像の alpha（0〜255・長さ `w*h`）。
 * 寸法が 0 以下・alpha が足りないときは 1x1 の透明を返す。
 */
export function renderAcrylicPlate(
  alpha: ArrayLike<number>,
  w: number,
  h: number,
  params: PlateParams
): PlateRaster {
  if (!(w > 0) || !(h > 0) || alpha.length < w * h) {
    return {
      width: 1,
      height: 1,
      pad: 0,
      extend: 0,
      rgba: new Uint8ClampedArray(4),
      shape: new Float32Array(1),
    }
  }
  const { spread, rim, pad } = computePlateLayout(w, h, params)
  const W = w + pad * 2
  const extend = computePlateExtend(h, params.spriteLiftRatio)
  const H = h + extend + pad * 2
  const mask = new Float32Array(W * H)
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) mask[(y + pad) * W + x + pad] = alpha[y * w + x] / 255
  const ext = extendFootMask(alpha, w, h, extend)
  for (let e = 0; e < extend; e++)
    for (let x = 0; x < w; x++) mask[(h + e + pad) * W + x + pad] = ext[e * w + x]

  // 形: ぼかして smoothstep（σ から広がり距離が spread になるよう決める）
  const sigma = spread / SPREAD_PER_SIGMA
  const blurred = gaussianBlur(mask, W, H, sigma)
  const shape = new Float32Array(W * H)
  for (let i = 0; i < shape.length; i++) {
    shape[i] = smoothstep(
      PLATE_SHAPE_THRESHOLD - SHAPE_EDGE_SOFTNESS,
      PLATE_SHAPE_THRESHOLD + SHAPE_EDGE_SOFTNESS,
      blurred[i]
    )
  }
  // 縁からの深さの目安（縁で約 0.5、奥ほど 1）。リムと影の帯、法線に使う
  const depthRim = gaussianBlur(shape, W, H, rim)
  const depthWide = gaussianBlur(shape, W, H, rim * 2.5)

  const out = new Uint8ClampedArray(W * H * 4)
  const [lx, ly] = PLATE_LIGHT_DIR
  const rimColor: [number, number, number] = [
    ((params.lineColor >> 16) & 0xff) / 255,
    ((params.lineColor >> 8) & 0xff) / 255,
    (params.lineColor & 0xff) / 255,
  ]
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x
      const s = shape[i]
      if (s <= 0) continue
      // 外向き法線 = -∇depthRim（中央差分）
      const gx = depthRim[y * W + Math.min(W - 1, x + 1)] - depthRim[y * W + Math.max(0, x - 1)]
      const gy = depthRim[Math.min(H - 1, y + 1) * W + x] - depthRim[Math.max(0, y - 1) * W + x]
      const len = Math.hypot(gx, gy)
      const facing = len > 1e-6 ? (-gx / len) * lx + (-gy / len) * ly : 0 // 1 = 光側, -1 = 反対側
      const lit = clamp01(facing * 0.5 + 0.5)

      // 1) 内側のごく薄い面
      let r = FILL_COLOR[0]
      let g = FILL_COLOR[1]
      let b = FILL_COLOR[2]
      let a = params.plateFillAlpha * s
      const over = (c: readonly [number, number, number], ca: number): void => {
        if (ca <= 0) return
        const na = ca + a * (1 - ca)
        r = (c[0] * ca + r * a * (1 - ca)) / na
        g = (c[1] * ca + g * a * (1 - ca)) / na
        b = (c[2] * ca + b * a * (1 - ca)) / na
        a = na
      }
      // 2) 縁の内側のごく薄い影（光と反対側ほど濃い）
      const wide = clamp01((0.92 - depthWide[i]) / 0.42)
      over(SHADOW_COLOR, params.innerShadowAlpha * wide * clamp01(-facing) * s)
      // 3) リム: 縁で 1・奥で 0。光側を強く、反対側を弱く
      const edge = clamp01((0.96 - depthRim[i]) / 0.46)
      over(rimColor, params.lineAlpha * edge * (0.3 + 0.7 * lit * lit) * s)
      // 4) 左上寄りの斜めの鏡面ハイライトの筋（2 本・細い方は弱い）
      const u = (x + 0.5) / W + (y + 0.5) / H
      const streak =
        Math.exp(-(((u - 0.62) / 0.05) ** 2)) + 0.5 * Math.exp(-(((u - 0.78) / 0.02) ** 2))
      over(SPEC_COLOR, params.specularAlpha * clamp01(streak) * s)

      out[i * 4] = Math.round(r * 255)
      out[i * 4 + 1] = Math.round(g * 255)
      out[i * 4 + 2] = Math.round(b * 255)
      out[i * 4 + 3] = Math.round(clamp01(a) * 255)
    }
  }
  return { width: W, height: H, pad, extend, rgba: out, shape }
}
