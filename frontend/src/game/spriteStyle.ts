/**
 * スプライト表示スタイル (#737)。
 *
 * 実写背景の上にキャラ・敵を置くと境界が読みにくい。すべてのスプライトに同じ後処理をかけて
 * 「アクリルスタンドに印刷された 2D」に統一する表示スタイルを用意する。エンジン（battleEngine）は
 * 共通のまま、見た目だけを差し替える。
 *
 * このモジュールは純粋関数だけを持つ（dev-doctrine 規律4）。this / PixiJS に触れない。
 * 実際の描画（Container・Graphics・AcrylicEdgeFilter）は BattleScreen 側が、ここで返した数値を使って行う。
 *
 * パラメータはすべて「スプライト枠（slot）一辺 `size` に対する比率」で持つ。画面サイズに依存しない。
 */

/** 表示スタイル。`none` は素材そのまま（既定・後方互換）、`acrylic` はアクリルスタンド風 */
export type SpriteStyle = 'none' | 'acrylic'

/** frontmatter `sprite_style` の値を正規化する。`'acrylic'` 以外（未指定・空・未知値含む）は `'none'` */
export function normalizeSpriteStyle(raw: string | null | undefined): SpriteStyle {
  return raw?.trim().toLowerCase() === 'acrylic' ? 'acrylic' : 'none'
}

/** アクリルスタンド風スタイルのパラメータ。長さはすべてスプライト枠一辺に対する比率 */
export interface AcrylicParams {
  /** 透明な余白の幅（スプライトの輪郭を外へ広げる幅。白で塗らず透明のまま）。枠一辺に対する比率 */
  marginRatio: number
  /** 余白の最小幅(px)。スプライトが小さくても余白が消えないようにする */
  minMarginPx: number
  /** 枠線の太さ（余白の外側に付くリング）。枠一辺に対する比率 */
  lineWidthRatio: number
  /** 枠線の最小太さ(px)。スプライトが小さくても線が潰れないようにする */
  minLinePx: number
  /** 余白の上限(論理 px)。これを超える指定は切り詰める（細い部分の隙間から線が余白に漏れるため。ハード上限 6） */
  maxMarginPx: number
  /** 枠線の太さの上限(論理 px)。ハード上限 4 */
  maxLinePx: number
  /** 枠線の色（0xRRGGBB。淡い白〜青白） */
  lineColor: number
  /** 枠線の不透明度（0〜1。やや不透明） */
  lineAlpha: number
  /** 台座を持つか（false なら台座と床影を描かず、スプライトは枠いっぱいに収める） */
  hasBase: boolean
  /** 台座（黒い円形＝楕円）の幅 / 枠一辺 */
  baseWidthRatio: number
  /** 台座の高さ / 台座の幅（楕円の扁平率。小さいほど薄い） */
  baseHeightRatio: number
  /** 台座上面の反射ハイライトの不透明度（0〜1） */
  highlightAlpha: number
  /** 床の接地影の不透明度（0〜1） */
  shadowAlpha: number
  /** 接地影の大きさ / 台座の大きさ（幅・高さ共通の倍率） */
  shadowScale: number
}

export const DEFAULT_ACRYLIC_PARAMS: AcrylicParams = {
  marginRatio: 0.03,
  minMarginPx: 2,
  lineWidthRatio: 0.02,
  minLinePx: 1.5,
  maxMarginPx: 6,
  maxLinePx: 4,
  lineColor: 0xe6f3ff,
  lineAlpha: 0.85,
  hasBase: true,
  baseWidthRatio: 0.7,
  baseHeightRatio: 0.28,
  highlightAlpha: 0.3,
  shadowAlpha: 0.4,
  shadowScale: 1.2,
}

const clamp = (v: number, min: number, max: number): number => Math.min(max, Math.max(min, v))

function finiteOr(v: number | undefined, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback
}

/**
 * 上書き指定を既定値に重ねて、描画に安全な範囲へ丸める。
 * 非数・負値・範囲外は既定値または境界に倒す（NaN を計算に流さない）。
 */
export function resolveAcrylicParams(overrides?: Partial<AcrylicParams>): AcrylicParams {
  const d = DEFAULT_ACRYLIC_PARAMS
  const o = overrides ?? {}
  return {
    marginRatio: clamp(finiteOr(o.marginRatio, d.marginRatio), 0, 0.15),
    minMarginPx: clamp(finiteOr(o.minMarginPx, d.minMarginPx), 0, 32),
    lineWidthRatio: clamp(finiteOr(o.lineWidthRatio, d.lineWidthRatio), 0, 0.1),
    minLinePx: clamp(finiteOr(o.minLinePx, d.minLinePx), 0, 16),
    maxMarginPx: clamp(finiteOr(o.maxMarginPx, d.maxMarginPx), 0, EDGE_MAX_MARGIN_PX),
    maxLinePx: clamp(finiteOr(o.maxLinePx, d.maxLinePx), 0, EDGE_MAX_LINE_PX),
    lineColor: clamp(Math.floor(finiteOr(o.lineColor, d.lineColor)), 0, 0xffffff),
    lineAlpha: clamp(finiteOr(o.lineAlpha, d.lineAlpha), 0, 1),
    hasBase: typeof o.hasBase === 'boolean' ? o.hasBase : d.hasBase,
    baseWidthRatio: clamp(finiteOr(o.baseWidthRatio, d.baseWidthRatio), 0.1, 1),
    baseHeightRatio: clamp(finiteOr(o.baseHeightRatio, d.baseHeightRatio), 0.05, 1),
    highlightAlpha: clamp(finiteOr(o.highlightAlpha, d.highlightAlpha), 0, 1),
    shadowAlpha: clamp(finiteOr(o.shadowAlpha, d.shadowAlpha), 0, 1),
    shadowScale: clamp(finiteOr(o.shadowScale, d.shadowScale), 1, 2),
  }
}

/** 楕円（中心と半径。枠の左上を原点とした座標） */
export interface EllipseRect {
  cx: number
  cy: number
  rx: number
  ry: number
}

/** 矩形（枠の左上を原点とした座標） */
export interface FitRect {
  x: number
  y: number
  width: number
  height: number
}

export interface AcrylicGeometry {
  /** スプライト本体の配置（contain・縦横比維持・足元を台座の中心に合わせる）。枠の外へはみ出さない */
  sprite: FitRect
  /** 透明な余白の幅(px)。スプライトの輪郭からこの幅は透明のまま */
  marginPx: number
  /** 枠線の太さ(px)。余白の外側に付く。0 なら線を付けない */
  linePx: number
  /** 黒い円形台座。`hasBase: false` のとき null */
  base: EllipseRect | null
  /** 台座上面の反射ハイライト（台座の上寄りの細い楕円）。台座が無いとき null */
  highlight: EllipseRect | null
  /** 床の接地影。台座が無いとき null */
  shadow: EllipseRect | null
}

/**
 * スプライト枠（一辺 `size`・原点は枠の左上）からアクリルスタンド風の各パーツの配置を求める。
 *
 * - 台座と影は枠の下端に置く（影の下端が枠の下端に接する）。影は台座より大きいので、影が枠に収まれば台座も収まる。
 * - スプライトは「枠の上端〜台座の中心」の領域に contain で収め、足元が台座の中心に乗る。
 *   余白と枠線の幅（片側 `marginPx + linePx`）ぶんだけ領域を内側に縮めるので、枠線も枠からはみ出さない。
 *   幅は比率から求めるが、`minMarginPx` / `minLinePx` を下回らない（小さいスプライトで線が 0px にならない）
 *   かつ `maxMarginPx` / `maxLinePx` を超えない（大きな枠でも余白の内側に線が漏れない）。
 * - 影が枠より大きくなる指定（幅比 × 影倍率 > 1）は枠幅に切り詰める。
 * - `size` が 0 以下・非数なら、スプライトは大きさ 0・台座・影・フチなしを返す。
 *   テクスチャ寸法が 0 以下なら、スプライトは上記の領域いっぱいに置く。
 */
export function computeAcrylicGeometry(
  textureWidth: number,
  textureHeight: number,
  size: number,
  params: AcrylicParams = DEFAULT_ACRYLIC_PARAMS
): AcrylicGeometry {
  if (!(size > 0) || !Number.isFinite(size)) {
    return {
      sprite: { x: 0, y: 0, width: 0, height: 0 },
      marginPx: 0,
      linePx: 0,
      base: null,
      highlight: null,
      shadow: null,
    }
  }
  const p = resolveAcrylicParams(params)
  const marginPx = Math.min(p.maxMarginPx, Math.max(p.minMarginPx, p.marginRatio * size))
  const linePx = Math.min(p.maxLinePx, Math.max(p.minLinePx, p.lineWidthRatio * size))
  const margin = marginPx + linePx

  let base: EllipseRect | null = null
  let highlight: EllipseRect | null = null
  let shadow: EllipseRect | null = null
  // スプライトの足元（領域の下端）の y。台座が無ければ枠の下端（フチぶんの余白は別に引く）
  let footY = size - margin
  if (p.hasBase) {
    // 影は台座より大きいので、影の下端が枠の下端に接するように置く。幅は枠幅で頭打ち。
    const baseW = p.baseWidthRatio * size
    const shadowW = Math.min(size, baseW * p.shadowScale)
    // 影を枠幅に切り詰めたとき台座も同じ比率で縮めて、台座 ⊂ 影 の関係を保つ
    const k = shadowW / (baseW * p.shadowScale)
    const baseWc = baseW * k
    const baseH = baseWc * p.baseHeightRatio
    const shadowH = baseH * p.shadowScale
    const cy = size - shadowH / 2
    const cx = size / 2
    shadow = { cx, cy, rx: shadowW / 2, ry: shadowH / 2 }
    base = { cx, cy, rx: baseWc / 2, ry: baseH / 2 }
    highlight = {
      cx,
      cy: cy - base.ry * 0.35,
      rx: base.rx * 0.7,
      ry: base.ry * 0.35,
    }
    footY = cy
  }

  const areaW = Math.max(0, size - margin * 2)
  const areaH = Math.max(0, footY - margin)
  let sprite: FitRect
  if (!(textureWidth > 0) || !(textureHeight > 0)) {
    // テクスチャ寸法が不正: 領域いっぱい
    sprite = { x: margin, y: margin, width: areaW, height: areaH }
  } else {
    const scale = Math.min(areaW / textureWidth, areaH / textureHeight)
    const width = textureWidth * scale
    const height = textureHeight * scale
    // 横は中央、縦は領域の下端（足元）に揃える
    sprite = { x: (size - width) / 2, y: footY - height, width, height }
  }
  return { sprite, marginPx, linePx, base, highlight, shadow }
}

/** 枠線フィルタの余白の上限(論理 px)。これを超えると細い部分の隙間から線が余白の内側に漏れる (#737) */
export const EDGE_MAX_MARGIN_PX = 6
/** 枠線フィルタの線の太さの上限(論理 px) */
export const EDGE_MAX_LINE_PX = 4
/**
 * 内側（余白）サンプルの間隔の上限(論理 px。同心円の半径方向も、円周上の隣接サンプルも)。
 * 2px 幅の細い部分が余白の内側で取りこぼされない最大間隔（3px だと 2px 幅の棒・角で線が漏れる）。
 */
export const EDGE_INNER_SPACING_PX = 2
/** 外側（余白+線の縁の円）サンプルの円周方向の間隔の上限(論理 px)。線の輪郭の滑らかさにだけ効く */
export const EDGE_OUTER_SPACING_PX = 3
/** 1 ピクセルあたりのサンプル数（中心の 1 タップは除く）の上限。`AcrylicEdgeFilter` の性能予算 */
export const EDGE_MAX_TAPS = 64
/** 内側（余白の縁まで）サンプルの最大数。最悪（余白 6px）で 39 */
export const EDGE_MAX_INNER_TAPS = 40
/** 外側（余白+線の縁）サンプルの最大数。最悪（余白+線 10px）で 21 */
export const EDGE_MAX_OUTER_TAPS = 24

/** 周囲サンプルの変位（フィルタテクスチャの実 px。x,y） */
export type EdgeOffset = readonly [number, number]

export interface EdgeOffsets {
  /** 余白の内側を調べる変位。本体からの距離が余白未満なら、どれかが本体に当たる */
  inner: EdgeOffset[]
  /** 余白+線の縁の円を調べる変位 */
  outer: EdgeOffset[]
}

const finiteNonNeg = (v: number): number => (Number.isFinite(v) && v > 0 ? v : 0)

/** 半径 `r`(論理 px) の円周を、隣接サンプル間隔が `spacing` 以下になる方向数で刻む。`phase`(0〜1) は角度のずらし */
function ringOffsets(r: number, phase: number, scale: number, spacing: number): EdgeOffset[] {
  const n = Math.max(6, Math.ceil((2 * Math.PI * r) / spacing))
  const out: EdgeOffset[] = []
  for (let i = 0; i < n; i++) {
    const a = ((i + phase) * 2 * Math.PI) / n
    out.push([Math.cos(a) * r * scale, Math.sin(a) * r * scale])
  }
  return out
}

/**
 * 枠線フィルタ（`AcrylicEdgeFilter`）が周囲の alpha を調べる変位の列を求める。シェーダは
 * 「この列の alpha の最大値」を取るだけで、配置はすべてここ（テストできる側）が決める。
 *
 *   ring = clamp(max(outer 列) − max(inner 列), 0, 1)   （本体 alpha も両方に含める）
 *
 * - `marginPx` / `linePx` は論理 px。`EDGE_MAX_MARGIN_PX` / `EDGE_MAX_LINE_PX` に切り詰める（配列長の上限を守る）。
 * - サンプルの**配置は論理 px で決める**（隙間の検出力が解像度に依存しない・タップ数も増えない）。
 *   返す変位は実 px（論理 px × `resolution`）。フィルタテクスチャは実 px 単位なので、そのまま 1/pixelWidth を掛ければ UV になる。
 * - inner: 半径 `margin*k/n`（n = ceil(margin / `EDGE_INNER_SPACING_PX`)、k=1..n）の同心円。最外の円が余白の縁。
 *   円ごとに方向数（半径に比例、下限 6）と角度の位相をずらし、放射状の抜けを避ける。
 * - outer: 半径 `margin + line` の円 1 つ。線が 0 なら空。
 * - 非数・負値は 0、`resolution` は 0 以下・非数なら 1。
 */
export function computeEdgeOffsets(marginPx: number, linePx: number, resolution = 1): EdgeOffsets {
  const m = Math.min(EDGE_MAX_MARGIN_PX, finiteNonNeg(marginPx))
  const l = Math.min(EDGE_MAX_LINE_PX, finiteNonNeg(linePx))
  const res = finiteNonNeg(resolution) || 1
  const inner: EdgeOffset[] = []
  if (m > 0) {
    const n = Math.ceil(m / EDGE_INNER_SPACING_PX)
    for (let k = 1; k <= n; k++) {
      // 黄金比の小数で円ごとに位相をずらす
      inner.push(...ringOffsets((m * k) / n, (k * 0.381966) % 1, res, EDGE_INNER_SPACING_PX))
    }
  }
  const outer: EdgeOffset[] = l > 0 ? ringOffsets(m + l, 0.5, res, EDGE_OUTER_SPACING_PX) : []
  return { inner, outer }
}
