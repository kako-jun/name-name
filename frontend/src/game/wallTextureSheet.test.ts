import { describe, it, expect } from 'vitest'
import { computeWallU, TEXTURE_WIDTH, uToColumn } from './wallTextureSheet'

describe('uToColumn', () => {
  it('u=0 は列 0', () => {
    expect(uToColumn(0, 64)).toBe(0)
  })

  it('u=1 は width-1（範囲外は最後の列へクランプ）', () => {
    expect(uToColumn(1, 64)).toBe(63)
  })

  it('u=0.5 はちょうど中央付近（width=64 なら 32）', () => {
    expect(uToColumn(0.5, 64)).toBe(32)
  })

  it('u < 0 は 0 にクランプ', () => {
    expect(uToColumn(-0.1, 64)).toBe(0)
    expect(uToColumn(-100, 64)).toBe(0)
  })

  it('u > 1 は width-1 にクランプ', () => {
    expect(uToColumn(1.1, 64)).toBe(63)
    expect(uToColumn(100, 64)).toBe(63)
  })

  it('NaN は 0 にフォールバック', () => {
    expect(uToColumn(Number.NaN, 64)).toBe(0)
  })

  it('TEXTURE_WIDTH 定数と整合', () => {
    expect(uToColumn(0.999, TEXTURE_WIDTH)).toBe(TEXTURE_WIDTH - 1)
  })
})

describe('computeWallU', () => {
  // 全パターンで結果が [0, 1) に入っていることを担保する

  it('side=0, rayDirX < 0 → 小数部そのまま', () => {
    // playerY=0.5, perpDist=2, rayDirY=0.1 → wallY = 0.5 + 0.2 = 0.7 → u = 0.7
    const u = computeWallU(0, 2, 3, 0.5, -1, 0.1)
    expect(u).toBeCloseTo(0.7, 5)
  })

  it('side=0, rayDirX > 0 → u が反転', () => {
    // wallY = 0.5 + 0.2 = 0.7 → 反転して 0.3
    const u = computeWallU(0, 2, 3, 0.5, 1, 0.1)
    expect(u).toBeCloseTo(0.3, 5)
  })

  it('side=1, rayDirY > 0 → 小数部そのまま', () => {
    // wallX = 1.0 + 0.3 = 1.3 → 小数部 0.3
    const u = computeWallU(1, 1, 1.0, 3, 0.3, 2)
    expect(u).toBeCloseTo(0.3, 5)
  })

  it('side=1, rayDirY < 0 → u が反転', () => {
    // wallX = 1.3 → 小数部 0.3 → 反転 0.7
    const u = computeWallU(1, 1, 1.0, 3, 0.3, -2)
    expect(u).toBeCloseTo(0.7, 5)
  })

  it('任意の (side, rayDir) 組み合わせで 0 <= u < 1', () => {
    const cases: Array<{
      side: 0 | 1
      perp: number
      px: number
      py: number
      rdx: number
      rdy: number
    }> = [
      { side: 0, perp: 0.1, px: 0.1, py: 0.9, rdx: -1, rdy: 0.3 },
      { side: 0, perp: 5, px: 10.5, py: 3.7, rdx: 1, rdy: -0.4 },
      { side: 1, perp: 2, px: 4.2, py: 2.5, rdx: -0.5, rdy: 1 },
      { side: 1, perp: 3, px: 2.8, py: 8.5, rdx: 0.8, rdy: -1 },
      { side: 0, perp: 0.0001, px: 0, py: 0, rdx: 1, rdy: 1 },
    ]
    for (const c of cases) {
      const u = computeWallU(c.side, c.perp, c.px, c.py, c.rdx, c.rdy)
      expect(u).toBeGreaterThanOrEqual(0)
      expect(u).toBeLessThan(1)
    }
  })

  it('結果が uToColumn と組み合わせて正しい列 index に収まる', () => {
    const u = computeWallU(0, 1, 1.5, 0.5, -1, 0.25)
    const col = uToColumn(u, TEXTURE_WIDTH)
    expect(col).toBeGreaterThanOrEqual(0)
    expect(col).toBeLessThan(TEXTURE_WIDTH)
  })
})
