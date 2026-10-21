/**
 * 再生カーソルまわりの純粋計算 (#735 1/8, #822)。
 *
 * `NovelRenderer` の `this` に依存しない計算だけを置く。`resolvedEvents` / `eventIndex` /
 * `displayEventCount` を書き換えるのはレンダラの責務のまま残し、ここは「新しい値を求める」だけ。
 * `NovelRenderer.ts` から import され、`NovelRenderer` は import しない（循環を作らない）。
 */

import type { Event } from '../types'

/** Dialog / Narration から text を取り出すヘルパー */
export function getTextEvent(event: Event):
  | {
      type: 'dialog'
      character: string | null
      expression: string | null
      position: string | null
      text: string[]
      /** 立ち絵の明示フィット指定 (#294)。true のとき loadTexture で旧 fit-down を適用する。 */
      fit: boolean
      /** シアターモードのキャラクター奥行き配置 (#694)。未指定/null は 0（最前面）。 */
      depth: number
    }
  | { type: 'narration'; text: string[] }
  | null {
  if (typeof event === 'object' && event !== null) {
    if ('Dialog' in event) {
      return {
        type: 'dialog',
        character: event.Dialog.character,
        expression: event.Dialog.expression,
        position: event.Dialog.position,
        text: event.Dialog.text,
        // 未指定 / false は原寸（fit=false）。明示 boolean に倒す。
        fit: event.Dialog.fit === true,
        // 未指定/null は 0（最前面）に倒す (#694)。
        depth: event.Dialog.depth ?? 0,
      }
    }
    if ('Narration' in event) {
      return { type: 'narration', text: event.Narration.text }
    }
  }
  return null
}

/**
 * 本文イベント（Dialog / Narration）か。`getTextEvent(event) !== null` と同じ。
 */
export function isTextEvent(event: Event): boolean {
  return getTextEvent(event) !== null
}

/**
 * 展開後のイベント列に含まれる本文イベント（Dialog / Narration）の数。
 * カウンタ表示（`displayEventCount`）の元で、`resolvedEvents` を入れ替えるたびに求め直す。
 */
export function countDisplayEvents(resolvedEvents: readonly Event[]): number {
  return resolvedEvents.filter((e) => isTextEvent(e)).length
}
