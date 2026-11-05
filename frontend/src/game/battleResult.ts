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

// 以下の時間（RESULT_HOLD_* / RESULT_SKIP_GUARD_MS）はゲーム内時間（`BattleScreen.tick` に渡された deltaMS の総和）で、実時間ではない。
// 設定オーバーレイで tick が止まっている間は進まない。
/** 勝敗が決まってから閉じるまで待つ時間（ms）。dq: 最後のログを読める程度 */
export const RESULT_HOLD_DQ_MS = 800
/** ff: 勝利メッセージと victory ポーズを見せる時間（ms） */
export const RESULT_HOLD_FF_MS = 1500
/**
 * 待機の開始から、決定操作・タップで飛ばせるようになるまでの時間（ms）。
 * 戦闘を決めたタップそのものが同じ瞬間に届いて、読ませる前に閉じてしまうのを防ぐ。
 */
export const RESULT_SKIP_GUARD_MS = 250

/** ff の勝利リザルト (#1039): メッセージ 1 件を出しておく時間（ms）。暫定 */
export const RESULT_MESSAGE_STEP_MS = 1000
/** ff の勝利リザルト (#1039): 生き残りの味方が通常と victory を入れ替える間隔（ms）。暫定 */
export const RESULT_VICTORY_FLIP_MS = 400

/**
 * お金の単位（暫定、#1039）。FF5 は『ギル』。sit-by-me の通貨名が未決（U-2929）なので仮に『ギル』を置く。
 * 決まったらここ 1 か所だけ差し替える。
 */
export const RESULT_GOLD_UNIT = 'ギル'

/** 勝利リザルトの文言（語の区切りは半角スペース。全角スペースは使わない。victory は区切りを持たない定数で空白なし） */
export const RESULT_TEXT = {
  /** 勝利の言葉（FF5 は戦闘終了時に出す。#1109。区切りの空白は入れない） */
  victory: '戦いに勝った！',
  gold: (gold: number): string => `${gold}${RESULT_GOLD_UNIT} てにいれた`,
  exp: (exp: number): string => `${exp} けいけんち かくとく`,
  learned: (name: string): string => `${name}をおぼえた！`,
  loot: (name: string): string => `${name}を てにいれた`,
  defeat: 'ぜんめつ…',
} as const

/** 勝利リザルトの材料（名前は呼び出し側が解決済み） */
export interface ResultMessageInput {
  gold: number
  exp: number
  /** この戦闘で新たに覚えた呪文の名前（覚えた順） */
  learnedSpellNames: readonly string[]
  /** 戦利品の名前（獲得順、個数は出さない） */
  lootNames: readonly string[]
}

/**
 * 勝利リザルトのメッセージ配列 (#1039, #1109)。順: 勝利の言葉（常に出す。お金・経験値が 0 でも）→ お金 → 経験値 → 覚えた呪文 → 戦利品（最後）。お金・経験値・呪文・戦利品の 0 の行は出さない。
 * AP・レベルアップなどは本作に仕組みが無いので出さない（項目を足すときはここに順番どおり差し込む）。
 */
export function buildResultMessages(input: ResultMessageInput): string[] {
  const out: string[] = [RESULT_TEXT.victory]
  if (input.gold > 0) out.push(RESULT_TEXT.gold(input.gold))
  if (input.exp > 0) out.push(RESULT_TEXT.exp(input.exp))
  for (const n of input.learnedSpellNames) out.push(RESULT_TEXT.learned(n))
  for (const n of input.lootNames) out.push(RESULT_TEXT.loot(n))
  return out
}

/** 経過時間から、いま出すメッセージの index（件数 0 は -1） */
export function resultMessageIndex(elapsed: number, count: number): number {
  if (count <= 0) return -1
  return Math.min(count - 1, Math.floor(Math.max(0, elapsed) / RESULT_MESSAGE_STEP_MS))
}

/** 経過時間から、生き残りの味方がいま victory ポーズか（最初のコマは victory。それ以外は通常） */
export function isVictoryFlipOn(elapsed: number): boolean {
  return Math.floor(Math.max(0, elapsed) / RESULT_VICTORY_FLIP_MS) % 2 === 0
}

export type ResultOutcome = 'victory' | 'defeat'

/** 勝敗が決まった後に読ませる時間（ms） */
export function resultHoldMs(presentation: BattlePresentation, messageCount = 0): number {
  if (presentation !== 'ff') return RESULT_HOLD_DQ_MS
  return Math.max(RESULT_HOLD_FF_MS, messageCount * RESULT_MESSAGE_STEP_MS)
}

/** 全滅のときだけ出す固定の言葉（勝利の言葉『戦いに勝った！』は `buildResultMessages` のメッセージ列の先頭） */
export function resultMessageText(outcome: ResultOutcome): string | null {
  return outcome === 'defeat' ? RESULT_TEXT.defeat : null
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

/** ff のメッセージ窓の言葉: 再生中の行動の名前があればそれ、無ければ勝敗待機中の言葉（無ければ null） */
export function windowWord(actionWord: string | null, resultWord: string | null): string | null {
  return actionWord !== null ? actionWord : resultWord
}
