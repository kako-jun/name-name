/**
 * eventCursor.ts（再生カーソルまわりの純粋計算）のテスト (#822)。
 *
 * `displayEventCount` 計算を、独立に書いた参照述語と突き合わせる（doctrine 規律3）。
 * （Flag 後の再展開の写像 `remapEventIndexAfterReResolve` は #799 の入場時展開で廃止した。）
 */
import { describe, it, expect } from 'vitest'
import type { Event } from '../types'
import { countDisplayEvents, getTextEvent, isTextEvent } from './eventCursor'

const t = (s: string): Event => ({ Narration: { text: [s] } })
const dialog = (s: string): Event => ({
  Dialog: { character: 'a', expression: 'x', position: 'Left', text: [s] },
})

describe('isTextEvent / countDisplayEvents (#822)', () => {
  const variants: Event[] = [
    dialog('d'),
    t('n'),
    'PageBreak',
    'SceneTransition',
    'VideoExit',
    'WaitDisplayComplete',
    { Choice: { options: [] } },
    { Flag: { name: 'a', value: { Bool: true } } },
    { Condition: { flag: 'a', events: [t('inner')] } },
    { Jump: { target: 's' } },
    { Wait: { ms: 1 } },
    { Background: { path: 'bg.png' } },
    { ExpressionChange: { character: 'a', expression: 'x' } },
  ]

  // getTextEvent と独立に書いた参照述語（Dialog / Narration キーを持つオブジェクトだけ true）。
  const referenceIsText = (e: Event): boolean =>
    typeof e === 'object' && e !== null && ('Dialog' in e || 'Narration' in e)

  it('全 variant で参照述語と一致し、getTextEvent !== null とも一致する', () => {
    for (const e of variants) {
      expect(isTextEvent(e), JSON.stringify(e)).toBe(referenceIsText(e))
      expect(isTextEvent(e), JSON.stringify(e)).toBe(getTextEvent(e) !== null)
    }
  })

  it('Dialog と Narration だけが本文イベント、入れ子 Condition の中身は数えない', () => {
    expect(variants.filter(isTextEvent).length).toBe(2)
  })

  it('countDisplayEvents は参照述語 filter の件数 と一致する(空・重複含む)', () => {
    const lists: Event[][] = [[], variants, [...variants, ...variants], [t('a')], ['PageBreak']]
    for (const l of lists) {
      expect(countDisplayEvents(l)).toBe(l.filter(referenceIsText).length)
    }
    expect(countDisplayEvents([])).toBe(0)
    expect(countDisplayEvents([...variants, ...variants])).toBe(4)
  })
})
