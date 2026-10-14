/**
 * スプライト表示スタイル (#737)。
 *
 * 実写背景の上にキャラ・敵を置くと境界が読みにくい。すべてのスプライトに同じ後処理をかけて
 * 「アクリルスタンドに印刷された 2D」に統一する表示スタイルを用意する。エンジン（battleEngine）は
 * 共通のまま、見た目だけを差し替える。
 *
 * このモジュールは純粋関数だけを持つ（dev-doctrine 規律4）。this / PixiJS に触れない。
 * 実際の描画（Container・Graphics・アクリル板のスプライト）は BattleScreen 側が、ここで返した数値を使って行う。
 *
 * パラメータはすべて「スプライト枠（slot）一辺 `size` に対する比率」で持つ。画面サイズに依存しない。
 */

import { computeSlitY } from './acrylicBase'

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
  /** 板の内側の面の不透明度（0〜1。ごく薄い白〜水色で、背景がほぼ透ける）(#760) */
  plateFillAlpha: number
  /** 板の斜めの鏡面ハイライト（左上寄りの筋）の不透明度（0〜1）(#760) */
  specularAlpha: number
  /** 板の縁の内側の影（光と反対側）の不透明度（0〜1）(#760) */
  innerShadowAlpha: number
  /** 台座の側面の厚み / 上面の楕円の半径 ry (#760)。0 で厚みなし */
  baseThicknessRatio: number
  /** 台座の上面（透明アクリル）の面の不透明度（0〜1）(#760) */
  baseFillAlpha: number
  /** 台座の側面の帯の不透明度（0〜1。上面より少し濃い透明）(#760) */
  baseSideAlpha: number
  /** 台座の板の差し込み口（スリット）の暗さ（0〜1）(#760) */
  slitAlpha: number
  /** 地面に落とすアクスタ本体の影の不透明度（0〜1）(#760) */
  castAlpha: number
  /** 影を縦につぶす率（0.1〜1。小さいほど地面に寝る）(#760) */
  castSquash: number
  /** 影を右へ傾ける量（つぶした高さ 1px あたりの右へのずれ px。-2〜2）(#760) */
  castShear: number
  /** 影のぼかし半径 / 画像の長辺（0〜0.1）(#760) */
  castBlurRatio: number
  /** スプライト下端を台座の差し込み線より浮かせる量 / スプライト高さ (#802)。板は差し込み線まで下へ伸び、台座が無いときは効かない */
  spriteLiftRatio: number
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
  plateFillAlpha: 0.07,
  specularAlpha: 0.2,
  innerShadowAlpha: 0.12,
  baseThicknessRatio: 0.18,
  baseFillAlpha: 0.14,
  baseSideAlpha: 0.26,
  slitAlpha: 0.3,
  castAlpha: 0.55,
  castSquash: 0.35,
  castShear: 1.4,
  castBlurRatio: 0.012,
  spriteLiftRatio: 0.03,
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
    plateFillAlpha: clamp(finiteOr(o.plateFillAlpha, d.plateFillAlpha), 0, 1),
    specularAlpha: clamp(finiteOr(o.specularAlpha, d.specularAlpha), 0, 1),
    innerShadowAlpha: clamp(finiteOr(o.innerShadowAlpha, d.innerShadowAlpha), 0, 1),
    baseThicknessRatio: clamp(finiteOr(o.baseThicknessRatio, d.baseThicknessRatio), 0, 0.2),
    baseFillAlpha: clamp(finiteOr(o.baseFillAlpha, d.baseFillAlpha), 0, 1),
    baseSideAlpha: clamp(finiteOr(o.baseSideAlpha, d.baseSideAlpha), 0, 1),
    slitAlpha: clamp(finiteOr(o.slitAlpha, d.slitAlpha), 0, 1),
    castAlpha: clamp(finiteOr(o.castAlpha, d.castAlpha), 0, 1),
    castSquash: clamp(finiteOr(o.castSquash, d.castSquash), 0.1, 1),
    castShear: clamp(finiteOr(o.castShear, d.castShear), -2, 2),
    castBlurRatio: clamp(finiteOr(o.castBlurRatio, d.castBlurRatio), 0, 0.1),
    spriteLiftRatio: clamp(finiteOr(o.spriteLiftRatio, d.spriteLiftRatio), 0, 0.15),
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
  /** スプライト下端から台座の差し込み線までの距離(px)。台座が無いとき 0 (#802) */
  liftPx: number
}

/**
 * スプライト枠（一辺 `size`・原点は枠の左上）からアクリルスタンド風の各パーツの配置を求める。
 *
 * - 台座と影は枠の下端に置く（影の下端が枠の下端に接する）。影は台座より大きいので、影が枠に収まれば台座も収まる。
 *   台座の側面の厚み（`baseThicknessRatio` × 上面の縦半径）ぶんは下に予約し、足元の楕円（上面の中心から厚みだけ下）の影が枠の下端に接する。
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
      liftPx: 0,
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
  let liftRatio = 0
  if (p.hasBase) {
    // 影は台座より大きいので、影の下端が枠の下端に接するように置く。幅は枠幅で頭打ち。
    const baseW = p.baseWidthRatio * size
    const shadowW = Math.min(size, baseW * p.shadowScale)
    // 影を枠幅に切り詰めたとき台座も同じ比率で縮めて、台座 ⊂ 影 の関係を保つ
    const k = shadowW / (baseW * p.shadowScale)
    const baseWc = baseW * k
    const baseH = baseWc * p.baseHeightRatio
    const shadowH = baseH * p.shadowScale
    // 台座の側面の厚み（透明アクリルの台座は上面の下へ押し出される）ぶんを下に予約して、枠の下端に実際に収める (#760)
    const thickness = (baseH / 2) * p.baseThicknessRatio
    const cy = size - shadowH / 2 - thickness
    const cx = size / 2
    shadow = { cx, cy, rx: shadowW / 2, ry: shadowH / 2 }
    base = { cx, cy, rx: baseWc / 2, ry: baseH / 2 }
    highlight = {
      cx,
      cy: cy - base.ry * 0.35,
      rx: base.rx * 0.7,
      ry: base.ry * 0.35,
    }
    // スプライトの下端は差し込み線より liftRatio ぶん上に浮かせる（本物のアクスタは絵が線より上、板の下の縁が台座に刺さる）(#802)
    footY = computeSlitY(cy, base.ry)
    liftRatio = p.spriteLiftRatio
  }

  const areaW = Math.max(0, size - margin * 2)
  const areaH = Math.max(0, footY - margin)
  let sprite: FitRect
  if (!(textureWidth > 0) || !(textureHeight > 0)) {
    // テクスチャ寸法が不正: 領域いっぱい
    sprite = { x: margin, y: margin, width: areaW, height: areaH / (1 + liftRatio) }
  } else {
    // 浮かせる量はスプライト高さの比率なので、高さ + 浮き = 領域の高さ になるよう縮める
    const scale = Math.min(areaW / textureWidth, areaH / (textureHeight * (1 + liftRatio)))
    const width = textureWidth * scale
    const height = textureHeight * scale
    // 横は中央、縦は領域の下端（足元）から浮き量だけ上に揃える
    sprite = { x: (size - width) / 2, y: footY - height * (1 + liftRatio), width, height }
  }
  const liftPx = sprite.height * liftRatio
  return { sprite, marginPx, linePx, base, highlight, shadow, liftPx }
}

/** 余白の上限(論理 px)。これを超えると細い部分の隙間から線が余白の内側に漏れる (#737) */
export const EDGE_MAX_MARGIN_PX = 6
/** 線の太さの上限(論理 px) */
export const EDGE_MAX_LINE_PX = 4
