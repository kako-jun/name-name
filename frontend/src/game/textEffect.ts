/**
 * グリフ単位の文字アニメ (#268) の pure 計算ヘルパー。
 *
 * `[文字演出]` ディレクティブのプリセット既定値の正本と、各グリフの stagger 進行
 * （経過 ms → 各グリフの transform 補間値）を PixiJS 非依存で計算する。
 * CharacterLayer.applyTextEffect はこの値を各グリフ PixiText に当てるだけ（配線のみ）。
 *
 * 設計（ADR 0002）: アニメ進行中の中間状態は持たず、経過 ms を入力に毎フレーム純粋計算する。
 * 効果完了後（または復元時）は全グリフが整列・等倍・不透明の「静止状態」になる。
 */

import type { Easing, TextEffectPreset } from '../types'
import { applyEasing, resolveDelta } from './easing'

/**
 * `[文字演出]` イベントの生パラメータ（parser 由来。未指定は undefined）。
 * types.ts の `TextEffect` イベント payload と同形（target を除く）。
 */
export interface TextEffectParams {
  effect?: TextEffectPreset
  /** グリフ間の開始遅延 (ms) */
  stagger_ms?: number
  /** `タイプ` の 1 文字あたり表示時間 (ms) */
  ms_per_char?: number
  /** 開始オフセット（"+40" / "-20" / "40"）。最終整列位置を 0 とする相対開始値 */
  dx?: string
  dy?: string
  /** 開始時の回転 (degrees)。最終は 0 */
  rotation?: string
  /** 開始時のスケール。最終は 1.0 */
  scale?: number
  /** 開始時のアルファ。最終は 1.0 */
  alpha?: number
  /** 各グリフのアニメ所要時間 (ms) */
  duration_ms?: number
  easing?: Easing
}

/**
 * プリセット既定値（transform 系プリミティブ）の正本。
 *
 * テストが期待値を直書きして陳腐化するのを防ぐため export する。
 * 個別プリミティブ（dy= 等）が指定されたらそれが勝つ（resolveTransformEffect 参照）。
 */
export const EXPLODE_PRESET = {
  /** 下から飛び出す（最終整列位置の +40px 下から開始） */
  dy: '+40',
  scale: 0.3,
  alpha: 0,
  stagger_ms: 80,
  duration_ms: 500,
  easing: 'EaseOutBack' as Easing,
} as const

/**
 * `タイプ` プリセット既定値。reveal は typewriter.ts を再利用するため、
 * ここで持つのは 1 文字あたり表示時間のみ。
 */
export const TYPEWRITER_PRESET = {
  /** 1 文字あたり ms（既定 70） */
  ms_per_char: 70,
} as const

/** transform 系プリミティブの既定値（プリセット・個別指定が無いとき）。 */
export const TEXT_EFFECT_DEFAULTS = {
  /** 整列位置を 0 とする相対開始値。既定はオフセット無し（= 静的）。 */
  dx: undefined as string | undefined,
  dy: undefined as string | undefined,
  rotation: undefined as string | undefined,
  scale: undefined as number | undefined,
  alpha: undefined as number | undefined,
  stagger_ms: 0,
  duration_ms: 500,
  easing: 'Linear' as Easing,
} as const

/**
 * transform 系の「解決済みパラメータ」。プリセット展開と個別 override を済ませた後の値。
 * すべて必須化されており、ここから先は純粋に補間計算するだけ。
 */
export interface ResolvedTransformEffect {
  /** enter 開始時の x オフセット (px、最終 = 0 への相対) */
  offsetX: number
  /** enter 開始時の y オフセット (px、最終 = 0 への相対) */
  offsetY: number
  /** enter 開始時の回転 (rad、最終 = 0 への相対) */
  offsetRotationRad: number
  /** enter 開始時のスケール (最終 = 1.0) */
  startScale: number
  /** enter 開始時のアルファ (最終 = 1.0) */
  startAlpha: number
  /** グリフ間の開始遅延 (ms) */
  staggerMs: number
  /** 各グリフのアニメ所要時間 (ms) */
  durationMs: number
  easing: Easing
}

/** 1 グリフの 1 フレーム分の transform 値（最終整列位置を基準とした相対オフセット）。 */
export interface GlyphTransform {
  /** 整列位置からの x オフセット (px)。完了時 0 */
  offsetX: number
  /** 整列位置からの y オフセット (px)。完了時 0 */
  offsetY: number
  /** 回転 (rad)。完了時 0 */
  rotationRad: number
  /** スケール。完了時 1.0 */
  scale: number
  /** アルファ。完了時 1.0 */
  alpha: number
}

/** 整列状態（効果完了 = 静止状態）の GlyphTransform。 */
export const RESTING_GLYPH_TRANSFORM: GlyphTransform = {
  offsetX: 0,
  offsetY: 0,
  rotationRad: 0,
  scale: 1,
  alpha: 1,
}

/**
 * プリセット既定値と個別指定をマージして transform 系の解決済みパラメータを返す。
 *
 * 優先順位: 個別指定 > プリセット既定値 > グローバル既定値。
 * 個別プリミティブ（dy= 等）が undefined のときだけプリセット値を採用する。
 * 数値文字列（dx/dy/rotation）は resolveDelta で「整列位置 0 からの相対オフセット」に解決する。
 * rotation は degrees 入力 → rad 出力（CharacterLayer の規約に合わせる）。
 */
export function resolveTransformEffect(params: TextEffectParams): ResolvedTransformEffect {
  const preset = params.effect === 'Explode' ? EXPLODE_PRESET : null

  // explode を含め現行プリセットは水平オフセット(dx)を持たないため、dx は個別指定か既定のみ。
  const dxExpr = params.dx ?? TEXT_EFFECT_DEFAULTS.dx
  const dyExpr = params.dy ?? preset?.dy ?? TEXT_EFFECT_DEFAULTS.dy
  const rotationExpr = params.rotation ?? TEXT_EFFECT_DEFAULTS.rotation
  const scale = params.scale ?? preset?.scale ?? TEXT_EFFECT_DEFAULTS.scale
  const alpha = params.alpha ?? preset?.alpha ?? TEXT_EFFECT_DEFAULTS.alpha
  const staggerMs = params.stagger_ms ?? preset?.stagger_ms ?? TEXT_EFFECT_DEFAULTS.stagger_ms
  const durationMs = params.duration_ms ?? preset?.duration_ms ?? TEXT_EFFECT_DEFAULTS.duration_ms
  const easing = params.easing ?? preset?.easing ?? TEXT_EFFECT_DEFAULTS.easing

  // 整列位置を 0 とした相対オフセット。current=0 に対して resolveDelta すると
  // "+40" → 40 / "-20" → -20 / "40" → 40 のように開始オフセット値が得られる。
  const offsetX = resolveDelta(dxExpr, 0)
  const offsetY = resolveDelta(dyExpr, 0)
  const offsetDegrees = resolveDelta(rotationExpr, 0)

  return {
    offsetX,
    offsetY,
    offsetRotationRad: (offsetDegrees * Math.PI) / 180,
    startScale: scale ?? 1,
    startAlpha: alpha ?? 1,
    staggerMs: Math.max(0, staggerMs),
    durationMs: Math.max(0, durationMs),
    easing,
  }
}

/**
 * 1 グリフの進行度 [0,1] を返す（easing 適用前の線形時間比）。
 *
 * グリフ i は `i * staggerMs` 遅れて開始する。開始前は 0、duration 経過後は 1。
 * durationMs<=0 は即完了（1）。負の elapsed は 0 にクランプ。
 */
export function glyphLinearProgress(
  elapsedMs: number,
  glyphIndex: number,
  staggerMs: number,
  durationMs: number
): number {
  const safeElapsed = elapsedMs > 0 ? elapsedMs : 0
  const start = Math.max(0, glyphIndex) * Math.max(0, staggerMs)
  const local = safeElapsed - start
  if (local <= 0) return 0
  if (!(durationMs > 0)) return 1
  const t = local / durationMs
  return t >= 1 ? 1 : t
}

/**
 * 1 グリフの 1 フレーム分の transform を計算する（純粋）。
 *
 * 進行度 p を easing 適用し、開始オフセット → 整列位置（0 / 1.0 / 不透明）へ補間する。
 * p=0 で開始オフセット、p=1 で整列状態（RESTING_GLYPH_TRANSFORM 相当）。
 */
export function computeGlyphTransform(
  resolved: ResolvedTransformEffect,
  elapsedMs: number,
  glyphIndex: number
): GlyphTransform {
  const p = glyphLinearProgress(elapsedMs, glyphIndex, resolved.staggerMs, resolved.durationMs)
  const eased = applyEasing(resolved.easing, p)
  // 開始オフセット → 0 / 開始スケール → 1 / 開始アルファ → 1 へ線形補間（eased を係数に）
  return {
    offsetX: resolved.offsetX * (1 - eased),
    offsetY: resolved.offsetY * (1 - eased),
    rotationRad: resolved.offsetRotationRad * (1 - eased),
    scale: resolved.startScale + (1 - resolved.startScale) * eased,
    alpha: resolved.startAlpha + (1 - resolved.startAlpha) * eased,
  }
}

/**
 * 効果全体が完了する経過 ms を返す（最後のグリフが整列し終わる時刻）。
 *
 * 最後のグリフの開始遅延 `(n-1)*staggerMs` + `durationMs`。グリフ 0 個なら 0。
 * fire-and-forget の ticker 停止判定・「効果完了済み」の境界に使う。
 */
export function textEffectTotalDurationMs(
  resolved: ResolvedTransformEffect,
  glyphCount: number
): number {
  if (glyphCount <= 0) return 0
  return (glyphCount - 1) * resolved.staggerMs + resolved.durationMs
}

/**
 * `タイプ` プリセットの 1 文字あたり表示時間 (ms) を解決する。
 * 個別 speed 指定 > プリセット既定 (70)。reveal 自体は typewriter.ts に委譲する。
 */
export function resolveTypewriterMsPerChar(params: TextEffectParams): number {
  return params.ms_per_char ?? TYPEWRITER_PRESET.ms_per_char
}

/** effect が reveal 系（タイプ）かどうか。CharacterLayer の分岐に使う。 */
export function isRevealEffect(params: TextEffectParams): boolean {
  return params.effect === 'Typewriter'
}

/**
 * グリフ幅の配列から、行全体を中央寄せした各グリフの中心 x 座標を返す（純粋）。
 *
 * 各グリフを左端から幅ぶん詰めて並べ、行全体（合計幅）を原点中央に置く。
 * すなわち最初のグリフの左端は `-totalWidth/2`、各グリフの中心 x は
 * 「そのグリフより手前の幅合計 + 自身の半幅 - totalWidth/2」。
 * 返す配列の長さは `widths.length`。空配列なら `[]`。
 *
 * CharacterLayer.applyTextEffect の「totalWidth → cursor=-totalWidth/2 から各グリフ中心」
 * のレイアウトをここに集約し、PixiJS 非依存で境界値テストできるようにする (#268)。
 */
export function layoutGlyphCenters(widths: number[]): number[] {
  let totalWidth = 0
  for (const w of widths) totalWidth += w
  const centers: number[] = new Array(widths.length)
  let cursor = -totalWidth / 2
  for (let i = 0; i < widths.length; i++) {
    const w = widths[i]
    centers[i] = cursor + w / 2
    cursor += w
  }
  return centers
}
