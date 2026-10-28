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

/**
 * 遷移先シーンの読み込みを待つ上限 (ms)。これを超えたらワープを中止して元のシーンに戻す。
 * 暗転のまま無期限に待たないための安全弁（通常の画像読み込みは数秒以内に終わる）。
 */
export const WARP_LOAD_TIMEOUT_MS = 15000

/** 上限 ms で打ち切る Promise。超えたら message の Error で reject する（元の Promise は放置） */
export function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms)
    p.then(
      (v) => {
        clearTimeout(timer)
        resolve(v)
      },
      (e) => {
        clearTimeout(timer)
        reject(e)
      }
    )
  })
}

/** フィールドの状態。戦闘・エリア遷移・ワープのどれかの最中は「取り込み中」 */
export interface FieldBusyState {
  battle: boolean
  transition: boolean
  warping: boolean
  /** NPC と会話中 (#841)。省略 = 会話していない */
  talking?: boolean
}

/**
 * 「今すぐエンカウント」ボタンなど、外から戦闘を始めてよいか。取り込み中は不可。
 * ワープ中に戦闘を始めると、戦闘とワープが同時に走って暗転が戻らなくなる。
 */
export function canStartBattleNow(s: FieldBusyState): boolean {
  return !s.battle && !s.transition && !s.warping && !s.talking
}
