import { describe, expect, it } from 'vitest'
import {
  DOF_DEFAULT_PARAMS,
  computeDofGradient,
  dofAlphaAt,
  dofMaskStops,
  normalizeBackgroundDof,
} from './depthOfField'

describe('normalizeBackgroundDof', () => {
  it('on だけ on。未指定・空・未知値は off', () => {
    expect(normalizeBackgroundDof('on')).toBe('on')
    expect(normalizeBackgroundDof(' ON ')).toBe('on')
    expect(normalizeBackgroundDof('off')).toBe('off')
    expect(normalizeBackgroundDof('foo')).toBe('off')
    expect(normalizeBackgroundDof('')).toBe('off')
    expect(normalizeBackgroundDof(null)).toBe('off')
    expect(normalizeBackgroundDof(undefined)).toBe('off')
  })
})

describe('computeDofGradient', () => {
  it('既定: 開始 0.45・幅 0.4 → 立ち上がり割合は 0.4/0.55', () => {
    const g = computeDofGradient(1000)
    expect(g.startY).toBeCloseTo(450)
    expect(g.maskHeight).toBeCloseTo(550)
    expect(g.rampFraction).toBeCloseTo(0.4 / 0.55)
    expect(g.blurStrength).toBe(DOF_DEFAULT_PARAMS.maxBlurStrength)
  })
  it('幅が下端を越えるときは下端で切り詰める（割合 1）', () => {
    const g = computeDofGradient(1000, { startRatio: 0.8, gradientRatio: 0.9, maxBlurStrength: 3 })
    expect(g.rampFraction).toBe(1)
    expect(g.blurStrength).toBe(3)
  })
  it('異常値でも落ちない（幅 0・開始が下端・NaN・負の高さ）', () => {
    const a = computeDofGradient(500, { startRatio: 0.5, gradientRatio: 0, maxBlurStrength: 6 })
    expect(a.rampFraction).toBeGreaterThan(0)
    const b = computeDofGradient(500, { startRatio: 1, gradientRatio: 0.4, maxBlurStrength: NaN })
    expect(b.maskHeight).toBe(0)
    expect(b.rampFraction).toBe(1)
    expect(b.blurStrength).toBe(0)
    expect(computeDofGradient(-10).maskHeight).toBe(0)
    expect(
      computeDofGradient(100, { startRatio: -1, gradientRatio: 2, maxBlurStrength: -5 })
    ).toMatchObject({
      startY: 0,
      maskHeight: 100,
      rampFraction: 1,
      blurStrength: 0,
    })
  })
})

describe('dofAlphaAt / dofMaskStops', () => {
  it('上端 0 → ramp で 1 → 以降 1', () => {
    expect(dofAlphaAt(0, 0.5)).toBe(0)
    expect(dofAlphaAt(0.25, 0.5)).toBeCloseTo(0.5)
    expect(dofAlphaAt(0.5, 0.5)).toBe(1)
    expect(dofAlphaAt(1, 0.5)).toBe(1)
    expect(dofAlphaAt(NaN, 0.5)).toBe(0)
  })
  it('色止めは alphaAt と一致する端点を持つ', () => {
    expect(dofMaskStops(1)).toEqual([
      { offset: 0, alpha: 0 },
      { offset: 1, alpha: 1 },
    ])
    expect(dofMaskStops(0.5)).toEqual([
      { offset: 0, alpha: 0 },
      { offset: 0.5, alpha: 1 },
      { offset: 1, alpha: 1 },
    ])
  })
})
