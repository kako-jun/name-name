/**
 * 戦闘の勝敗が決まってから閉じるまでの「読ませる時間」の計算 (#745 分割4)。
 *
 * 勝敗（victory / defeat）が決まったら戦闘画面をすぐ閉じず、最後のターンのログ（dq）や勝利メッセージと
 * 勝った側の victory ポーズ（ff）が読める時間を取ってから閉じる。逃走（escaped）は対象外（すぐ閉じる）。
 *
 * このモジュールは純粋関数と定数だけを持つ（PixiJS・DOM に触れない）。待機の経過時間は `BattleScreen` が
 * 持ち、GameState には持たせない（ADR 0002）。待つ条件は「再生・ダメージ数字・ログのタイプ表示が終わったあと」で、
 * 経過時間はそれらが終わってから数え始める。
 */
import type { BattlePresentation } from './battleMotion'

/** 勝敗が決まってから閉じるまで待つ時間（ms）。dq: 最後のログを読める程度 */
export const RESULT_HOLD_DQ_MS = 800
/** ff: 勝利メッセージと victory ポーズを見せる時間（ms） */
export const RESULT_HOLD_FF_MS = 1500
/**
 * 待機の開始から、決定操作・タップで飛ばせるようになるまでの時間（ms）。
 * 戦闘を決めたタップそのものが同じ瞬間に届いて、読ませる前に閉じてしまうのを防ぐ。
 */
export const RESULT_SKIP_GUARD_MS = 250

export type ResultOutcome = 'victory' | 'defeat'

/** 勝敗が決まった後に読ませる時間（ms） */
export function resultHoldMs(presentation: BattlePresentation): number {
  return presentation === 'ff' ? RESULT_HOLD_FF_MS : RESULT_HOLD_DQ_MS
}

/** ff のメッセージ窓に出す短い言葉 */
export function resultMessageText(outcome: ResultOutcome): string {
  return outcome === 'victory' ? 'しょうり！' : 'ぜんめつ…'
}

/** engine の phase が読ませる対象の勝敗か（逃走・進行中は null） */
export function resultOutcomeOf(phase: string): ResultOutcome | null {
  return phase === 'victory' || phase === 'defeat' ? phase : null
}

/** 待機の経過時間を dt ms 進める（負の dt は 0 扱い） */
export function advanceResultElapsed(elapsed: number, dt: number): number {
  return elapsed + Math.max(0, dt)
}

/** 経過時間が待機時間に達したか */
export function isResultHoldDone(elapsed: number, holdMs: number): boolean {
  return elapsed >= holdMs
}

/** 決定操作・タップで待機を飛ばしてよいか */
export function canSkipResultHold(elapsed: number): boolean {
  return elapsed >= RESULT_SKIP_GUARD_MS
}

/** ff のメッセージ窓の言葉: 再生中の行動の名前があればそれ、無く勝敗待機中ならその言葉、どちらも無ければ null */
export function windowWord(
  actionWord: string | null,
  resultOutcome: ResultOutcome | null
): string | null {
  if (actionWord !== null) return actionWord
  return resultOutcome ? resultMessageText(resultOutcome) : null
}
