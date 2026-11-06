import { describe, expect, it } from 'vitest'
import type { EventDocument } from '../types'
import { docsOf, parseDebugTiltOff } from './fieldPlayDeps'

const d = (n: string) => ({ engine: n }) as unknown as EventDocument

describe('docsOf', () => {
  it('path 昇順(挿入順に依存しない)', () => {
    const m1 = new Map([
      ['b.md', d('b')],
      ['a.md', d('a')],
      ['B.md', d('B')],
    ])
    const m2 = new Map([
      ['B.md', d('B')],
      ['a.md', d('a')],
      ['b.md', d('b')],
    ])
    expect(docsOf(m1).map((x) => x.path)).toEqual(['B.md', 'a.md', 'b.md'])
    expect(docsOf(m2)).toEqual(docsOf(m1))
  })
  it('空 Map は空配列、doc はそのまま持つ', () => {
    expect(docsOf(new Map())).toEqual([])
    const doc = d('x')
    expect(docsOf(new Map([['x.md', doc]]))[0].doc).toBe(doc)
  })
})

describe('parseDebugTiltOff', () => {
  it('?debug_tilt=off のときだけ true', () => {
    expect(parseDebugTiltOff('?debug_tilt=off')).toBe(true)
    expect(parseDebugTiltOff('?a=1&debug_tilt=off')).toBe(true)
    expect(parseDebugTiltOff('')).toBe(false)
    expect(parseDebugTiltOff('?debug_tilt=on')).toBe(false)
    expect(parseDebugTiltOff('?debug_tilt=')).toBe(false)
    expect(parseDebugTiltOff('?debug_tilt=OFF')).toBe(false)
  })
})
