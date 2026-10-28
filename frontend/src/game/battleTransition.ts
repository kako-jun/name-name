/**
 * 戦闘の開始・終了の画面遷移の時間計算（純粋関数） (#830)。PixiJS には触れない。
 *
 * - 開始（エンカウント発火 → 戦闘画面）: 「ドゥン、ドゥン」と 2 段に分けて操作キャラ付近へズームインしながら暗転し、真っ暗になったら戦闘画面へ
 * - 終了（戦闘画面 → フィールド）: フェードアウト（黒）→ 黒の間（追加画面を挟める）→ フェードイン
 *
 * 時間・ズーム量はすべて `BattleTransitionParams` の仮の値。#803（FF5・6 の戦闘テンポの測定）の値で差し替える前提で、
 * ここ以外に数値を置かない。演出の経過時間はレンダラー（`FieldBattleTransition`）の private で、GameState には載せない（ADR 0002）。
 */

/** `battle_transition`。`none`（既定・現行の挙動）/ `ff` / `ff-mosaic`（`ff` に暗さと連動するモザイクを足す #953） */
export type BattleTransitionMode = 'none' | 'ff' | 'ff-mosaic'

/** frontmatter の生文字列 → モード。`ff` / `ff-mosaic` 以外（未指定・空・未知値）は `none`（大小・前後空白は無視） */
export function normalizeBattleTransition(raw: string | null | undefined): BattleTransitionMode {
  if (typeof raw !== 'string') return 'none'
  const v = raw.trim().toLowerCase()
  return v === 'ff' || v === 'ff-mosaic' ? v : 'none'
}

/** 画面遷移（ズーム・暗転）を再生するモードか。`ff` と `ff-mosaic`。`mode === 'ff'` の直接比較は取りこぼすので、判定はこれを使う */
export function isBattleTransitionEnabled(mode: BattleTransitionMode | undefined): boolean {
  return mode === 'ff' || mode === 'ff-mosaic'
}

/** `ff-mosaic` の最大ブロックサイズ（px）。既存の切替モザイク（`PIXELATE_TRANSITION_MAX_SIZE` = 24）より控えめ */
export const TRANSITION_MOSAIC_MAX_SIZE = 12

/** ズームの 1 段 */
export interface EnterStage {
  /** 段の始まり（演出開始からの ms）。ここで音のきっかけ `onTransitionBeat(n)` が出る */
  startMs: number
  /** この段が終わったときのズーム倍率（1 = 等倍） */
  zoom: number
  /** この段が終わったときの暗さ（0 = 透明 〜 1 = 真っ黒） */
  dark: number
  /** 前の段の値からこの段の値へ動く時間 */
  easeMs: number
}

export interface BattleTransitionParams {
  /** 開始のズーム段（開始時刻の昇順）。段の番号は 1 始まり */
  enterStages: readonly EnterStage[]
  /** 最後の段のあと、真っ暗になるまでの暗転を始める時刻と長さ */
  enterFadeStartMs: number
  enterFadeMs: number
  /** 真っ暗のまま待ってから戦闘画面へ切り替える時間 */
  enterBlackMs: number
  /** 終了: フェードアウト（黒へ） */
  exitFadeOutMs: number
  /** 終了: 黒のまま待つ最短時間（追加画面があればその長さがこれに足される） */
  exitBlackMs: number
  /** 終了: フェードイン（フィールドへ） */
  exitFadeInMs: number
  /** 暗転に連動するモザイクの最大ブロックサイズ（px）。0 = 無効（従来どおり）#953 */
  mosaicMaxSize: number
}

/** 仮の値。#803 の測定値で差し替える */
export const DEFAULT_BATTLE_TRANSITION_PARAMS: Readonly<BattleTransitionParams> = {
  enterStages: [
    { startMs: 0, zoom: 1.3, dark: 0.25, easeMs: 160 },
    { startMs: 380, zoom: 1.9, dark: 0.55, easeMs: 160 },
  ],
  enterFadeStartMs: 640,
  enterFadeMs: 260,
  enterBlackMs: 120,
  exitFadeOutMs: 300,
  exitBlackMs: 100,
  exitFadeInMs: 300,
  mosaicMaxSize: 0,
}

/** モードに応じた遷移パラメータ。`ff-mosaic` だけモザイクが有効 */
export function battleTransitionParams(
  mode: BattleTransitionMode | undefined
): BattleTransitionParams {
  return mode === 'ff-mosaic'
    ? { ...DEFAULT_BATTLE_TRANSITION_PARAMS, mosaicMaxSize: TRANSITION_MOSAIC_MAX_SIZE }
    : DEFAULT_BATTLE_TRANSITION_PARAMS
}

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v)
const easeOutCubic = (t: number): number => 1 - Math.pow(1 - clamp01(t), 3)
const lerp = (a: number, b: number, t: number): number => a + (b - a) * t

/**
 * 幕の濃さ alpha（0 = 透明 〜 1 = 真っ黒）から、遷移中のモザイクのブロックサイズを返す (#953)。
 * alpha 0 → 1（等倍）、alpha 1 → maxSize へ線形・単調。丸め・下限は `computeCoarsenSize` と同じ（size 1 = 等倍）。
 * NaN・範囲外の alpha は 0〜1 に丸め、maxSize が非有限・1 以下なら常に 1。
 */
export function transitionMosaicSize(alpha: number, maxSize: number): number {
  const a = Number.isFinite(alpha) ? clamp01(alpha) : 0
  const m = Number.isFinite(maxSize) && maxSize > 1 ? maxSize : 1
  return Math.max(1, Math.round(1 + a * (m - 1)))
}

/** 開始演出のある時刻の状態 */
export interface EnterSample {
  /** ズーム倍率（1 = 等倍） */
  zoom: number
  /** 暗転の透明度の逆（0 = 透明 〜 1 = 真っ黒） */
  alpha: number
  /** 始まっている段の番号（0 = まだどの段も始まっていない） */
  stage: number
  /** 真っ暗になって戦闘画面へ切り替える時刻に達した */
  done: boolean
}

export function sampleEnter(elapsedMs: number, p: BattleTransitionParams): EnterSample {
  const t = Math.max(0, elapsedMs)
  let zoom = 1
  let dark = 0
  let stage = 0
  for (let i = 0; i < p.enterStages.length; i++) {
    const s = p.enterStages[i]
    if (t < s.startMs) break
    stage = i + 1
    const k = s.easeMs > 0 ? easeOutCubic((t - s.startMs) / s.easeMs) : 1
    const prevZoom = i === 0 ? 1 : p.enterStages[i - 1].zoom
    const prevDark = i === 0 ? 0 : p.enterStages[i - 1].dark
    zoom = lerp(prevZoom, s.zoom, k)
    dark = lerp(prevDark, s.dark, k)
  }
  let alpha = dark
  if (t >= p.enterFadeStartMs) {
    const f = p.enterFadeMs > 0 ? clamp01((t - p.enterFadeStartMs) / p.enterFadeMs) : 1
    alpha = lerp(dark, 1, f)
  }
  return {
    zoom,
    alpha,
    stage,
    done: t >= p.enterFadeStartMs + p.enterFadeMs + p.enterBlackMs,
  }
}

/** 終了演出の段階 */
export type ExitPhase = 'fadeOut' | 'black' | 'fadeIn'

export interface ExitSample {
  /** 0 = 透明 〜 1 = 真っ黒 */
  alpha: number
  phase: ExitPhase
  /** 終了演出がすべて終わった */
  done: boolean
}

/** `interludeMs`: 黒の間に挟む追加画面の長さ（無ければ 0） */
export function sampleExit(
  elapsedMs: number,
  p: BattleTransitionParams,
  interludeMs: number
): ExitSample {
  const t = Math.max(0, elapsedMs)
  const blackEnd = p.exitFadeOutMs + p.exitBlackMs + Math.max(0, interludeMs)
  if (t < p.exitFadeOutMs) {
    const f = p.exitFadeOutMs > 0 ? t / p.exitFadeOutMs : 1
    return { alpha: clamp01(f), phase: 'fadeOut', done: false }
  }
  if (t < blackEnd) return { alpha: 1, phase: 'black', done: false }
  const f = p.exitFadeInMs > 0 ? (t - blackEnd) / p.exitFadeInMs : 1
  return { alpha: clamp01(1 - f), phase: 'fadeIn', done: t >= blackEnd + p.exitFadeInMs }
}
