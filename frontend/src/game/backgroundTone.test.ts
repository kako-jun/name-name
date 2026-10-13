import { describe, expect, it } from 'vitest'
import {
  BACKGROUND_TONE_BRIGHTNESS,
  BACKGROUND_TONE_SATURATION,
  normalizeBackgroundTone,
  saturationToPixiAmount,
} from './backgroundTone'

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

describe('backgroundTone: 追加の境界', () => {
  it('saturationToPixiAmount: ±Infinity はクランプされ NaN にならない', () => {
    expect(saturationToPixiAmount(Infinity)).toBe(0)
    expect(saturationToPixiAmount(-Infinity)).toBe(-1)
    expect(Number.isNaN(saturationToPixiAmount(Infinity))).toBe(false)
    expect(Number.isNaN(saturationToPixiAmount(-Infinity))).toBe(false)
  })

  it('normalizeBackgroundTone: 非 string は例外なく on', () => {
    for (const v of [0, 1, true, false, {}, []]) {
      expect(normalizeBackgroundTone(v as unknown as string)).toBe('on')
    }
  })

  it("normalizeBackgroundTone: 前後の改行・タブは trim され 'off' になる", () => {
    expect(normalizeBackgroundTone('Off\n')).toBe('off')
    expect(normalizeBackgroundTone('\toff')).toBe('off')
  })

  it('係数は (0, 1] の範囲内（値そのものは固定しない）', () => {
    for (const v of [BACKGROUND_TONE_SATURATION, BACKGROUND_TONE_BRIGHTNESS]) {
      expect(v).toBeGreaterThan(0)
      expect(v).toBeLessThanOrEqual(1)
    }
  })
})
