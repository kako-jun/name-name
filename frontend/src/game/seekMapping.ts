/**
 * NovelRenderer の SeekBar 用 pure マッピングヘルパー (#125)
 *
 * NovelRenderer から切り出した理由は単体テストしたいから。実体は
 * NovelRenderer のメソッドが薄くこれらを呼ぶ形で再利用する。
 */

import type { NovelGameState } from './GameState'
import type { Event } from '../types'
import { getTextEvent } from './NovelRenderer'

/**
 * 表示用テキストイベントの 1-based 現在 index (Counter / SeekBar 共通)。
 *
 * - eventIndex 自体がテキストイベントを指していたら +1 (= 「いまそれを表示中」)
 * - そうでなければ resolvedEvents[0..eventIndex) にあるテキストイベント数
 *
 * 例: 13 個中 3 個目のテキストイベントを表示中 → 3
 *     先頭イベントが Bg / Flag だけで text にまだ届いていない → 0
 */
export function computeDisplayIndex(eventIndex: number, resolvedEvents: readonly Event[]): number {
  let displayIndex = 0
  for (let i = 0; i < eventIndex && i < resolvedEvents.length; i++) {
    if (getTextEvent(resolvedEvents[i])) displayIndex++
  }
  if (eventIndex < resolvedEvents.length && getTextEvent(resolvedEvents[eventIndex])) {
    displayIndex++
  }
  return displayIndex
}

/**
 * 表示用テキストイベント数 (Counter / SeekBar の total)。
 */
export function countDisplayEvents(resolvedEvents: readonly Event[]): number {
  let n = 0
  for (const e of resolvedEvents) if (getTextEvent(e)) n++
  return n
}

/**
 * 「displayIndex 番目 (0-based) のテキストイベント」が resolvedEvents の何番目か。
 * 該当無し (displayIndex がレンジ外) は -1。
 */
export function findEventIndexForDisplayIndex(
  displayIndex: number,
  resolvedEvents: readonly Event[]
): number {
  if (displayIndex < 0) return -1
  let textCount = 0
  for (let i = 0; i < resolvedEvents.length; i++) {
    if (getTextEvent(resolvedEvents[i])) {
      if (textCount++ === displayIndex) return i
    }
  }
  return -1
}

/**
 * 「displayIndex 番目 (0-based) のテキストイベント」に対応する history index。
 *
 * - 訪問済み: 該当 eventIndex を持つ history エントリの最初の位置を返す
 * - 未訪問 (前方ジャンプ): -1 を返す。NovelRenderer 側で no-op 扱い
 *
 * NOTE: 同じ eventIndex を持つ history エントリが複数あるシナリオ (Choice ループで
 * 同じ text event を再訪問) では、最初に一致する古い方の history まで巻き戻る。
 * これは「過去に通った最古の地点に戻る」挙動として一貫しているとみなす。
 */
export function findHistoryIndexForDisplayIndex(
  displayIndex: number,
  resolvedEvents: readonly Event[],
  history: readonly NovelGameState[]
): number {
  const targetEventIndex = findEventIndexForDisplayIndex(displayIndex, resolvedEvents)
  if (targetEventIndex < 0) return -1
  return history.findIndex((s) => s.eventIndex === targetEventIndex)
}
