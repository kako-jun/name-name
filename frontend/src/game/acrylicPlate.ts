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
import { computeAcrylicGeometry, resolveAcrylicParams, type AcrylicParams } from './spriteStyle'

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
  | 'stemWidthRatio'
  | 'stemFillAlpha'
  | 'stemMinGapRatio'
> &
  Partial<AcrylicParams>

/** 足元の帯の高さ（画像高さに対する比率）。この帯に触れる列だけを下へ伸ばす（腕など上の部位は伸ばさない） */
const FOOT_BAND_RATIO = 0.06

/**
 * スプライト下端から台座の差し込み線まで板を伸ばすための追加行数(px・この画像の解像度)。
 * 浮き量 = `spriteLiftRatio` × スプライト高さ (#802)。
 * 丸めで差し込み線に届かない隙間が出ないよう切り上げる（余分に伸びた分は差し込み線の mask が水平に切る）。
 */
export function computePlateExtend(h: number, liftRatio: number): number {
  const r = Number.isFinite(liftRatio) && liftRatio > 0 ? liftRatio : 0
  return h > 0 ? Math.max(0, Math.ceil(r * h - 1e-9)) : 0 // max で -0 を +0 に正規化
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

/**
 * ステム判定で「不透明」とみなす alpha の下限（0〜255）。生成画像の縁にある薄いにじみで下端を誤検出しない (#848)。
 * 足元の延長（extendFootMask）が alpha > 0 を使うのは、薄い縁まで板を途切れさせずに伸ばすため（板は ぼかすので薄い値は無害）で、
 * 「帯を出すか」の判定とは目的が違うので閾値を揃えない。
 */
const STEM_ALPHA_MIN = 32
/** ステムの上端を絵の中へ食い込ませる量（画像高さに対する比率）。絵と帯の継ぎ目に隙間を作らない */
const STEM_OVERLAP_RATIO = 0.05

/** 絵と台座をつなぐ帯（ステム）の矩形。画像の左上を原点とした px（下端 `bottom` は差し込み線の行の終端） */
export interface StemRect {
  /** 帯の中心 x */
  cx: number
  /** 帯の半幅 */
  halfWidth: number
  /** 帯の上端 y（絵の最下端より少し上） */
  top: number
  /** 帯の下端 y（画像下端 + extend） */
  bottom: number
  /** 角丸の半径 */
  radius: number
}

/**
 * スリット幅の換算に使う仮の枠一辺(論理 px)。実際の枠は画面ごとに違い（例 300）、余白・線の上限・下限(px)のぶん
 * 縮尺が少しずれるが、スリット半幅への影響は無視できる（板は画像ごとに 1 回だけ作るので枠の大きさを渡せない）。
 */
const STEM_REF_SIZE = 200

/**
 * 台座のスリット（板の差し込み口）の、元画像 `w x h` の px での半幅。スリットの半幅は台座の上面の横半径の 0.5 倍
 * （acrylicBase.ts）。絵は枠に contain で収まるので、枠 → 画像 px の倍率は computeAcrylicGeometry の縮尺から求める (#848)。
 * 台座が作れない（幾何が不正）ときは 0。
 */
export function computeStemSlitHalfWidth(
  w: number,
  h: number,
  params: Partial<AcrylicParams> = {}
): number {
  return computeStemScale(w, h, params).slitHalf
}

/** 帯の最小幅 / 枠一辺 (#848)。小さい画面でも帯が読める下限（スリットの全幅は枠の約 0.35 倍） */
export const STEM_MIN_WIDTH_RATIO = 0.1

/** 元画像 px で見た、スリットの半幅と帯の最小幅 */
export function computeStemScale(
  w: number,
  h: number,
  params: Partial<AcrylicParams> = {}
): { slitHalf: number; minWidth: number } {
  const g = computeAcrylicGeometry(
    w,
    h,
    STEM_REF_SIZE,
    resolveAcrylicParams({ ...params, hasBase: true })
  )
  if (!g.base || !(g.sprite.width > 0)) return { slitHalf: 0, minWidth: 0 }
  const pxPerSize = w / g.sprite.width
  return {
    slitHalf: g.base.rx * 0.5 * pxPerSize,
    minWidth: STEM_MIN_WIDTH_RATIO * STEM_REF_SIZE * pxPerSize,
  }
}

/**
 * 空に浮く絵（下端付近が透明）を台座とつなぐ帯の形を求める (#848)。純粋関数。
 * 板が刺さるのは台座のスリットだけなので、「絵が台座から離れているか」は画像全体の最下端でなく、
 * スリットの幅に当たる中央の列（画像中心 ± スリット半幅）の中の不透明（alpha >= 32）な最下端で判定する
 * （左下の羽根の先だけが下端に届く絵でも、スリットの上は空いているので帯が出る）。
 * その最下端から画像下端までの距離が `stemMinGapRatio` × 画像高さ未満・中央の列に不透明画素が無い・
 * `stemWidthRatio` が 0 のときは null（帯なし＝従来どおり）。
 * 帯の幅は絵全体の不透明部分の横幅 × `stemWidthRatio`（スリット幅で頭打ち）。中心は中央の列の最下端付近の帯
 * （足元の帯と同じ高さ）の不透明画素の重心 x を、帯がスリットからはみ出さない範囲（スリット中心 ± (スリット半幅 − 帯の半幅)）
 * に寄せたもの。
 */
export function computeStem(
  alpha: ArrayLike<number>,
  w: number,
  h: number,
  extend: number,
  params: Pick<AcrylicParams, 'stemWidthRatio' | 'stemMinGapRatio'> & Partial<AcrylicParams>
): StemRect | null {
  if (!(w > 0) || !(h > 0) || alpha.length < w * h) return null
  if (!(params.stemWidthRatio > 0)) return null
  const { slitHalf, minWidth } = computeStemScale(w, h, params)
  if (!(slitHalf > 0)) return null
  const slitCx = w / 2
  const cx0 = Math.max(0, Math.ceil(slitCx - slitHalf))
  const cx1 = Math.min(w - 1, Math.floor(slitCx + slitHalf))
  if (cx1 < cx0) return null
  // 絵全体の不透明部分の横幅
  let minX = w
  let maxX = -1
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      if (alpha[y * w + x] >= STEM_ALPHA_MIN) {
        if (x < minX) minX = x
        if (x > maxX) maxX = x
      }
  // スリットの列の中の不透明な最下端
  let bottom = -1
  for (let y = h - 1; y >= 0 && bottom < 0; y--)
    for (let x = cx0; x <= cx1; x++)
      if (alpha[y * w + x] >= STEM_ALPHA_MIN) {
        bottom = y
        break
      }
  if (bottom < 0) return null
  const gap = h - 1 - bottom
  if (gap < params.stemMinGapRatio * h) return null
  const bandTop = Math.max(0, bottom - Math.max(1, Math.round(h * FOOT_BAND_RATIO)))
  let sum = 0
  let n = 0
  for (let y = bandTop; y <= bottom; y++)
    for (let x = cx0; x <= cx1; x++)
      if (alpha[y * w + x] >= STEM_ALPHA_MIN) {
        sum += x
        n++
      }
  const width = Math.min(
    w,
    slitHalf * 2,
    Math.max(2, minWidth, (maxX - minX + 1) * params.stemWidthRatio)
  )
  const halfWidth = width / 2
  const reach = Math.max(0, slitHalf - halfWidth)
  const cx = Math.min(
    w - halfWidth,
    Math.max(
      halfWidth,
      Math.min(slitCx + reach, Math.max(slitCx - reach, n > 0 ? (sum + 0.5 * n) / n : slitCx))
    )
  )
  const overlap = Math.max(1, Math.round(h * STEM_OVERLAP_RATIO))
  return {
    cx,
    halfWidth,
    top: Math.max(0, bottom - overlap),
    bottom: h + Math.max(0, extend),
    radius: halfWidth * 0.5,
  }
}

/** ステムの角丸矩形を mask（幅 `W`・画像の左上が (pad, pad)）へ書き込む。既存値より小さくならない (#848) */
export function stampStem(mask: Float32Array, W: number, pad: number, stem: StemRect): void {
  const H = Math.floor(mask.length / W)
  const x0 = stem.cx - stem.halfWidth
  const x1 = stem.cx + stem.halfWidth
  const r = stem.radius
  for (let y = Math.floor(stem.top); y < Math.ceil(stem.bottom); y++) {
    const py = y + pad
    if (py < 0 || py >= H) continue
    const yc = y + 0.5
    for (let x = Math.floor(x0); x < Math.ceil(x1); x++) {
      const px = x + pad
      if (px < 0 || px >= W) continue
      const xc = x + 0.5
      if (xc < x0 || xc > x1 || yc < stem.top || yc > stem.bottom) continue
      // 上側の角だけ丸める（下は差し込み線で水平に切られる）
      const dx = Math.max(x0 + r - xc, xc - (x1 - r), 0)
      const dy = Math.max(stem.top + r - yc, 0)
      if (dx * dx + dy * dy > r * r) continue
      const i = py * W + px
      if (mask[i] < 1) mask[i] = 1
    }
  }
}

/** 帯のリムの明るさの下限（光と反対側の縁でも帯の輪郭が読めるように）(#848) */
const STEM_RIM_LIT_MIN = 0.75

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
  // 絵の下端が台座から離れている（空を飛ぶ）ときは、帯状の透明プラスチックで台座までつなぐ (#848)
  const stem = computeStem(alpha, w, h, extend, params)
  let stemOnly: Float32Array | null = null
  if (stem) {
    stemOnly = new Float32Array(W * H)
    stampStem(stemOnly, W, pad, stem)
    for (let i = 0; i < mask.length; i++) if (stemOnly[i] > mask[i]) mask[i] = stemOnly[i]
  }

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
  // 帯だけの板の形（本体の板と同じ ぼかし+smoothstep）。帯の面とリムを本体より濃くする重みに使う (#848)
  let stemW: Float32Array | null = null
  if (stemOnly) {
    stemW = gaussianBlur(stemOnly, W, H, sigma)
    for (let i = 0; i < stemW.length; i++) {
      stemW[i] = smoothstep(
        PLATE_SHAPE_THRESHOLD - SHAPE_EDGE_SOFTNESS,
        PLATE_SHAPE_THRESHOLD + SHAPE_EDGE_SOFTNESS,
        stemW[i]
      )
    }
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
      const sw = stemW ? stemW[i] : 0
      const fillA =
        params.plateFillAlpha + Math.max(0, params.stemFillAlpha - params.plateFillAlpha) * sw
      let a = fillA * s
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
      const rimLit = 0.3 + 0.7 * lit * lit
      const rimLitS = rimLit + Math.max(0, STEM_RIM_LIT_MIN - rimLit) * sw
      over(rimColor, params.lineAlpha * edge * rimLitS * s)
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
