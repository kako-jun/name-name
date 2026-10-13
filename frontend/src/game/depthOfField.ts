/**
 * 戦闘背景の被写界深度（DoF）風の手前ぼかし (#753)。
 *
 * 背景スプライトにだけ、画面の下側（手前）を下へ行くほど強くぼかす。上（水平線側）・キャラ・敵・
 * パネル・テキストはぼかさない。frontmatter `battle_background_dof: on|off`（既定 off）で有効化する。
 *
 * 実現方法: 背景と同じテクスチャのぼかしコピーを、縦グラデーションのアルファマスクで背景の上に重ねる。
 * コピーはテクスチャを共有するのでメモリは倍にならない。
 *
 * このモジュールは純粋関数と定数だけを持つ（PixiJS に触れない）。スプライト・フィルタ・マスクの
 * 生成と破棄は BattleScreen 側。見た目は実機でライブ調整するので、調整対象の定数はここ一箇所に集める。
 */

export type BackgroundDof = 'on' | 'off'

/** ぼかしを始める位置（画面高さの割合。0 = 最上端、1 = 最下端）。これより上はくっきり。目視で調整する値 */
export const DOF_START_RATIO = 0.5
/** ぼかしが最大に達するまでのグラデーション幅（画面高さの割合）。開始位置からこの幅で 0 → 最大へ。目視で調整する値 */
export const DOF_GRADIENT_RATIO = 0.5
/** 最大のぼかしの強さ（PixiJS BlurFilter の strength）。目視で調整する値 */
export const DOF_MAX_BLUR_STRENGTH = 6

/** マスク用グラデーションテクスチャの縦解像度（px）。1 x この値の canvas を縦に引き伸ばして使う */
export const DOF_MASK_TEXTURE_HEIGHT = 256

export interface DofGradient {
  /** ぼかしコピーの表示（マスク）領域の上端 y（論理 px） */
  startY: number
  /** マスク領域の高さ（startY から画面下端まで） */
  maskHeight: number
  /** マスク領域のうちアルファが 0 → 1 に立ち上がる部分の割合（0 < r <= 1）。残りは完全にぼかしコピー */
  rampFraction: number
  /** BlurFilter の strength */
  blurStrength: number
}

export interface DofParams {
  startRatio: number
  gradientRatio: number
  maxBlurStrength: number
}

export const DOF_DEFAULT_PARAMS: DofParams = {
  startRatio: DOF_START_RATIO,
  gradientRatio: DOF_GRADIENT_RATIO,
  maxBlurStrength: DOF_MAX_BLUR_STRENGTH,
}

/** frontmatter `battle_background_dof` の値を正規化する。`'on'` 以外（未指定・空・未知値含む）は `'off'` */
export function normalizeBackgroundDof(raw: string | null | undefined): BackgroundDof {
  return typeof raw === 'string' && raw.trim().toLowerCase() === 'on' ? 'on' : 'off'
}

function clamp01(n: number): number {
  return Number.isNaN(n) ? 0 : Math.min(1, Math.max(0, n))
}

/**
 * 画面高さからぼかしグラデーションの配置を求める。
 * 開始位置は 0〜1 にクランプ。グラデーション幅は画面下端を越えないように切り詰め（下端では必ず最大）、
 * 幅 0 でもゼロ除算しない最小値を持つ。最大強さは 0 以上（NaN は 0）。
 */
export function computeDofGradient(
  screenHeight: number,
  params: DofParams = DOF_DEFAULT_PARAMS
): DofGradient {
  const H = Math.max(0, screenHeight)
  const start = clamp01(params.startRatio)
  const maskHeight = H * (1 - start)
  const rampRatio = Math.min(clamp01(params.gradientRatio), 1 - start)
  // 1 - start が 0（開始が最下端）のときは maskHeight も 0。比率は 1 に固定してゼロ除算を避ける
  const rampFraction = maskHeight > 0 ? Math.max(rampRatio / (1 - start), 1e-3) : 1
  return {
    startY: H * start,
    maskHeight,
    rampFraction: Math.min(1, rampFraction),
    blurStrength: Number.isNaN(params.maxBlurStrength) ? 0 : Math.max(0, params.maxBlurStrength),
  }
}

/** マスク領域内の縦位置 t（0 = 上端、1 = 下端）でのアルファ。ramp までは 0 → 1 の線形、以降は 1 */
export function dofAlphaAt(t: number, rampFraction: number): number {
  if (Number.isNaN(t)) return 0
  const r = Math.min(1, Math.max(1e-3, rampFraction))
  return clamp01(t / r)
}

/** canvas グラデーションの色止め（offset 0〜1、alpha 0〜1）。`dofAlphaAt` と一致する */
export function dofMaskStops(rampFraction: number): { offset: number; alpha: number }[] {
  const r = Math.min(1, Math.max(1e-3, rampFraction))
  return r >= 1
    ? [
        { offset: 0, alpha: 0 },
        { offset: 1, alpha: 1 },
      ]
    : [
        { offset: 0, alpha: 0 },
        { offset: r, alpha: 1 },
        { offset: 1, alpha: 1 },
      ]
}
