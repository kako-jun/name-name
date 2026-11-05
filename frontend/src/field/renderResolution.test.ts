import { describe, expect, it } from 'vitest'
import { fieldRenderResolution } from './renderResolution'

describe('fieldRenderResolution (#53)', () => {
  it('DPR をそのまま使う（2 まで）', () => {
    expect(fieldRenderResolution(1, 1536, 1024)).toBe(1)
    expect(fieldRenderResolution(1.5, 1536, 1024)).toBe(1.5)
    expect(fieldRenderResolution(2, 1536, 1024)).toBe(2)
  })
  it('DPR 3 は 2 に収める', () => {
    expect(fieldRenderResolution(3, 1536, 1024)).toBe(2)
  })
  it('大きいシーンは裏バッファ長辺が 8192 に収まるよう頭打ち', () => {
    expect(fieldRenderResolution(2, 5000, 3000)).toBeCloseTo(8192 / 5000)
    // 縦長でも長辺（高さ）基準
    expect(fieldRenderResolution(2, 3000, 6000)).toBeCloseTo(8192 / 6000)
    expect(5000 * fieldRenderResolution(2, 5000, 3000)).toBeLessThanOrEqual(8192)
  })
  it('不正な DPR は 1', () => {
    for (const bad of [0, -1, NaN, Infinity, undefined]) {
      expect(fieldRenderResolution(bad, 1536, 1024)).toBe(1)
    }
  })
})
