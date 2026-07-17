import { describe, it, expect } from 'vitest'
import {
  computeDisplayIndex,
  countDisplayEvents,
  findEventIndexForDisplayIndex,
  findHistoryIndexForDisplayIndex,
} from './seekMapping'
import type { Event } from '../types'
import type { NovelGameState } from './GameState'

const T = (text: string): Event => ({ Narration: { text: [text] } })
const BG = (p: string): Event => ({ Background: { path: p } })
const BGM = (p: string): Event => ({ Bgm: { path: p, action: 'Play' } })

function makeState(eventIndex: number): NovelGameState {
  return {
    sceneId: 's1',
    eventIndex,
    textIndex: 0,
    sentenceIndex: 0,
    flags: {},
    backgroundPath: null,
    backgroundColor: null,
    backgroundFade: null,
    backgroundBrightness: null,
    video: null,
    eventImage: null,
    isBlackout: false,
    characters: [],
    currentBgmPath: null,
    storyEnded: false,
  }
}

describe('computeDisplayIndex', () => {
  it('returns 0 before any text event is reached', () => {
    const events: Event[] = [BG('a.png'), BGM('b.ogg'), T('hi')]
    expect(computeDisplayIndex(0, events)).toBe(0) // pointing at BG
    expect(computeDisplayIndex(1, events)).toBe(0) // pointing at BGM
  })

  it('returns 1 when pointing at the first text event', () => {
    const events: Event[] = [BG('a.png'), T('hi'), T('bye')]
    expect(computeDisplayIndex(1, events)).toBe(1)
  })

  it('returns N when the N-th text event is being displayed', () => {
    const events: Event[] = [T('1'), T('2'), BG('x'), T('3')]
    expect(computeDisplayIndex(0, events)).toBe(1) // on 1st
    expect(computeDisplayIndex(1, events)).toBe(2) // on 2nd
    expect(computeDisplayIndex(2, events)).toBe(2) // on BG between 2nd and 3rd
    expect(computeDisplayIndex(3, events)).toBe(3) // on 3rd
  })

  it('handles eventIndex past the end (post-last-event)', () => {
    const events: Event[] = [T('1'), T('2')]
    expect(computeDisplayIndex(2, events)).toBe(2)
    expect(computeDisplayIndex(99, events)).toBe(2)
  })

  it('handles empty event list', () => {
    expect(computeDisplayIndex(0, [])).toBe(0)
  })
})

describe('countDisplayEvents', () => {
  it('counts only Dialog / Narration events', () => {
    const events: Event[] = [BG('a'), T('1'), BGM('b'), T('2'), T('3')]
    expect(countDisplayEvents(events)).toBe(3)
  })

  it('returns 0 for empty', () => {
    expect(countDisplayEvents([])).toBe(0)
  })
})

describe('findEventIndexForDisplayIndex', () => {
  const events: Event[] = [BG('a'), T('1'), BGM('b'), T('2'), T('3')]

  it('returns the resolvedEvents index of the i-th text event (0-based)', () => {
    expect(findEventIndexForDisplayIndex(0, events)).toBe(1) // 1st text -> idx 1
    expect(findEventIndexForDisplayIndex(1, events)).toBe(3) // 2nd text -> idx 3
    expect(findEventIndexForDisplayIndex(2, events)).toBe(4) // 3rd text -> idx 4
  })

  it('returns -1 for out-of-range', () => {
    expect(findEventIndexForDisplayIndex(3, events)).toBe(-1)
    expect(findEventIndexForDisplayIndex(-1, events)).toBe(-1)
  })

  it('returns -1 when there are no text events', () => {
    expect(findEventIndexForDisplayIndex(0, [BG('a'), BGM('b')])).toBe(-1)
  })
})

describe('findHistoryIndexForDisplayIndex', () => {
  const events: Event[] = [BG('a'), T('1'), BGM('b'), T('2'), T('3')]

  it('returns the matching history index when target text event is visited', () => {
    // history は text event の直前/直前で push される (NovelRenderer.pushSnapshot 仕様)
    const history = [makeState(1), makeState(3), makeState(4)] // visited 1st, 2nd, 3rd
    expect(findHistoryIndexForDisplayIndex(0, events, history)).toBe(0)
    expect(findHistoryIndexForDisplayIndex(1, events, history)).toBe(1)
    expect(findHistoryIndexForDisplayIndex(2, events, history)).toBe(2)
  })

  it('returns -1 for forward jump (target not yet in history)', () => {
    const history = [makeState(1)] // only 1st text event visited
    expect(findHistoryIndexForDisplayIndex(1, events, history)).toBe(-1)
    expect(findHistoryIndexForDisplayIndex(2, events, history)).toBe(-1)
  })

  it('returns the FIRST history index when same eventIndex appears multiple times', () => {
    // Choice loop で同じ text event を再訪問しているシナリオ。
    // 「過去に通った最古の地点に戻る」挙動を保証する。
    const history = [makeState(1), makeState(3), makeState(1), makeState(3)]
    expect(findHistoryIndexForDisplayIndex(0, events, history)).toBe(0)
    expect(findHistoryIndexForDisplayIndex(1, events, history)).toBe(1)
  })

  it('returns -1 when no text events exist', () => {
    expect(findHistoryIndexForDisplayIndex(0, [BG('a')], [makeState(0)])).toBe(-1)
  })

  it('returns -1 for negative displayIndex', () => {
    const history = [makeState(1)]
    expect(findHistoryIndexForDisplayIndex(-1, events, history)).toBe(-1)
  })
})

describe('regression: #125 SeekBar bar-stuck-full', () => {
  // 旧実装は seekBar.update(history.length - 1, history.length) で
  // ratio = (N-1)/(N-1) = 1 が常に成立 → バー満タン張り付き。
  // 修正後は computeDisplayIndex(eventIndex, resolvedEvents) で
  // 進行に応じて 0..total と動くことを確認する。
  it('produces monotonically increasing displayIndex along resolvedEvents', () => {
    const events: Event[] = [T('1'), T('2'), T('3'), T('4'), T('5')]
    const total = countDisplayEvents(events)
    expect(total).toBe(5)
    for (let i = 0; i < events.length; i++) {
      const di = computeDisplayIndex(i, events)
      expect(di).toBe(i + 1)
      // SeekBar に渡す 0-based current は 0..total-1 の範囲
      const current = Math.max(0, di - 1)
      expect(current).toBeGreaterThanOrEqual(0)
      expect(current).toBeLessThan(total)
    }
  })
})
