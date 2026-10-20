/**
 * 数の述語 (#871)。奇数/偶数/倍数/比較/桁数の解釈と評価（純粋関数）。
 */
import { describe, expect, it } from 'vitest'
import { digitCount, matchesNumber, parseNumberPredicate } from './numberPredicate'

function pred(raw: string, compareOnly = false) {
  const p = parseNumberPredicate(raw, compareOnly)
  if (typeof p === 'string') throw new Error(p)
  return p
}

describe('parseNumberPredicate', () => {
  it.each([
    ['=奇数', { kind: 'parity', parity: 'odd' }],
    ['= 偶数', { kind: 'parity', parity: 'even' }],
    ['==偶数', { kind: 'parity', parity: 'even' }],
    ['=3の倍数', { kind: 'multiple', of: 3 }],
    ['=12 倍数', { kind: 'multiple', of: 12 }],
    ['>=100', { kind: 'compare', op: '>=', n: 100 }],
    ['<10', { kind: 'compare', op: '<', n: 10 }],
    ['=777', { kind: 'compare', op: '=', n: 777 }],
    ['==0', { kind: 'compare', op: '=', n: 0 }],
  ])('%j は読める', (raw, expected) => {
    expect(pred(raw)).toEqual(expected)
  })

  it.each([
    [''],
    ['奇数'],
    ['>=奇数'],
    ['<偶数'],
    ['=0の倍数'],
    ['=の倍数'],
    ['=-3'],
    ['=1.5'],
    ['=abc'],
    ['=99999999999999999999'],
  ])('%j は不正（理由の文字列）', (raw) => {
    expect(typeof parseNumberPredicate(raw)).toBe('string')
  })

  it('compareOnly（桁数）では奇数・偶数・倍数を弾く', () => {
    expect(typeof parseNumberPredicate('=奇数', true)).toBe('string')
    expect(typeof parseNumberPredicate('=3の倍数', true)).toBe('string')
    expect(pred('>=3', true)).toEqual({ kind: 'compare', op: '>=', n: 3 })
  })
})

describe('matchesNumber', () => {
  it('奇数・偶数（0 は偶数、負は絶対値で見る）', () => {
    expect(matchesNumber(7, pred('=奇数'))).toBe(true)
    expect(matchesNumber(8, pred('=奇数'))).toBe(false)
    expect(matchesNumber(8, pred('=偶数'))).toBe(true)
    expect(matchesNumber(0, pred('=偶数'))).toBe(true)
    expect(matchesNumber(0, pred('=奇数'))).toBe(false)
    expect(matchesNumber(-3, pred('=奇数'))).toBe(true)
    expect(matchesNumber(-4, pred('=偶数'))).toBe(true)
  })

  it('倍数（0 はどの N の倍数でもある）', () => {
    expect(matchesNumber(9, pred('=3の倍数'))).toBe(true)
    expect(matchesNumber(10, pred('=3の倍数'))).toBe(false)
    expect(matchesNumber(0, pred('=3の倍数'))).toBe(true)
    expect(matchesNumber(7, pred('=1の倍数'))).toBe(true)
  })

  it('比較の境界', () => {
    expect(matchesNumber(99, pred('>=100'))).toBe(false)
    expect(matchesNumber(100, pred('>=100'))).toBe(true)
    expect(matchesNumber(100, pred('>100'))).toBe(false)
    expect(matchesNumber(100, pred('<=100'))).toBe(true)
    expect(matchesNumber(100, pred('<100'))).toBe(false)
    expect(matchesNumber(777, pred('=777'))).toBe(true)
    expect(matchesNumber(778, pred('=777'))).toBe(false)
  })

  it('整数でない値は常に false', () => {
    for (const p of ['=奇数', '=偶数', '=3の倍数', '>=0', '<=99999']) {
      expect(matchesNumber(Number.NaN, pred(p))).toBe(false)
      expect(matchesNumber(1.5, pred(p))).toBe(false)
      expect(matchesNumber(Number.POSITIVE_INFINITY, pred(p))).toBe(false)
    }
  })
})

describe('digitCount', () => {
  it.each([
    [0, 1],
    [9, 1],
    [10, 2],
    [999, 3],
    [1000, 4],
    [9999, 4],
    [-123, 3],
  ])('%d は %d 桁', (v, d) => {
    expect(digitCount(v)).toBe(d)
  })
})
