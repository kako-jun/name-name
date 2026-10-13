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
export const DOF_MAX_BLUR_STRENGTH = 12

/**
 * ぼかしコピーの段数。強さの異なるコピーを重ねて、可変半径ガウスぼかしを近似する（段が多いほど滑らか、重い）。
 * 段 k（1..N）の強さは max * k / N。段 k のマスクは勾配の (k-1)/N 地点で 0、k/N 地点で 1 になり、以降は 1。
 */
export const DOF_LEVEL_COUNT = 4

/**
 * ぼかしコピーを背景の四方へ広げる量（論理 px）。画面端でも中央と同じぼけ量にするため、最大ぼかしの
 * フィルタ padding（PixiJS BlurFilter は strength * 2）以上にする。広げた部分はテクスチャの端ピクセルの繰り返し
 * （clamp-to-edge）で埋め、見える範囲はマスク（画面幅）でクリップする。
 */
export const DOF_EDGE_EXTEND = DOF_MAX_BLUR_STRENGTH * 2

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

/**
 * 段ごとの配置を求める（上の段＝弱い → 下の段＝強い）。各要素は `computeDofGradient` と同じ形で、
 * startY はその段のマスクが 0 から立ち上がり始める位置。最後の段は勾配の終端（下端側）で 1 になり、最大の強さ。
 */
export function computeDofLevels(
  screenHeight: number,
  params: DofParams = DOF_DEFAULT_PARAMS,
  levelCount: number = DOF_LEVEL_COUNT
): DofGradient[] {
  const H = Math.max(0, screenHeight)
  const n = Math.max(1, Math.floor(levelCount) || 1)
  const start = clamp01(params.startRatio)
  const ramp = Math.min(clamp01(params.gradientRatio), 1 - start)
  const step = ramp / n
  const max = Number.isNaN(params.maxBlurStrength) ? 0 : Math.max(0, params.maxBlurStrength)
  const levels: DofGradient[] = []
  for (let k = 1; k <= n; k++) {
    const levelStart = start + step * (k - 1)
    const maskHeight = H * (1 - levelStart)
    levels.push({
      startY: H * levelStart,
      maskHeight,
      rampFraction: maskHeight > 0 ? Math.min(1, Math.max(step / (1 - levelStart), 1e-3)) : 1,
      blurStrength: (max * k) / n,
    })
  }
  return levels
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

export interface DofQuad {
  /** 頂点座標（x, y の列。背景スプライト左上を原点とする表示 px）。背景を四方へ extend だけ広げた矩形 */
  positions: Float32Array
  /** 頂点 UV。広げた部分は 0〜1 の外側を指し、clamp-to-edge で端ピクセルの繰り返しになる */
  uvs: Float32Array
  indices: Uint32Array
}

/** 表示サイズ width x height の背景を四方へ extend 広げたぼかしコピー用の矩形（2 三角形）を求める */
export function computeDofQuad(
  width: number,
  height: number,
  extend: number = DOF_EDGE_EXTEND
): DofQuad {
  const w = Math.max(0, width)
  const h = Math.max(0, height)
  const e = Math.max(0, extend)
  const u = w > 0 ? e / w : 0
  const v = h > 0 ? e / h : 0
  return {
    positions: new Float32Array([-e, -e, w + e, -e, w + e, h + e, -e, h + e]),
    uvs: new Float32Array([-u, -v, 1 + u, -v, 1 + u, 1 + v, -u, 1 + v]),
    indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
  }
}
