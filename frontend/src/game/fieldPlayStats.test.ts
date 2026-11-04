/** 一枚絵フィールドのプレイ統計 (#880 / fieldPlayStats.ts) のテスト */
import { describe, expect, it } from 'vitest'
import { advancePlayTime, advanceSteps, initialPlayStats, type PlayStats } from './fieldPlayStats'

const z: PlayStats = { playMs: 0, steps: 0, remainder: 0 }

describe('initialPlayStats', () => {
  it('セーブ無しは全部 0', () => {
    expect(initialPlayStats()).toEqual(z)
    expect(initialPlayStats({})).toEqual(z)
  })
  it('保存値を引き継ぎ、端数 remainder は 0 から', () => {
    expect(initialPlayStats({ playMs: 5000, steps: 12 })).toEqual({
      playMs: 5000,
      steps: 12,
      remainder: 0,
    })
  })
  it('steps の小数は切り捨て', () => {
    expect(initialPlayStats({ steps: 12.9 }).steps).toBe(12)
  })
  it.each([[-1], [NaN], [Infinity], ['5'], [null]])('不正な保存値（%j）は 0', (v) => {
    expect(initialPlayStats({ playMs: v as number, steps: v as number })).toEqual(z)
  })
})

describe('advancePlayTime', () => {
  it('dt を加算する（元は不変）', () => {
    const s = { ...z, playMs: 100 }
    expect(advancePlayTime(s, 16).playMs).toBe(116)
    expect(s.playMs).toBe(100)
  })
  it.each([[0], [-5], [NaN], [Infinity]])('dt=%s は変えない', (dt) => {
    const s = { ...z, playMs: 100 }
    expect(advancePlayTime(s, dt)).toBe(s)
  })
})

describe('advanceSteps', () => {
  it('stepDistance ごとに1歩・端数を持ち越す', () => {
    let s = advanceSteps(z, 30, 40)
    expect(s).toEqual({ playMs: 0, steps: 0, remainder: 30 })
    s = advanceSteps(s, 30, 40)
    expect(s.steps).toBe(1)
    expect(s.remainder).toBeCloseTo(20, 9)
  })
  it('1フレームで複数歩（境界: ちょうど割り切れる）', () => {
    expect(advanceSteps(z, 120, 40)).toEqual({ playMs: 0, steps: 3, remainder: 0 })
  })
  it('既存の steps に加算し、playMs は触らない', () => {
    const s = advanceSteps({ playMs: 7, steps: 5, remainder: 0 }, 80, 40)
    expect(s).toMatchObject({ playMs: 7, steps: 7 })
  })
  it('壁に押しつけて動けない（距離 0）は変えない', () => {
    expect(advanceSteps(z, 0, 40)).toBe(z)
  })
  it.each([
    [-3, 40],
    [NaN, 40],
    [Infinity, 40],
    [10, 0],
    [10, -1],
    [10, NaN],
    [10, Infinity],
  ])('walked=%s stepDistance=%s は変えない', (w, d) => {
    expect(advanceSteps(z, w, d)).toBe(z)
  })
  it('細かい歩幅を積んでも合計歩数が距離/stepDistance の整数部に一致', () => {
    let s = z
    for (let i = 0; i < 1000; i++) s = advanceSteps(s, 0.5, 40)
    expect(s.steps).toBe(12) // 500/40 = 12.5
  })
})
