import { describe, expect, it } from 'vitest'
import {
  DEFAULT_MOTION_TIMING,
  effectiveDigitStagger,
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

  it('桁 index の跳ね(dy)だけ index*stagger 遅れて始まる', () => {
    const t = 100
    expect(sampleDigitPopup(t, 0, 3, T).dy).toBe(sampleDamagePopup(t, T).dy)
    expect(sampleDigitPopup(t, 1, 3, T).dy).toBe(sampleDamagePopup(t - 50, T).dy)
    expect(sampleDigitPopup(t, 2, 3, T).dy).toBe(sampleDamagePopup(t - 100, T).dy)
    // 始まる前は置き位置で待つ
    expect(sampleDigitPopup(30, 1, 3, T)).toEqual({ dy: 0, alpha: 1, done: false })
    // 先頭が上がっている間、後ろの桁はまだ低い
    expect(sampleDigitPopup(60, 0, 3, T).dy).toBeLessThan(sampleDigitPopup(60, 2, 3, T).dy)
  })

  it('alpha と done は全桁共通（最後の桁の時間軸）', () => {
    const lastEnd = total + 100
    for (let t = 0; t < lastEnd + 50; t += 5) {
      const ref = sampleDamagePopup(t - 100, T)
      for (let i = 0; i < 3; i++) {
        const s = sampleDigitPopup(t, i, 3, T)
        expect(s.alpha).toBe(ref.alpha)
        expect(s.done).toBe(ref.done)
      }
    }
    expect(sampleDigitPopup(lastEnd - 1, 0, 3, T).done).toBe(false)
    expect(sampleDigitPopup(lastEnd, 0, 3, T).done).toBe(true)
    // 先頭桁単独ならフェード中の時刻でも、最後の桁の保持中は alpha 1
    expect(sampleDigitPopup(total - T.popupFadeMs + 99, 0, 3, T).alpha).toBe(1)
  })

  it('実効 stagger は桁数が多いと合計 150ms に収まる', () => {
    expect(effectiveDigitStagger(1, T)).toBe(0)
    expect(effectiveDigitStagger(2, T)).toBe(50)
    expect(effectiveDigitStagger(4, T)).toBe(50)
    expect(effectiveDigitStagger(7, T)).toBeCloseTo(25)
    expect(effectiveDigitStagger(7, DEFAULT_MOTION_TIMING)).toBe(0)
    // 7 桁の末尾桁は 150ms 遅れで始まり、全体の done は total+150
    expect(sampleDigitPopup(total + 149, 6, 7, T).done).toBe(false)
    expect(sampleDigitPopup(total + 150, 6, 7, T).done).toBe(true)
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
    expect(popupDigitPitch(40)).toBeCloseTo(22.28)
    expect(popupDigitPitch(0)).toBeGreaterThan(0)
  })
})
