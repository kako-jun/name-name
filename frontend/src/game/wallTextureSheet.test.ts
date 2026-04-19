import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Renderer } from 'pixi.js'
import {
  __resetWallHeightClampWarning,
  computeWallTextureCrop,
  computeWallU,
  getStackedWallSheet,
  TEXTURE_WIDTH,
  uToColumn,
} from './wallTextureSheet'

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

describe('computeWallTextureCrop (Issue #86 Phase 2-5)', () => {
  it('wallHeight=1 は texture 全体（frameY=0, frameHeight=textureHeight, tileCount=1）', () => {
    const crop = computeWallTextureCrop(64, 1)
    expect(crop.frameY).toBe(0)
    expect(crop.frameHeight).toBe(64)
    expect(crop.tileCount).toBe(1)
  })

  it('wallHeight=0.5, textureHeight=64 → 下半分（frameY=32, frameHeight=32, tileCount=1）', () => {
    const crop = computeWallTextureCrop(64, 0.5)
    expect(crop.frameY).toBe(32)
    expect(crop.frameHeight).toBe(32)
    expect(crop.tileCount).toBe(1)
  })

  it('wallHeight=0.25, textureHeight=64 → 下 1/4（frameY=48, frameHeight=16, tileCount=1）', () => {
    const crop = computeWallTextureCrop(64, 0.25)
    expect(crop.frameY).toBe(48)
    expect(crop.frameHeight).toBe(16)
    expect(crop.tileCount).toBe(1)
  })

  it('wallHeight=0 → frameHeight=0, tileCount=1（描画スキップ）', () => {
    const crop = computeWallTextureCrop(64, 0)
    expect(crop.frameY).toBe(0)
    expect(crop.frameHeight).toBe(0)
    expect(crop.tileCount).toBe(1)
  })

  it('wallHeight 負値 → frameHeight=0（描画スキップ）', () => {
    const crop = computeWallTextureCrop(64, -0.5)
    expect(crop.frameY).toBe(0)
    expect(crop.frameHeight).toBe(0)
    expect(crop.tileCount).toBe(1)
  })

  it('wallHeight=NaN → frameHeight=0（防御）', () => {
    const crop = computeWallTextureCrop(64, Number.NaN)
    expect(crop.frameY).toBe(0)
    expect(crop.frameHeight).toBe(0)
    expect(crop.tileCount).toBe(1)
  })

  it('wallHeight=Infinity → frameHeight=0（防御、>=1 パスに入らない）', () => {
    const crop = computeWallTextureCrop(64, Number.POSITIVE_INFINITY)
    expect(crop.frameY).toBe(0)
    expect(crop.frameHeight).toBe(0)
    expect(crop.tileCount).toBe(1)
  })

  it('textureHeight=128, wallHeight=0.5 → frameY=64, frameHeight=64', () => {
    const crop = computeWallTextureCrop(128, 0.5)
    expect(crop.frameY).toBe(64)
    expect(crop.frameHeight).toBe(64)
    expect(crop.tileCount).toBe(1)
  })

  it('textureHeight=65（奇数）, wallHeight=0.5 → Math.round の丸め（65*0.5=32.5 → 33）', () => {
    // `Math.round(0.5) === 1` を前提に（JS の Math.round は 0.5 を常に切り上げ、銀行丸めではない）
    const crop = computeWallTextureCrop(65, 0.5)
    expect(crop.frameHeight).toBe(33)
    expect(crop.frameY).toBe(32)
    // 合計が textureHeight と一致
    expect(crop.frameY + crop.frameHeight).toBe(65)
  })

  it('wallHeight が極小値で Math.round の結果が 0 になるケースは 1px 保護', () => {
    // textureHeight=64, wallHeight=0.001 → round(0.064) = 0 → 1px に保護
    const crop = computeWallTextureCrop(64, 0.001)
    expect(crop.frameHeight).toBe(1)
    expect(crop.frameY).toBe(63)
  })

  it('frameY + frameHeight は textureHeight と一致（下端が揃う）', () => {
    for (const wh of [0.1, 0.3, 0.5, 0.7, 0.9]) {
      const crop = computeWallTextureCrop(64, wh)
      expect(crop.frameY + crop.frameHeight).toBe(64)
    }
  })
})

describe('computeWallTextureCrop 垂直タイリング (Issue #93)', () => {
  it('wallHeight=1.5 → tileCount=2、下部 1.5 タイル分', () => {
    // stackHeight = 64*2 = 128、frameHeight = round(64*1.5) = 96、frameY = 128-96 = 32
    const crop = computeWallTextureCrop(64, 1.5)
    expect(crop.tileCount).toBe(2)
    expect(crop.frameHeight).toBe(96)
    expect(crop.frameY).toBe(32)
  })

  it('wallHeight=1.25 → tileCount=2、frameHeight=80、frameY=48', () => {
    const crop = computeWallTextureCrop(64, 1.25)
    expect(crop.tileCount).toBe(2)
    expect(crop.frameHeight).toBe(80)
    expect(crop.frameY).toBe(48)
  })

  it('wallHeight=2.0 ちょうど → tileCount=2、frameHeight=128、frameY=0', () => {
    const crop = computeWallTextureCrop(64, 2.0)
    expect(crop.tileCount).toBe(2)
    expect(crop.frameHeight).toBe(128)
    expect(crop.frameY).toBe(0)
  })

  it('wallHeight=2.5 → tileCount=3、frameHeight=160、frameY=32', () => {
    // stackHeight = 64*3 = 192、frameHeight = round(64*2.5) = 160、frameY = 192-160 = 32
    const crop = computeWallTextureCrop(64, 2.5)
    expect(crop.tileCount).toBe(3)
    expect(crop.frameHeight).toBe(160)
    expect(crop.frameY).toBe(32)
  })

  it('wallHeight=3.0 ちょうど → tileCount=3、frameHeight=192、frameY=0', () => {
    const crop = computeWallTextureCrop(64, 3.0)
    expect(crop.tileCount).toBe(3)
    expect(crop.frameHeight).toBe(192)
    expect(crop.frameY).toBe(0)
  })

  it('境界: wallHeight=2.0000001 は tileCount=3（厳密比較で次のバケット）', () => {
    const crop = computeWallTextureCrop(64, 2.0000001)
    expect(crop.tileCount).toBe(3)
  })

  it('境界: wallHeight=1.0 は tileCount=1（ちょうど 1 は 1 タイル）', () => {
    const crop = computeWallTextureCrop(64, 1.0)
    expect(crop.tileCount).toBe(1)
  })

  it('wallHeight=3.5 → tileCount=3 クランプ、frameY=0、frameHeight=3*textureHeight', () => {
    const crop = computeWallTextureCrop(64, 3.5)
    expect(crop.tileCount).toBe(3)
    expect(crop.frameY).toBe(0)
    expect(crop.frameHeight).toBe(192)
  })

  it('wallHeight=100 → tileCount=3 クランプ', () => {
    const crop = computeWallTextureCrop(64, 100)
    expect(crop.tileCount).toBe(3)
    expect(crop.frameY).toBe(0)
    expect(crop.frameHeight).toBe(192)
  })

  it('tileCount>=2 のとき frameY + frameHeight は stackHeight と一致（下端が揃う）', () => {
    for (const wh of [1.1, 1.5, 1.9, 2.1, 2.5, 2.9]) {
      const crop = computeWallTextureCrop(64, wh)
      const stackHeight = 64 * crop.tileCount
      expect(crop.frameY + crop.frameHeight).toBe(stackHeight)
    }
  })

  it('frameY は全 wh ∈ (0, 3] で 0 以上（round 誤差の invariant）', () => {
    // 境界ちょうど / ちょい手前 / ちょい後 / 中央を含む
    const whs = [0.001, 0.5, 1.0, 1.0001, 1.5, 1.9999, 2.0, 2.0001, 2.999, 3.0]
    for (const wh of whs) {
      const crop = computeWallTextureCrop(64, wh)
      expect(crop.frameY).toBeGreaterThanOrEqual(0)
      expect(crop.frameY + crop.frameHeight).toBeLessThanOrEqual(crop.tileCount * 64)
    }
  })
})

describe('getStackedWallSheet キャッシュ (Issue #93)', () => {
  /**
   * renderer モック。`render` だけ spy で、PIXI の RenderTexture.create は WebGL 不要なので
   * jsdom で動く（実 GPU 割り当ては renderer.render 呼び出し時まで遅延される）。
   * getStackedWallSheet から渡される renderer は Pick<Renderer, 'render'> 相当で使えれば十分。
   */
  function makeRendererMock(): Renderer {
    return { render: vi.fn() } as unknown as Renderer
  }

  it('同じ renderer / kind / tileCount で 2 回呼ぶと同じ sheet インスタンスを返す', () => {
    const r = makeRendererMock()
    const s1 = getStackedWallSheet(r, 'tree', 2)
    const s2 = getStackedWallSheet(r, 'tree', 2)
    expect(s1).toBe(s2)
  })

  it('異なる renderer で呼ぶと別インスタンスを返す（WeakMap 分離）', () => {
    const r1 = makeRendererMock()
    const r2 = makeRendererMock()
    const s1 = getStackedWallSheet(r1, 'tree', 2)
    const s2 = getStackedWallSheet(r2, 'tree', 2)
    expect(s1).not.toBe(s2)
  })

  it('同じ renderer で異なる (kind, tileCount) は別インスタンスを返す（Map 分離）', () => {
    const r = makeRendererMock()
    const treeT2 = getStackedWallSheet(r, 'tree', 2)
    const treeT3 = getStackedWallSheet(r, 'tree', 3)
    const waterT2 = getStackedWallSheet(r, 'water', 2)
    expect(treeT2).not.toBe(treeT3)
    expect(treeT2).not.toBe(waterT2)
    expect(treeT3).not.toBe(waterT2)
  })

  it('キャッシュヒット時は renderer.render が追加で呼ばれない（2 回目以降の build 抑止）', () => {
    const r = makeRendererMock()
    const renderSpy = r.render as ReturnType<typeof vi.fn>
    getStackedWallSheet(r, 'tree', 2)
    const countAfterFirst = renderSpy.mock.calls.length
    getStackedWallSheet(r, 'tree', 2)
    expect(renderSpy.mock.calls.length).toBe(countAfterFirst)
  })
})

describe('wh>3 クランプ警告 (Issue #93)', () => {
  beforeEach(() => {
    __resetWallHeightClampWarning()
  })

  it('テスト環境では警告は出ない（MODE=test で抑制）が、フラグは立つので 2 回目以降も沈黙', () => {
    // 実際に console.warn が呼ばれないことを spy で担保する。
    // import.meta.env.MODE === 'test' のため、warnWallHeightClampedOnce は warn を呼ばずに return する。
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    computeWallTextureCrop(64, 5)
    computeWallTextureCrop(64, 10)
    expect(warnSpy).not.toHaveBeenCalled()
    warnSpy.mockRestore()
  })
})
