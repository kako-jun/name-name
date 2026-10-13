/**
 * スプライト表示スタイル (#737)。
 *
 * 実写背景の上にキャラ・敵を置くと境界が読みにくい。すべてのスプライトに同じ後処理をかけて
 * 「アクリルスタンドに印刷された 2D」に統一する表示スタイルを用意する。エンジン（battleEngine）は
 * 共通のまま、見た目だけを差し替える。
 *
 * このモジュールは純粋関数だけを持つ（dev-doctrine 規律4）。this / PixiJS に触れない。
 * 実際の描画（Container・Graphics・OutlineFilter）は BattleScreen 側が、ここで返した数値を使って行う。
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
 *   幅は比率から求めるが、`minMarginPx` / `minLinePx` を下回らない（小さいスプライトで線が 0px にならない）。
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
  const marginPx = Math.max(p.minMarginPx, p.marginRatio * size)
  const linePx = Math.max(p.minLinePx, p.lineWidthRatio * size)
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

/** 1 ピクセルあたりのサンプル数（タップ）の上限。`AcrylicEdgeFilter` の性能予算 */
export const EDGE_MAX_TAPS = 48

export interface EdgeSampling {
  /** 余白の縁の円まで、内側を刻む段数（1〜2。割り合いで `margin*k/n`） */
  innerRings: number
  /** 余白の縁から余白+線の縁までを刻む段数（1〜2） */
  outerRings: number
  /** 方向数（8〜16）。`(innerRings + outerRings) * directions` が `EDGE_MAX_TAPS` 以下 */
  directions: number
}

/**
 * 枠線フィルタの周囲サンプリング数を、余白と線の半径（フィルタテクスチャ上の px）から決める。
 * 半径が大きいほど段数・方向数を増やし、総タップは `EDGE_MAX_TAPS` 以下に収める。
 * 方向数は外周の隣接サンプル間隔がおよそ 2.5px 以下になる数（下限 8、上限 16 かつ予算内）。
 * 非数・負値は 0 として扱う。
 */
export function computeEdgeSampling(marginTexPx: number, lineTexPx: number): EdgeSampling {
  const m = Number.isFinite(marginTexPx) && marginTexPx > 0 ? marginTexPx : 0
  const l = Number.isFinite(lineTexPx) && lineTexPx > 0 ? lineTexPx : 0
  const innerRings = clamp(Math.ceil(m / 3), 1, 2)
  const outerRings = clamp(Math.ceil(l / 2), 1, 2)
  const rings = innerRings + outerRings
  const cap = Math.min(16, Math.floor(EDGE_MAX_TAPS / rings))
  const wanted = Math.ceil((2 * Math.PI * (m + l)) / 2.5)
  return { innerRings, outerRings, directions: clamp(wanted, 8, cap) }
}
