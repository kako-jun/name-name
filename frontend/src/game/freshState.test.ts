/**
 * buildFreshPositionState のテスト (#822)。
 * 旧 `NovelRenderer.buildFreshPositionState`（origin/main）を写したリファレンスと突き合わせ、
 * 各フィールドの既定値をリテラルで固定する。
 */
import { describe, it, expect } from 'vitest'
import type { FlagValue } from '../types'
import type { NovelGameState } from './GameState'
import { buildFreshPositionState } from './freshState'
import { normalizeBackgroundFade } from './NovelRenderer'
import type { FreshPosition } from './sceneEntry'

function referenceBuild(
  sceneId: string,
  position: FreshPosition,
  flags: Record<string, FlagValue> | undefined
): NovelGameState {
  return {
    sceneId,
    eventIndex: position.eventIndex,
    textIndex: position.textIndex ?? 0,
    sentenceIndex: position.sentenceIndex ?? 0,
    flags: flags ?? {},
    backgroundPath: null,
    backgroundColor: null,
    backgroundFade: normalizeBackgroundFade(undefined),
    backgroundBrightness: null,
    video: null,
    eventImage: null,
    backgroundBoards: [],
    wall: null,
    stageFront: null,
    weather: null,
    props: [],
    spotlight: null,
    curtain: null,
    isBlackout: false,
    characters: [],
    currentBgmPath: null,
    cameraMode: 'Novel',
    cameraOrientation: 'Audience',
    cameraElevation: null,
    cameraZoom: null,
    paperDollOutline: null,
    storyEnded: false,
  }
}

describe('buildFreshPositionState (#822)', () => {
  it('textIndex / sentenceIndex 省略は 0、flags 省略は {}、他は全て初期値', () => {
    expect(buildFreshPositionState('s1', { eventIndex: 4 }, undefined)).toEqual({
      sceneId: 's1',
      eventIndex: 4,
      textIndex: 0,
      sentenceIndex: 0,
      flags: {},
      backgroundPath: null,
      backgroundColor: null,
      backgroundFade: null,
      backgroundBrightness: null,
      video: null,
      eventImage: null,
      backgroundBoards: [],
      wall: null,
      stageFront: null,
      weather: null,
      props: [],
      spotlight: null,
      curtain: null,
      isBlackout: false,
      characters: [],
      currentBgmPath: null,
      cameraMode: 'Novel',
      cameraOrientation: 'Audience',
      cameraElevation: null,
      cameraZoom: null,
      paperDollOutline: null,
      storyEnded: false,
      // 入場時 flags (#799)。flags 省略は {}
      entryFlags: {},
    })
  })

  it('指定した textIndex / sentenceIndex / flags はそのまま通る(0 も ?? で潰れない)', () => {
    const flags = { a: { Bool: true } as FlagValue }
    const s = buildFreshPositionState('s', { eventIndex: 2, textIndex: 3, sentenceIndex: 5 }, flags)
    expect([s.eventIndex, s.textIndex, s.sentenceIndex]).toEqual([2, 3, 5])
    expect(s.flags).toEqual({ a: { Bool: true } })
    const z = buildFreshPositionState('s', { eventIndex: 0, textIndex: 0, sentenceIndex: 0 }, {})
    expect([z.eventIndex, z.textIndex, z.sentenceIndex]).toEqual([0, 0, 0])
  })

  it('backgroundFade は旧 normalizeBackgroundFade(undefined) と同じ null', () => {
    expect(normalizeBackgroundFade(undefined)).toBeNull()
    expect(buildFreshPositionState('s', { eventIndex: 0 }, undefined).backgroundFade).toBe(
      normalizeBackgroundFade(undefined)
    )
  })

  it('呼ぶたびに配列・オブジェクトは独立した新しいインスタンス(共有されない)', () => {
    const a = buildFreshPositionState('s', { eventIndex: 0 }, undefined)
    const b = buildFreshPositionState('s', { eventIndex: 0 }, undefined)
    expect(a.characters).not.toBe(b.characters)
    expect(a.props).not.toBe(b.props)
    expect(a.backgroundBoards).not.toBe(b.backgroundBoards)
    expect(a.flags).not.toBe(b.flags)
  })

  it('旧実装リファレンスと、位置・flags の組合せ全てで deep equal かつ JSON 文字列(キー順)も一致する', () => {
    const positions: FreshPosition[] = [
      { eventIndex: 0 },
      { eventIndex: 7, textIndex: 2 },
      { eventIndex: 7, sentenceIndex: 4 },
      { eventIndex: 1, textIndex: 0, sentenceIndex: 0 },
      { eventIndex: 3, textIndex: 9, sentenceIndex: 8 },
    ]
    const flagSets: Array<Record<string, FlagValue> | undefined> = [
      undefined,
      {},
      { a: { Bool: false }, b: { String: 'x' }, c: { Number: 3 } },
    ]
    for (const p of positions)
      for (const f of flagSets) {
        const actual = buildFreshPositionState('scene-x', p, f)
        const expected = referenceBuild('scene-x', p, f)
        // 旧実装に無い #799 の入場時 flags は、キー順を保つため末尾に足した。それを除いた残りが旧実装と一致する
        const { entryFlags, ...rest } = actual
        expect(entryFlags).toEqual(f ?? {})
        expect(Object.keys(actual).pop()).toBe('entryFlags')
        expect(rest).toEqual(expected)
        expect(JSON.stringify(rest)).toBe(JSON.stringify(expected))
      }
  })
})
