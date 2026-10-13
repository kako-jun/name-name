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
  /** 輪郭に沿った白フチの太さ */
  outlineWidthRatio: number
  /** 白フチの外側にある透明アクリル縁の太さ */
  rimWidthRatio: number
  /** 透明アクリル縁の不透明度（0〜1。ごく薄く） */
  rimAlpha: number
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
  outlineWidthRatio: 0.03,
  rimWidthRatio: 0.02,
  rimAlpha: 0.25,
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
    outlineWidthRatio: clamp(finiteOr(o.outlineWidthRatio, d.outlineWidthRatio), 0, 0.15),
    rimWidthRatio: clamp(finiteOr(o.rimWidthRatio, d.rimWidthRatio), 0, 0.1),
    rimAlpha: clamp(finiteOr(o.rimAlpha, d.rimAlpha), 0, 1),
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
  /** 白フチの太さ(px)。0 ならフチを付けない */
  outlineWidth: number
  /** 透明アクリル縁の「白フチの外側」の太さ(px)。0 なら縁を付けない */
  rimWidth: number
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
 *   白フチ・縁の太さ（片側 `outlineWidth + rimWidth`）ぶんだけ領域を内側に縮めるので、フチも枠からはみ出さない。
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
      outlineWidth: 0,
      rimWidth: 0,
      base: null,
      highlight: null,
      shadow: null,
    }
  }
  const p = resolveAcrylicParams(params)
  const outlineWidth = p.outlineWidthRatio * size
  const rimWidth = p.rimWidthRatio * size
  const margin = outlineWidth + rimWidth

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
  return { sprite, outlineWidth, rimWidth, base, highlight, shadow }
}
