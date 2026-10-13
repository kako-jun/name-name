import { describe, expect, it } from 'vitest'
import { normalizeBackgroundTone, saturationToPixiAmount } from './backgroundTone'

describe('normalizeBackgroundTone', () => {
  it('off だけ off。それ以外は on', () => {
    expect(normalizeBackgroundTone('off')).toBe('off')
    expect(normalizeBackgroundTone(' OFF ')).toBe('off')
    expect(normalizeBackgroundTone('on')).toBe('on')
    expect(normalizeBackgroundTone('foo')).toBe('on')
    expect(normalizeBackgroundTone('')).toBe('on')
    expect(normalizeBackgroundTone(null)).toBe('on')
    expect(normalizeBackgroundTone(undefined)).toBe('on')
  })
})

describe('saturationToPixiAmount', () => {
  it('倍率を Pixi の amount（0=変化なし, -1=無彩色）へ変換する', () => {
    expect(saturationToPixiAmount(1)).toBe(0)
    expect(saturationToPixiAmount(0)).toBe(-1)
    expect(saturationToPixiAmount(0.6)).toBeCloseTo(-0.4)
  })
  it('範囲外はクランプ、NaN は変化なし', () => {
    expect(saturationToPixiAmount(2)).toBe(0)
    expect(saturationToPixiAmount(-1)).toBe(-1)
    expect(saturationToPixiAmount(NaN)).toBe(0)
  })
})
