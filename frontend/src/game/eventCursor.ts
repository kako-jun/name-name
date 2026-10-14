/**
 * 再生カーソルまわりの純粋計算 (#735 1/8, #822)。
 *
 * `NovelRenderer` の `this` に依存しない計算だけを置く。`resolvedEvents` / `eventIndex` /
 * `displayEventCount` を書き換えるのはレンダラの責務のまま残し、ここは「新しい値を求める」だけ。
 * `NovelRenderer.ts` から import され、`NovelRenderer` は import しない（循環を作らない）。
 */

import type { Event } from '../types'
import { countSurvivingBefore, type GameState } from './GameState'

/**
 * 本文イベント（Dialog / Narration）か。`NovelRenderer.getTextEvent(event) !== null` と同値。
 * `getTextEvent` は NovelRenderer.ts にあり PixiJS を間接参照するため、述語だけをここに持つ。
 */
export function isTextEvent(event: Event): boolean {
  return typeof event === 'object' && event !== null && ('Dialog' in event || 'Narration' in event)
}

/**
 * 展開後のイベント列に含まれる本文イベント（Dialog / Narration）の数。
 * カウンタ表示（`displayEventCount`）の元で、`resolvedEvents` を入れ替えるたびに求め直す。
 */
export function countDisplayEvents(resolvedEvents: readonly Event[]): number {
  return resolvedEvents.filter((e) => isTextEvent(e)).length
}

/**
 * Flag 実行後の再展開で、`eventIndex` を新しい展開列上のどこへ写すかを求める (#777)。
 *
 * - 現在のイベントが元イベント列に見つかり、新しい列にも残っている: その位置
 * - 見つかったが新しい列から消えた（囲む `[条件:]` が偽になった）: 元イベント列上で次に残る
 *   イベントの直前（`before - 1`）。呼び出し元が続けて eventIndex を進める
 * - 現在のイベントがオブジェクトでない / 元イベント列に無い: 範囲外なら末尾へ丸め、範囲内ならそのまま
 *
 * @param rawEvents Condition 展開前の元イベント列
 * @param newResolvedEvents `resolveEvents(rawEvents, gameState)` の結果（再展開後）
 * @param currentEvent 再展開前の `resolvedEvents[eventIndex]`
 * @param currentEventIndex 再展開前の `eventIndex`
 * @param gameState 再展開に使ったフラグ状態
 */
export function remapEventIndexAfterReResolve(
  rawEvents: readonly Event[],
  newResolvedEvents: readonly Event[],
  currentEvent: Event | undefined,
  currentEventIndex: number,
  gameState: GameState
): number {
  const before =
    typeof currentEvent === 'object' && currentEvent !== null
      ? countSurvivingBefore(rawEvents, currentEvent, gameState)
      : null
  if (before !== null) {
    if (newResolvedEvents[before] === currentEvent) {
      return before
    }
    return before - 1
  }
  if (currentEventIndex >= newResolvedEvents.length) {
    return Math.max(0, newResolvedEvents.length - 1)
  }
  return currentEventIndex
}
