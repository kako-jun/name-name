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

/**
 * 前回見たログ `prev` から `next` までに、末尾へ新しく積まれた行数を返す。
 *
 * ログは末尾追記＋先頭切り捨てなので、`prev` の後ろ側が `next` の前側と一致する最小のずれを探す。
 * 重なりが無ければ（別の戦闘など）`next` 全行を新規とみなす。連続する同一文面が多いと
 * 実際より少なく数えることがある（その場合は即時表示側に倒れる）。
 */
export function countAppendedLines(prev: readonly string[], next: readonly string[]): number {
  for (let d = 0; d <= prev.length; d++) {
    const overlap = prev.length - d
    if (next.length < overlap) continue
    let same = true
    for (let i = 0; i < overlap; i++) {
      if (prev[d + i] !== next[i]) {
        same = false
        break
      }
    }
    if (same) return next.length - overlap
  }
  return next.length
}

export interface BattleLogTracker {
  /** 最後に見たログ全体 */
  seen: readonly string[]
  /** ログ末尾から数えた「まだ表示を始めていない行」の数（これらは画面に出さない） */
  hidden: number
  /** タイプ中の行の状態。行は `seen[seen.length - 1 - hidden]`。タイプ中でなければ null */
  typing: TypewriterState | null
}

export function makeBattleLogTracker(): BattleLogTracker {
  return { seen: [], hidden: 0, typing: null }
}

/** タイプ中でなく待ちがあれば、次の行のタイプを始める（空行は即完了なので飛ばす） */
function startNext(t: BattleLogTracker): BattleLogTracker {
  let { hidden, typing } = t
  while (typing === null && hidden > 0) {
    hidden--
    const st = startTypewriter(t.seen[t.seen.length - 1 - hidden] ?? '')
    typing = isTypingActive(st) ? st : null
  }
  return { seen: t.seen, hidden, typing }
}

/** 最新のログを取り込む。新しく積まれた行は待ち行列に入り、順にタイプされる */
export function syncBattleLog(t: BattleLogTracker, log: readonly string[]): BattleLogTracker {
  const appended = countAppendedLines(t.seen, log)
  const seen = log.slice()
  if (appended === 0 && seen.length === t.seen.length) return { ...t, seen }
  // 待ち・タイプ中の行が先頭切り捨てで消えていたら、残っている分だけに丸める
  const hidden = Math.min(t.hidden + appended, seen.length)
  let typing = t.typing
  if (typing !== null && seen.length - 1 - hidden < 0) typing = null
  return startNext({ seen, hidden, typing })
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
  return startNext({ seen: t.seen, hidden: t.hidden, typing: null })
}

/** タイプ中の行も待ち行もすべて即時に最後まで表示する */
export function skipBattleLog(t: BattleLogTracker): BattleLogTracker {
  if (t.typing === null && t.hidden === 0) return t
  return { seen: t.seen, hidden: 0, typing: null }
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
