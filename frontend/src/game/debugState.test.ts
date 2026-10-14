/**
 * buildDebugState のテスト (#822)。
 * 旧 `NovelRenderer.getDebugState`（origin/main）の整形部を写したリファレンスと突き合わせる。
 */
import { describe, it, expect } from 'vitest'
import type { Event } from '../types'
import { buildDebugState, type DebugStateInputs } from './debugState'
import { describeEventForDebug } from './novelLayout'

function base(over: Partial<DebugStateInputs> = {}): DebugStateInputs {
  return {
    resolvedEvents: [],
    eventIndex: 0,
    autoMode: false,
    waitingForChoice: false,
    waitingForWait: false,
    jumpState: 'idle',
    currentResolvedFontFamily: null,
    sceneId: null,
    audioWarning: null,
    characterStates: [],
    spriteGeometry: () => undefined,
    ...over,
  }
}

/** origin/main の整形部を、受け取り値(this の読み取り結果)から組み立てる形で写したもの。 */
function referenceDebug(i: DebugStateInputs) {
  const current = i.resolvedEvents[i.eventIndex]
  const { kind, text } = describeEventForDebug(current)
  const chars = i.characterStates.map((s) => {
    const st = i.spriteGeometry(s.name)
    return {
      name: s.name,
      expression: s.expression,
      position: s.position,
      depth: s.depth,
      x: st?.x ?? -1,
      y: st?.y ?? -1,
      scale: st?.scale ?? -1,
    }
  })
  return {
    eventIndex: i.eventIndex,
    eventCount: i.resolvedEvents.length,
    eventKind: kind,
    eventText: text,
    autoMode: i.autoMode,
    waitingForChoice: i.waitingForChoice,
    waitingForWait: i.waitingForWait,
    jumpState: i.jumpState,
    currentResolvedFontFamily: i.currentResolvedFontFamily,
    sceneId: i.sceneId ?? null,
    audioWarning: i.audioWarning,
    characters: chars,
  }
}

describe('buildDebugState (#822)', () => {
  it('sceneId が undefined / null のどちらでも null になり、値があればそのまま', () => {
    expect(buildDebugState(base({ sceneId: undefined })).sceneId).toBeNull()
    expect(buildDebugState(base({ sceneId: null })).sceneId).toBeNull()
    expect(buildDebugState(base({ sceneId: 'opening' })).sceneId).toBe('opening')
  })

  it('spriteGeometry が undefined を返す立ち絵は x/y/scale が -1、あれば実測値(0 も潰れない)', () => {
    const s = buildDebugState(
      base({
        characterStates: [
          { name: 'a', expression: 'smile', position: 'Left', depth: 0 },
          { name: 'b', expression: 'sad', position: 'Right', depth: 2 },
        ],
        spriteGeometry: (n) => (n === 'b' ? { x: 0, y: 10, scale: 0 } : undefined),
      })
    )
    expect(s.characters).toEqual([
      { name: 'a', expression: 'smile', position: 'Left', depth: 0, x: -1, y: -1, scale: -1 },
      { name: 'b', expression: 'sad', position: 'Right', depth: 2, x: 0, y: 10, scale: 0 },
    ])
  })

  it('resolvedEvents が空 / eventIndex が範囲外なら eventKind は "(none)" で eventText は undefined', () => {
    const s = buildDebugState(base({ resolvedEvents: [], eventIndex: 0 }))
    expect(s.eventKind).toBe('(none)')
    expect(s.eventText).toBeUndefined()
    expect(s.eventCount).toBe(0)
    expect(buildDebugState(base({ resolvedEvents: ['PageBreak'], eventIndex: 5 })).eventKind).toBe(
      '(none)'
    )
  })

  it('現在イベントの kind/text と eventCount が出る', () => {
    const s = buildDebugState(
      base({
        resolvedEvents: [{ Narration: { text: ['こんにちは'] } }, { Jump: { target: 'next' } }],
        eventIndex: 1,
      })
    )
    expect(s.eventKind).toBe('Jump')
    expect(s.eventText).toBe('next')
    expect(s.eventCount).toBe(2)
  })

  it('フラグ類・フォント・音声警告をそのまま転記する', () => {
    const s = buildDebugState(
      base({
        autoMode: true,
        waitingForChoice: true,
        waitingForWait: true,
        jumpState: 'stalled',
        currentResolvedFontFamily: 'serif',
        audioWarning: 'blocked',
      })
    )
    expect(s).toMatchObject({
      autoMode: true,
      waitingForChoice: true,
      waitingForWait: true,
      jumpState: 'stalled',
      currentResolvedFontFamily: 'serif',
      audioWarning: 'blocked',
    })
  })

  it('旧 getDebugState の整形と、多入力で deep equal かつ JSON キー順まで一致する', () => {
    const events: Event[] = [
      { Narration: { text: ['n'] } },
      { Dialog: { character: 'a', expression: 'x', position: 'Left', text: ['d'] } },
      { Background: { path: 'bg.png' } },
      'PageBreak',
    ]
    for (let idx = -1; idx <= events.length; idx++)
      for (const sceneId of [undefined, null, 's']) {
        const input = base({
          resolvedEvents: events,
          eventIndex: idx,
          sceneId,
          autoMode: idx % 2 === 0,
          characterStates: [{ name: 'a', expression: 'x', position: 'Left', depth: 1 }],
          spriteGeometry: idx % 2 === 0 ? () => ({ x: 1, y: 2, scale: 0.5 }) : () => undefined,
        })
        const actual = buildDebugState(input)
        const expected = referenceDebug(input)
        expect(actual).toEqual(expected)
        expect(JSON.stringify(actual)).toBe(JSON.stringify(expected))
      }
  })
})
