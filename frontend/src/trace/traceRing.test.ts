import { describe, expect, it } from 'vitest'
import { TRACE_MAX_STRING, TraceRing, sanitizeTraceValue } from './traceRing'

describe('TraceRing (#1197)', () => {
  it('固定長: 満杯になったら古いものから捨て、通し番号は進み続ける', () => {
    const r = new TraceRing(3)
    for (let i = 0; i < 5; i++) r.push(i, 'k', i)
    const a = r.toArray()
    expect(a.map((e) => e.n)).toEqual([2, 3, 4])
    expect(a.map((e) => e.d)).toEqual([2, 3, 4])
    expect(r.total).toBe(5)
    expect(r.size).toBe(3)
  })

  it('満杯前は入れた順に取り出せ、clear で空に戻る', () => {
    const r = new TraceRing(4)
    r.push(0, 'a')
    r.push(1, 'b')
    expect(r.toArray().map((e) => e.k)).toEqual(['a', 'b'])
    r.clear()
    expect(r.toArray()).toEqual([])
    expect(r.total).toBe(0)
  })
})

describe('sanitizeTraceValue (#1197)', () => {
  it('自由文のキー（名前・台詞・合言葉）は値ごと落とす（入れ子も、大文字小文字も）', () => {
    const v = sanitizeTraceValue({
      hp: 3,
      name: 'たろう',
      Text: 'こんにちは',
      password: 'abc',
      nested: { input: 'x', ok: 1 },
    })
    expect(v).toEqual({ hp: 3, nested: { ok: 1 } })
  })

  it('長い文字列は切る・関数や undefined や非有限数は落とす・配列内は null', () => {
    const long = 'a'.repeat(TRACE_MAX_STRING + 50)
    const v = sanitizeTraceValue({
      s: long,
      f: () => 1,
      u: undefined,
      n: NaN,
      arr: [1, undefined, 'x'],
    })
    expect((v as { s: string }).s.length).toBe(TRACE_MAX_STRING + 1)
    expect(v).toMatchObject({ arr: [1, null, 'x'] })
    expect(v).not.toHaveProperty('f')
    expect(v).not.toHaveProperty('u')
    expect(v).not.toHaveProperty('n')
  })

  it('深すぎる入れ子は捨てる（循環参照でも止まる）', () => {
    const a: Record<string, unknown> = { x: 1 }
    a.self = a
    const v = sanitizeTraceValue(a) as Record<string, unknown>
    expect(v.x).toBe(1)
    expect(JSON.stringify(v).length).toBeLessThan(500)
  })
})
