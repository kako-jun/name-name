import { describe, expect, it } from 'vitest'
import {
  TILT_SHIFT_DEFAULT_PARAMS,
  TILT_SHIFT_SAMPLE_COUNT,
  smoothstep,
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

describe('tiltShift 追加観点 (#885)', () => {
  it('smoothstep は GLSL と同じ。端で 0/1、中点で 0.5、edge0>=edge1 は階段', () => {
    expect(smoothstep(0, 1, 0)).toBe(0)
    expect(smoothstep(0, 1, 1)).toBe(1)
    expect(smoothstep(0, 1, 0.5)).toBeCloseTo(0.5, 10)
    expect(smoothstep(0, 1, -3)).toBe(0)
    expect(smoothstep(0, 1, 7)).toBe(1)
    expect(smoothstep(0.5, 0.5, 0.49)).toBe(0)
    expect(smoothstep(0.5, 0.5, 0.5)).toBe(1)
    expect(smoothstep(0.8, 0.2, 0.9)).toBe(1)
  })
  it('焦点域（focusRatio 以内）は完全に 0、直外は正', () => {
    const p = { focusRatio: 0.45, maxBlurPx: 9 }
    for (const d of [0, 0.1, 0.3, 0.45]) {
      expect(tiltShiftBlurRatio(0.5 + d / 2, p)).toBe(0)
      expect(tiltShiftBlurRatio(0.5 - d / 2, p)).toBe(0)
    }
    expect(tiltShiftBlurRatio(0.5 + 0.6 / 2, p)).toBeGreaterThan(0)
  })
  it('範囲外の縦位置（<0, >1, NaN, ±Infinity）はクランプされ、端と同じ/中心扱い', () => {
    expect(tiltShiftBlurRatio(-5)).toBe(1)
    expect(tiltShiftBlurRatio(5)).toBe(1)
    expect(tiltShiftBlurRatio(-Infinity)).toBe(1)
    expect(tiltShiftBlurRatio(Infinity)).toBe(1)
    expect(tiltShiftBlurRatio(NaN)).toBe(tiltShiftBlurRatio(0))
    expect(tiltShiftBlurRadius(-5)).toBe(TILT_SHIFT_DEFAULT_PARAMS.maxBlurPx)
    expect(tiltShiftBlurRadius(5)).toBe(TILT_SHIFT_DEFAULT_PARAMS.maxBlurPx)
  })
  it('半径は 上下端で maxBlurPx、中心で 0、半径は max に比例', () => {
    expect(tiltShiftBlurRadius(0)).toBe(TILT_SHIFT_DEFAULT_PARAMS.maxBlurPx)
    expect(tiltShiftBlurRadius(1)).toBe(TILT_SHIFT_DEFAULT_PARAMS.maxBlurPx)
    expect(tiltShiftBlurRadius(0.5)).toBe(0)
    const a = tiltShiftBlurRadius(0.1, { focusRatio: 0.45, maxBlurPx: 4 })
    const b = tiltShiftBlurRadius(0.1, { focusRatio: 0.45, maxBlurPx: 8 })
    expect(b).toBeCloseTo(a * 2, 10)
  })
  it('maxBlurPx が 0・負・NaN のとき半径は常に 0', () => {
    for (const m of [0, -3, NaN]) {
      for (const y of [0, 0.25, 0.5, 1]) {
        expect(tiltShiftBlurRadius(y, { focusRatio: 0.45, maxBlurPx: m })).toBe(0)
      }
    }
  })
  it('focusRatio の範囲外・NaN は 0〜1 にクランプ（1 以上なら端でも階段で最大にならず 1 は端のみ）', () => {
    const none = { focusRatio: 2, maxBlurPx: 9 } // 1 にクランプ → d=1（端）だけ最大
    expect(tiltShiftBlurRatio(0.7, none)).toBe(0)
    expect(tiltShiftBlurRatio(0, none)).toBe(1)
    const neg = { focusRatio: -1, maxBlurPx: 9 } // 0 にクランプ → 中心以外すべて滑らかに増加
    expect(tiltShiftBlurRatio(0.5, neg)).toBe(0)
    expect(tiltShiftBlurRatio(0.75, neg)).toBeGreaterThan(0)
    const nan = { focusRatio: NaN, maxBlurPx: 9 }
    expect(tiltShiftBlurRatio(0.75, nan)).toBe(tiltShiftBlurRatio(0.75, neg))
  })
  it('比率は全域で 0〜1、上下対称（細かい刻み）', () => {
    for (let i = 0; i <= 200; i++) {
      const y = i / 200
      const r = tiltShiftBlurRatio(y)
      expect(r).toBeGreaterThanOrEqual(0)
      expect(r).toBeLessThanOrEqual(1)
      expect(r).toBeCloseTo(tiltShiftBlurRatio(1 - y), 10)
    }
  })
  it('サンプル配置: 0/負/NaN/小数は最低 1 個に丸め、既定は定数個、半径は外側ほど大きい', () => {
    expect(tiltShiftSampleOffsets(0)).toHaveLength(1)
    expect(tiltShiftSampleOffsets(-4)).toHaveLength(1)
    expect(tiltShiftSampleOffsets(NaN)).toHaveLength(1)
    expect(tiltShiftSampleOffsets(5.9)).toHaveLength(5)
    expect(tiltShiftSampleOffsets()).toHaveLength(TILT_SHIFT_SAMPLE_COUNT)
    const s = tiltShiftSampleOffsets(24)
    for (let i = 1; i < s.length; i++) {
      expect(Math.hypot(s[i].x, s[i].y)).toBeGreaterThan(Math.hypot(s[i - 1].x, s[i - 1].y))
    }
    // 重心はほぼ原点（偏りがない）
    const cx = s.reduce((a, p) => a + p.x, 0) / s.length
    const cy = s.reduce((a, p) => a + p.y, 0) / s.length
    expect(Math.hypot(cx, cy)).toBeLessThan(0.1)
  })
})
