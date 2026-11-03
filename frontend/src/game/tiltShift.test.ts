import { describe, expect, it } from 'vitest'
import {
  TILT_SHIFT_DEFAULT_PARAMS,
  tiltShiftBlurRadius,
  tiltShiftBlurRatio,
  tiltShiftSampleOffsets,
} from './tiltShift'

describe('tiltShift (#885)', () => {
  it('中央は鮮明・上下端は最大で、上下対称', () => {
    expect(tiltShiftBlurRatio(0.5)).toBe(0)
    expect(tiltShiftBlurRatio(0)).toBe(1)
    expect(tiltShiftBlurRatio(1)).toBe(1)
    for (const y of [0.05, 0.1, 0.2, 0.3, 0.4]) {
      expect(tiltShiftBlurRatio(y)).toBeCloseTo(tiltShiftBlurRatio(1 - y), 10)
    }
  })
  it('端へ向かって単調に強くなり、半径は最大値以下', () => {
    let prev = -1
    for (let i = 0; i <= 50; i++) {
      const r = tiltShiftBlurRadius(0.5 - i / 100)
      expect(r).toBeGreaterThanOrEqual(prev)
      expect(r).toBeLessThanOrEqual(TILT_SHIFT_DEFAULT_PARAMS.maxBlurPx)
      prev = r
    }
  })
  it('サンプル配置は単位円内で指定個数', () => {
    const s = tiltShiftSampleOffsets(24)
    expect(s).toHaveLength(24)
    for (const p of s) expect(Math.hypot(p.x, p.y)).toBeLessThanOrEqual(1)
  })
})
