import { describe, it, expect } from 'vitest'
import { GameState, resolveEvents } from './GameState'
import { Event } from '../types'

describe('resolveEvents', () => {
  it('Condition のないイベント配列はそのまま返す', () => {
    const gs = new GameState()
    const events: Event[] = [
      { Narration: { text: ['こんにちは'] } },
      { Background: { path: 'bg.png' } },
    ]
    const result = resolveEvents(events, gs)
    expect(result).toEqual(events)
  })

  it('Condition が偽ならスキップする', () => {
    const gs = new GameState()
    const events: Event[] = [
      { Narration: { text: ['前'] } },
      { Condition: { flag: 'visited', events: [{ Narration: { text: ['条件内'] } }] } },
      { Narration: { text: ['後'] } },
    ]
    const result = resolveEvents(events, gs)
    expect(result).toEqual([{ Narration: { text: ['前'] } }, { Narration: { text: ['後'] } }])
  })

  it('Condition が真なら内部 events を展開する', () => {
    const gs = new GameState()
    gs.setFlag('visited', { Bool: true })
    const events: Event[] = [
      { Narration: { text: ['前'] } },
      { Condition: { flag: 'visited', events: [{ Narration: { text: ['条件内'] } }] } },
      { Narration: { text: ['後'] } },
    ]
    const result = resolveEvents(events, gs)
    expect(result).toEqual([
      { Narration: { text: ['前'] } },
      { Narration: { text: ['条件内'] } },
      { Narration: { text: ['後'] } },
    ])
  })

  it('ネストした Condition を再帰的に展開する', () => {
    const gs = new GameState()
    gs.setFlag('a', { Bool: true })
    gs.setFlag('b', { Bool: true })
    const events: Event[] = [
      {
        Condition: {
          flag: 'a',
          events: [
            { Narration: { text: ['外側'] } },
            { Condition: { flag: 'b', events: [{ Narration: { text: ['内側'] } }] } },
          ],
        },
      },
    ]
    const result = resolveEvents(events, gs)
    expect(result).toEqual([{ Narration: { text: ['外側'] } }, { Narration: { text: ['内側'] } }])
  })

  it('ネストした Condition の内側が偽なら内側だけスキップする', () => {
    const gs = new GameState()
    gs.setFlag('a', { Bool: true })
    // b は未設定（偽）
    const events: Event[] = [
      {
        Condition: {
          flag: 'a',
          events: [
            { Narration: { text: ['外側'] } },
            { Condition: { flag: 'b', events: [{ Narration: { text: ['内側'] } }] } },
          ],
        },
      },
    ]
    const result = resolveEvents(events, gs)
    expect(result).toEqual([{ Narration: { text: ['外側'] } }])
  })

  it('空のイベント配列は空配列を返す', () => {
    const gs = new GameState()
    expect(resolveEvents([], gs)).toEqual([])
  })

  it('Condition 内部が空でも問題ない', () => {
    const gs = new GameState()
    gs.setFlag('x', { Bool: true })
    const events: Event[] = [
      { Condition: { flag: 'x', events: [] } },
      { Narration: { text: ['後'] } },
    ]
    const result = resolveEvents(events, gs)
    expect(result).toEqual([{ Narration: { text: ['後'] } }])
  })

  it('元の events 配列を変更しない', () => {
    const gs = new GameState()
    gs.setFlag('a', { Bool: true })
    const inner: Event[] = [{ Narration: { text: ['展開'] } }]
    const events: Event[] = [{ Condition: { flag: 'a', events: inner } }]
    const eventsCopy = JSON.parse(JSON.stringify(events))
    resolveEvents(events, gs)
    expect(events).toEqual(eventsCopy)
  })

  it('Flag イベントはそのまま残る', () => {
    const gs = new GameState()
    const events: Event[] = [
      { Flag: { name: 'test', value: { Bool: true } } },
      { Narration: { text: ['テスト'] } },
    ]
    const result = resolveEvents(events, gs)
    expect(result).toEqual(events)
  })
})
