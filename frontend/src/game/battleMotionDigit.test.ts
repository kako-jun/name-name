import { describe, expect, it } from 'vitest'
import {
  DEFAULT_MOTION_TIMING,
  SNAPPY_MOTION_TIMING,
  popupDigitPitch,
  sampleDamagePopup,
  sampleDigitPopup,
} from './battleMotion'

const T = SNAPPY_MOTION_TIMING
const total = T.popupArc1Ms + T.popupArc2Ms + T.popupHoldMs + T.popupFadeMs

describe('sampleDigitPopup (#955)', () => {
  it('digitStaggerMs=0（default）は全桁が sampleDamagePopup と完全一致', () => {
    for (let t = -10; t < 1000; t += 7)
      for (let i = 0; i < 4; i++) expect(sampleDigitPopup(t, i, 4)).toEqual(sampleDamagePopup(t))
  })

  it('default は 0、snappy は 50', () => {
    expect(DEFAULT_MOTION_TIMING.digitStaggerMs).toBe(0)
    expect(T.digitStaggerMs).toBe(50)
  })

  it('桁 index は index*stagger だけ遅れて始まる', () => {
    const t = 100
    expect(sampleDigitPopup(t, 0, 3, T)).toEqual(sampleDamagePopup(t, T))
    expect(sampleDigitPopup(t, 1, 3, T)).toEqual(sampleDamagePopup(t - 50, T))
    expect(sampleDigitPopup(t, 2, 3, T)).toEqual(sampleDamagePopup(t - 100, T))
    // 始まる前は置き位置で待つ
    expect(sampleDigitPopup(30, 1, 3, T)).toEqual({ dy: 0, alpha: 1, done: false })
    // 先頭が上がっている間、後ろの桁はまだ低い
    expect(sampleDigitPopup(60, 0, 3, T).dy).toBeLessThan(sampleDigitPopup(60, 2, 3, T).dy)
  })

  it('done は桁ごと。最後の桁が最後に終わる', () => {
    expect(sampleDigitPopup(total, 0, 3, T).done).toBe(true)
    expect(sampleDigitPopup(total, 2, 3, T).done).toBe(false)
    expect(sampleDigitPopup(total + 100, 2, 3, T).done).toBe(true)
    expect(sampleDigitPopup(total + 99, 2, 3, T).done).toBe(false)
  })

  it('境界: NaN・負・非有限・範囲外 index を安全に扱う', () => {
    expect(sampleDigitPopup(NaN, 0, 3, T)).toEqual(sampleDamagePopup(0, T))
    expect(sampleDigitPopup(-5, 1, 3, T)).toEqual({ dy: 0, alpha: 1, done: false })
    expect(sampleDigitPopup(Infinity, 0, 3, T)).toEqual(sampleDamagePopup(0, T))
    expect(sampleDigitPopup(100, 9, 3, T)).toEqual(sampleDigitPopup(100, 2, 3, T))
    expect(sampleDigitPopup(100, -1, 3, T)).toEqual(sampleDigitPopup(100, 0, 3, T))
    expect(sampleDigitPopup(100, NaN, NaN, T)).toEqual(sampleDigitPopup(100, 0, 1, T))
    expect(sampleDigitPopup(100, 0, 0, T)).toEqual(sampleDamagePopup(100, T))
  })

  it('popupDigitPitch は fontSize に比例する正の値', () => {
    expect(popupDigitPitch(40)).toBeCloseTo(24.8)
    expect(popupDigitPitch(0)).toBeGreaterThan(0)
  })
})
