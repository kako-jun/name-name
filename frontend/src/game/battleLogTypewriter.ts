/**
 * 戦闘ログ（メッセージ）の 1 文字ずつ表示 (#755)。
 *
 * frontmatter `battle_log_typewriter: on|off`（既定 off）で有効化する。on のとき、`BattleScreen` の
 * ログに「新しく積まれた行」だけを 1 文字ずつ表示する（表示済みの行は即時表示）。
 *
 * このモジュールは純粋関数と定数だけを持つ（PixiJS に触れない）。中間状態（`BattleLogTracker`）は
 * `BattleScreen` が持ち、GameState には持たせない（ADR 0002）。
 *
 * ログは末尾に追記され、上限を超えると先頭が捨てられる（`battleEngine` の LOG_MAX）。絶対インデックスは
 * 失われるので、「タイプ中の行」「まだ始まっていない行」は**ログ末尾からの相対位置**で追う。
 * 先頭が捨てられても末尾相対の位置は変わらないので、流れてもタイプ中の行が別の行に化けない。
 * 新規行数は文面の突き合わせでなく、エンジンの累計行数 `logTotal` の差で数える（同じ文面が続いても確実）。
 */
import {
  isTypingActive,
  startTypewriter,
  tickTypewriter,
  visibleText,
  type TypewriterState,
} from './typewriter'

export type BattleLogTypewriterMode = 'on' | 'off'

/** 1 文字あたりの ms。目視で調整する値（DialogBox の既定速度 30ms/char に揃えている） */
export const BATTLE_LOG_MS_PER_CHAR = 30

/** frontmatter `battle_log_typewriter` の値を正規化する。`'on'` 以外（未指定・空・未知値含む）は `'off'` */
export function normalizeBattleLogTypewriter(
  raw: string | null | undefined
): BattleLogTypewriterMode {
  return typeof raw === 'string' && raw.trim().toLowerCase() === 'on' ? 'on' : 'off'
}

export interface BattleLogTracker {
  /** 最後に見たログ全体 */
  seen: readonly string[]
  /** 最後に見たログの累計行数（`BattleState.logTotal`）。次回との差が新規行数 */
  total: number
  /** ログ末尾から数えた「まだ表示を始めていない行」の数（これらは画面に出さない） */
  hidden: number
  /** タイプ中の行の状態。行は `seen[seen.length - 1 - hidden]`。タイプ中でなければ null */
  typing: TypewriterState | null
}

export function makeBattleLogTracker(): BattleLogTracker {
  return { seen: [], total: 0, hidden: 0, typing: null }
}

/** タイプ中でなく待ちがあれば、次の行のタイプを始める（空行は即完了なので飛ばす） */
function startNext(t: BattleLogTracker): BattleLogTracker {
  let { hidden, typing } = t
  while (typing === null && hidden > 0) {
    hidden--
    const st = startTypewriter(t.seen[t.seen.length - 1 - hidden] ?? '')
    typing = isTypingActive(st) ? st : null
  }
  return { seen: t.seen, total: t.total, hidden, typing }
}

/**
 * 最新のログを取り込む。新しく積まれた行は待ち行列に入り、順にタイプされる。
 *
 * 新規行数は `logTotal`（エンジンの累計行数）の前回との差で数える。ログの文面は比較しないので、
 * 同じ文面が続いても数え違えない。差がログ長を超える（大量に積まれた）ときは見える範囲（ログ全行）に丸め、
 * `logTotal` が前回より小さい（別の戦闘に差し替わった）ときは全行を新規とみなす。
 */
export function syncBattleLog(
  t: BattleLogTracker,
  log: readonly string[],
  logTotal: number
): BattleLogTracker {
  const seen = log.slice()
  const appended = logTotal < t.total ? seen.length : Math.min(logTotal - t.total, seen.length)
  if (appended === 0) return { ...t, seen, total: logTotal }
  // 待ち・タイプ中の行が先頭切り捨てで消えていたら、残っている分だけに丸める
  const hidden = Math.min(t.hidden + appended, seen.length)
  let typing = t.typing
  if (typing !== null && seen.length - 1 - hidden < 0) typing = null
  return startNext({ seen, total: logTotal, hidden, typing })
}

/** 1 フレーム進める。タイプ中の行が終わったら次の待ち行へ移る */
export function tickBattleLog(
  t: BattleLogTracker,
  deltaMS: number,
  msPerChar: number
): BattleLogTracker {
  if (t.typing === null) return t
  const next = tickTypewriter(t.typing, deltaMS, msPerChar)
  if (isTypingActive(next)) return { ...t, typing: next }
  // 行が終わったときの余り時間は次の行へ繰り越さない（意図的な仕様）。次の行は常に 0 文字から始まり、
  // 巨大な deltaMS が来ても 1 tick で複数行を飛ばさない。
  return startNext({ seen: t.seen, total: t.total, hidden: t.hidden, typing: null })
}

/** タイプ中の行も待ち行もすべて即時に最後まで表示する */
export function skipBattleLog(t: BattleLogTracker): BattleLogTracker {
  if (t.typing === null && t.hidden === 0) return t
  return { seen: t.seen, total: t.total, hidden: 0, typing: null }
}

/** タイプ中、または表示待ちの行があるか */
export function isBattleLogTyping(t: BattleLogTracker): boolean {
  return t.typing !== null || t.hidden > 0
}

/** いま画面に出す末尾 `count` 行（未開始の行は含めない。タイプ中の行は表示済みの文字数まで） */
export function visibleBattleLogTail(t: BattleLogTracker, count: number): string[] {
  const shown = t.seen.slice(0, t.seen.length - t.hidden)
  if (t.typing !== null && shown.length > 0) shown[shown.length - 1] = visibleText(t.typing)
  return count > 0 ? shown.slice(-count) : []
}
