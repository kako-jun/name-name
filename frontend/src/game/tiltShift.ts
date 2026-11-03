/**
 * フィールド最終合成の上下チルトシフト (#885)。
 *
 * 背景・フィールドキャラ・前景をすべて描いた後の最終合成（`fieldComposite`）へ、1 回だけ掛ける。
 * 画面の中央（操作域）は鮮明のまま、上端・下端へ向かうほど強くぼかす。中心に対して上下対称。
 * 設定 JSON の `tiltShift: "on"`（既定 off＝現行の描画のまま）で有効化する。
 *
 * 戦闘背景のDoF（`depthOfField.ts`、下側 50% だけ・段階的 BlurFilter のコピー重ね）とは独立で、そちらは変えない。
 * こちらは全画面が対象でキャラも含めてぼかすので、1 本のフラグメントシェーダ（`TiltShiftFilter`）で
 * 「行ごとの半径」を直接求めてぼかす（段階コピーの重ね合わせより 1 パスで済み、継ぎ目も出ない）。
 *
 * このモジュールは純粋関数と定数だけを持つ（PixiJS に触れない）。シェーダの式はここの `tiltShiftBlurRadius` と同じ。
 * 見た目は実機でライブ調整するので、調整対象の定数はここ一箇所に集める。
 */

/** ぼかしを始める位置。画面中心から上下端までの距離を 1 としたときの比（これより内側は完全に鮮明）。目視で調整する値 */
export const TILT_SHIFT_FOCUS_RATIO = 0.45
/** 上下端でのぼかしの最大半径（論理 px。device px ではなく入力テクスチャ px）。目視で調整する値 */
export const TILT_SHIFT_MAX_BLUR_PX = 9
/** ぼかしのサンプル数（黄金角のスパイラル。多いほど滑らか、重い） */
export const TILT_SHIFT_SAMPLE_COUNT = 24

export interface TiltShiftParams {
  focusRatio: number
  maxBlurPx: number
}

export const TILT_SHIFT_DEFAULT_PARAMS: TiltShiftParams = {
  focusRatio: TILT_SHIFT_FOCUS_RATIO,
  maxBlurPx: TILT_SHIFT_MAX_BLUR_PX,
}

function clamp01(n: number): number {
  return Number.isNaN(n) ? 0 : Math.min(1, Math.max(0, n))
}

/** GLSL の smoothstep(edge0, edge1, x) と同じ。edge0 >= edge1 のときは階段（x >= edge1 で 1） */
export function smoothstep(edge0: number, edge1: number, x: number): number {
  if (edge1 <= edge0) return x >= edge1 ? 1 : 0
  const t = clamp01((x - edge0) / (edge1 - edge0))
  return t * t * (3 - 2 * t)
}

/**
 * 画面の縦位置 yRatio（0=最上端、1=最下端）でのぼかしの強さの割合（0=鮮明、1=最大）。
 * 中心からの距離 |2y-1|（中心 0、上下端 1）で決まるので、上下対称。focusRatio 以内は 0、端で 1。
 */
export function tiltShiftBlurRatio(
  yRatio: number,
  params: TiltShiftParams = TILT_SHIFT_DEFAULT_PARAMS
): number {
  const y = clamp01(yRatio)
  const d = Math.abs(2 * y - 1)
  return smoothstep(clamp01(params.focusRatio), 1, d)
}

/** 縦位置 yRatio でのぼかし半径（px）。最大半径は 0 以上（NaN は 0） */
export function tiltShiftBlurRadius(
  yRatio: number,
  params: TiltShiftParams = TILT_SHIFT_DEFAULT_PARAMS
): number {
  const max = Number.isNaN(params.maxBlurPx) ? 0 : Math.max(0, params.maxBlurPx)
  return max * tiltShiftBlurRatio(yRatio, params)
}

/**
 * 黄金角スパイラルのサンプル配置（単位円内の相対位置）。i 番目は半径 sqrt((i+0.5)/n)、角度 i * 黄金角。
 * シェーダも同じ式で生成する。重みは均等。
 */
export function tiltShiftSampleOffsets(
  count: number = TILT_SHIFT_SAMPLE_COUNT
): { x: number; y: number }[] {
  const n = Math.max(1, Math.floor(count) || 1)
  const golden = Math.PI * (3 - Math.sqrt(5))
  const out: { x: number; y: number }[] = []
  for (let i = 0; i < n; i++) {
    const r = Math.sqrt((i + 0.5) / n)
    const a = i * golden
    out.push({ x: Math.cos(a) * r, y: Math.sin(a) * r })
  }
  return out
}
