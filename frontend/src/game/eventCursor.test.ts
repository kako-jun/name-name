/**
 * eventCursor.ts（再生カーソルまわりの純粋計算）のテスト (#822)。
 *
 * 切り出し前の `NovelRenderer.reResolveEvents` / `displayEventCount` 計算の数行を「リファレンス」として
 * このファイルに写し、多入力で突き合わせる（doctrine 規律3）。リファレンスは切り出し後のコードを
 * 呼ばず、`origin/main` の実装をそのまま写してある。
 */
import { describe, it, expect } from 'vitest'
import type { Event, FlagValue } from '../types'
import { GameState, countSurvivingBefore, resolveEvents } from './GameState'
import { countDisplayEvents, isTextEvent, remapEventIndexAfterReResolve } from './eventCursor'
import { getTextEvent } from './NovelRenderer'

const t = (s: string): Event => ({ Narration: { text: [s] } })
const dialog = (s: string): Event => ({
  Dialog: { character: 'a', expression: 'x', position: 'Left', text: [s] },
})
const flag = (name: string, value: boolean): Event => ({
  Flag: { name, value: { Bool: value } as FlagValue },
})
const cond = (name: string, events: Event[]): Event => ({ Condition: { flag: name, events } })

function gs(flags: Record<string, boolean>): GameState {
  const g = new GameState()
  for (const [k, v] of Object.entries(flags)) g.setFlag(k, { Bool: v })
  return g
}

/** origin/main の `reResolveEvents` 内にあった eventIndex 写像をそのまま写したリファレンス。 */
function referenceRemap(
  rawEvents: Event[],
  resolved: Event[],
  current: Event | undefined,
  eventIndex: number,
  gameState: GameState
): number {
  const before =
    typeof current === 'object' && current !== null
      ? countSurvivingBefore(rawEvents, current, gameState)
      : null
  if (before !== null) {
    if (resolved[before] === current) {
      return before
    }
    return before - 1
  }
  if (eventIndex >= resolved.length) {
    return Math.max(0, resolved.length - 1)
  }
  return eventIndex
}

describe('remapEventIndexAfterReResolve (#822)', () => {
  it('入れ子 [条件:] 内の Flag が自分の条件を偽にして消える場合は before-1 を返す', () => {
    const f = flag('c', false)
    const raw: Event[] = [t('n0'), cond('c', [t('in0'), f, t('in1')]), t('n2')]
    // 旧フラグ c=true での展開: n0, in0, Flag, in1, n2。Flag は index 2。
    const oldResolved = resolveEvents(raw, gs({ c: true }))
    expect(oldResolved.indexOf(f)).toBe(2)
    // Flag 実行後 c=false: 条件ブロックごと消え n0, n2 だけが残る。
    const g = gs({ c: false })
    const next = resolveEvents(raw, g)
    // Flag より前に生き残るのは n0 の 1 件。次の位置 1 は n2 で Flag ではないので 1-1=0。
    expect(remapEventIndexAfterReResolve(raw, next, f, 2, g)).toBe(0)
  })

  it('入れ子 [条件:] 内の Flag で条件が真のまま残る場合は Flag の新しい位置(before)を返す', () => {
    const f = flag('other', true)
    const raw: Event[] = [t('n0'), cond('c', [t('in0'), f, t('in1')]), t('n2')]
    const g = gs({ c: true, other: true })
    const next = resolveEvents(raw, g)
    expect(remapEventIndexAfterReResolve(raw, next, f, 2, g)).toBe(2)
  })

  it('Flag の前に別の条件ブロックが偽に変わっても、新しい列上の位置へ写像される', () => {
    const f = flag('d', true)
    const raw: Event[] = [cond('c', [t('hidden0'), t('hidden1')]), t('n1'), f, t('n3')]
    const g = gs({ c: false, d: true })
    const next = resolveEvents(raw, g)
    // 旧 index は 4（c 真のとき hidden0, hidden1, n1, Flag）。新しい列は n1, Flag, n3 で Flag は 1。
    expect(remapEventIndexAfterReResolve(raw, next, f, 3, g)).toBe(1)
  })

  it('現在のイベントが文字列 variant: 範囲内ならそのまま、末尾以降なら末尾へ丸める', () => {
    const raw: Event[] = [t('a'), 'PageBreak', t('b')]
    const g = gs({})
    const next = resolveEvents(raw, g)
    expect(remapEventIndexAfterReResolve(raw, next, 'PageBreak', 1, g)).toBe(1)
    expect(remapEventIndexAfterReResolve(raw, next, 'PageBreak', 3, g)).toBe(2)
    expect(remapEventIndexAfterReResolve(raw, next, 'PageBreak', 99, g)).toBe(2)
  })

  it('現在のイベントが元イベント列に無い(undefined / 別オブジェクト)場合も同様に丸める', () => {
    const raw: Event[] = [t('a'), t('b')]
    const g = gs({})
    const next = resolveEvents(raw, g)
    expect(remapEventIndexAfterReResolve(raw, next, undefined, 1, g)).toBe(1)
    expect(remapEventIndexAfterReResolve(raw, next, undefined, 2, g)).toBe(1)
    expect(remapEventIndexAfterReResolve(raw, next, t('a'), 5, g)).toBe(1) // 同形でも別オブジェクト
  })

  it('空の resolved は 0（Math.max(0, -1)）', () => {
    const raw: Event[] = [cond('c', [t('x')])]
    const g = gs({ c: false })
    const next = resolveEvents(raw, g)
    expect(next).toEqual([])
    expect(remapEventIndexAfterReResolve(raw, next, undefined, 0, g)).toBe(0)
    expect(remapEventIndexAfterReResolve(raw, next, 'PageBreak', 7, g)).toBe(0)
  })

  it('旧実装を写したリファレンスと、フラグ全組合せ × 現在位置の全てで一致する', () => {
    const f1 = flag('a', false)
    const f2 = flag('b', true)
    const raw: Event[] = [
      t('n0'),
      f1,
      cond('a', [t('a0'), cond('b', [t('ab0'), f2, 'PageBreak', t('ab1')]), f1, t('a1')]),
      dialog('d'),
      cond('b', [t('b0')]),
      'SceneTransition',
      t('end'),
    ]
    const combos: Array<Record<string, boolean>> = []
    for (const a of [false, true]) for (const b of [false, true]) combos.push({ a, b })
    let compared = 0
    for (const oldFlags of combos) {
      const oldResolved = resolveEvents(raw, gs(oldFlags))
      for (const newFlags of combos) {
        const g = gs(newFlags)
        const next = resolveEvents(raw, g)
        for (let idx = 0; idx <= oldResolved.length + 1; idx++) {
          const current = oldResolved[idx]
          expect(remapEventIndexAfterReResolve(raw, next, current, idx, g)).toBe(
            referenceRemap(raw, next, current, idx, g)
          )
          compared++
        }
      }
    }
    expect(compared).toBeGreaterThan(50)
  })
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

  it('全 variant で旧実装(getTextEvent(e) !== null)と一致する', () => {
    for (const e of variants) {
      expect(isTextEvent(e), JSON.stringify(e)).toBe(getTextEvent(e) !== null)
    }
  })

  it('Dialog と Narration だけが本文イベント、入れ子 Condition の中身は数えない', () => {
    expect(variants.filter(isTextEvent).length).toBe(2)
  })

  it('countDisplayEvents は旧実装 filter(getTextEvent !== null).length と一致する(空・重複含む)', () => {
    const lists: Event[][] = [[], variants, [...variants, ...variants], [t('a')], ['PageBreak']]
    for (const l of lists) {
      expect(countDisplayEvents(l)).toBe(l.filter((e) => getTextEvent(e) !== null).length)
    }
    expect(countDisplayEvents([])).toBe(0)
    expect(countDisplayEvents([...variants, ...variants])).toBe(4)
  })
})
