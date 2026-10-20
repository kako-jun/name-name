/**
 * 一枚絵フィールドのワープ演出 (#864) の純粋関数。DOM / PixiJS には触れない。
 * 暗転（または白）で画面を覆う → 覆っている間にシーンを切り替える → 戻す、の時間計算だけを持つ。
 */

export type WarpEffectKind = 'fade' | 'flash'

export interface WarpTiming {
  /** 画面を覆うまで(ms) */
  outMs: number
  /** 覆ったまま待つ(ms)。この間にシーンを切り替える */
  holdMs: number
  /** 覆いを外すまで(ms) */
  inMs: number
}

/** 演出ごとの既定の時間。fade = 暗転、flash = 白く光って切り替わる（短く出て、ゆっくり戻る） */
export const WARP_DEFAULTS: Record<WarpEffectKind, WarpTiming> = {
  fade: { outMs: 400, holdMs: 200, inMs: 400 },
  flash: { outMs: 250, holdMs: 150, inMs: 500 },
}

/** 覆いの色（0xRRGGBB） */
export const WARP_COLOR: Record<WarpEffectKind, number> = {
  fade: 0x000000,
  flash: 0xffffff,
}

export type WarpPhase = 'out' | 'hold' | 'in' | 'done'

export interface WarpSample {
  phase: WarpPhase
  /** 覆いの不透明度 (0..1) */
  alpha: number
}

/**
 * 開始からの経過 ms での状態。out は 0→1、hold は 1、in は 1→0、全部過ぎたら done（alpha 0）。
 * 時間 0 の区間は飛ばす（outMs = 0 なら最初から hold）。負・NaN の経過は 0 として扱う。
 */
export function sampleWarp(timing: WarpTiming, elapsedMs: number): WarpSample {
  const t = Number.isFinite(elapsedMs) && elapsedMs > 0 ? elapsedMs : 0
  const { outMs, holdMs, inMs } = timing
  if (t < outMs) return { phase: 'out', alpha: t / outMs }
  if (t < outMs + holdMs) return { phase: 'hold', alpha: 1 }
  if (t < outMs + holdMs + inMs) return { phase: 'in', alpha: 1 - (t - outMs - holdMs) / inMs }
  return { phase: 'done', alpha: 0 }
}
