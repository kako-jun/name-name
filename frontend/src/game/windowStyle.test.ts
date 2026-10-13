import { describe, expect, it } from 'vitest'
import { computeBands, lerpColor, normalizeWindowStyle } from './windowStyle'

describe('normalizeWindowStyle', () => {
  it('ff-blue のみ ff-blue、それ以外は dark', () => {
    expect(normalizeWindowStyle('ff-blue')).toBe('ff-blue')
    expect(normalizeWindowStyle(' FF-Blue ')).toBe('ff-blue')
    expect(normalizeWindowStyle('dark')).toBe('dark')
    expect(normalizeWindowStyle('xxx')).toBe('dark')
    expect(normalizeWindowStyle('')).toBe('dark')
    expect(normalizeWindowStyle(null)).toBe('dark')
    expect(normalizeWindowStyle(undefined)).toBe('dark')
  })
})

describe('lerpColor', () => {
  it('両端と中間', () => {
    expect(lerpColor(0x000000, 0xffffff, 0)).toBe(0x000000)
    expect(lerpColor(0x000000, 0xffffff, 1)).toBe(0xffffff)
    expect(lerpColor(0x000000, 0xfefefe, 0.5)).toBe(0x7f7f7f)
  })
})

describe('computeBands', () => {
  it('帯は隙間なく高さを覆い、上端色→下端色になる', () => {
    const bands = computeBands(100, 8, 0x4a5ad8, 0x000a50)
    expect(bands).toHaveLength(8)
    expect(bands[0].y).toBe(0)
    expect(bands[0].color).toBe(0x4a5ad8)
    expect(bands[7].color).toBe(0x000a50)
    let y = 0
    for (const b of bands) {
      expect(b.y).toBe(y)
      expect(b.h).toBeGreaterThan(0)
      y += b.h
    }
    expect(y).toBe(100)
  })
  it('高さより帯数が多ければ帯数を減らす・不正入力は空', () => {
    expect(computeBands(3, 9)).toHaveLength(3)
    expect(computeBands(0)).toEqual([])
    expect(computeBands(50, 0)).toEqual([])
  })
})
