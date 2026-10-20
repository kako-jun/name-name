import { describe, expect, it } from 'vitest'
import { scrollOffset, shakeOffset } from './fieldMotion'

describe('shakeOffset (#864)', () => {
  const sk = { amplitudeY: 4, periodMs: 400 }
  it('0 で 0・四分の一周期で +振幅・半周期で 0・四分の三で -振幅', () => {
    expect(shakeOffset(sk, 0)).toBeCloseTo(0)
    expect(shakeOffset(sk, 100)).toBeCloseTo(4)
    expect(shakeOffset(sk, 200)).toBeCloseTo(0)
    expect(shakeOffset(sk, 300)).toBeCloseTo(-4)
  })
  it('周期で繰り返す・振幅を超えない', () => {
    expect(shakeOffset(sk, 1100)).toBeCloseTo(shakeOffset(sk, 300))
    for (let t = 0; t < 2000; t += 13) expect(Math.abs(shakeOffset(sk, t))).toBeLessThanOrEqual(4)
  })
  it('周期 0 以下・NaN は 0（0 除算で NaN を返さない）', () => {
    expect(shakeOffset({ amplitudeY: 4, periodMs: 0 }, 100)).toBe(0)
    expect(shakeOffset({ amplitudeY: 4, periodMs: -1 }, 100)).toBe(0)
    expect(shakeOffset(sk, NaN)).toBe(0)
  })
})

describe('scrollOffset (#864)', () => {
  it('speed × 時間、タイル幅で巻き戻す', () => {
    expect(scrollOffset(100, 500, 320)).toBeCloseTo(50)
    expect(scrollOffset(100, 4000, 320)).toBeCloseTo(80) // 400 mod 320
  })
  it('負の speed でも 0 以上 tileWidth 未満', () => {
    expect(scrollOffset(-100, 500, 320)).toBeCloseTo(270)
    for (let t = 0; t < 10000; t += 137) {
      const v = scrollOffset(-240, t, 320)
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThan(320)
    }
  })
  it('speed 0・tileWidth 0 以下・NaN は 0', () => {
    expect(scrollOffset(0, 1000, 320)).toBe(0)
    expect(scrollOffset(100, 1000, 0)).toBe(0)
    expect(scrollOffset(100, NaN, 320)).toBe(0)
    expect(scrollOffset(NaN, 1000, 320)).toBe(0)
  })
})
