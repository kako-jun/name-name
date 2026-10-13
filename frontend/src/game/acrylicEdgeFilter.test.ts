/**
 * AcrylicEdgeFilter (#737) の単体テスト。
 *
 * GLSL のコンパイルと実描画は対象外（jsdom に WebGL が無い）。コンストラクタ・setWidths・apply の
 * 「論理 px → フィルタテクスチャ px」換算と uniform の組み立てだけを、`filterManager.applyFilter` をスタブして検証する。
 */
import { describe, expect, it, vi } from 'vitest'
import type { FilterSystem, RenderSurface, Texture } from 'pixi.js'
import { ACRYLIC_EDGE_FRAGMENT, AcrylicEdgeFilter } from './acrylicEdgeFilter'
import { computeEdgeSampling } from './spriteStyle'

interface Uniforms {
  uTexel: Float32Array
  uRadii: Float32Array
  uRings: Float32Array
  uColor: Float32Array
  uAlpha: number
}
const uniformsOf = (f: AcrylicEdgeFilter): Uniforms =>
  (f as unknown as { uniforms: Uniforms }).uniforms

function make(margin = 0, line = 0, alpha = 0.85, color: number | string = 0xe6f3ff) {
  return new AcrylicEdgeFilter({ marginPx: margin, linePx: line, color, alpha })
}

function applyWith(
  f: AcrylicEdgeFilter,
  source: { width: number; height: number; resolution?: number }
): ReturnType<typeof vi.fn> {
  const applyFilter = vi.fn()
  const fm = { applyFilter } as unknown as FilterSystem
  f.apply(fm, { source } as unknown as Texture, {} as RenderSurface, true)
  return applyFilter
}

describe('AcrylicEdgeFilter: コンストラクタ', () => {
  it('color / alpha が uniform に反映される（0xe6f3ff → [0.9, 0.95, 1]）', () => {
    const f = make(0, 0, 0.5, 0xe6f3ff)
    const u = uniformsOf(f)
    expect(u.uColor[0]).toBeCloseTo(0xe6 / 255, 5)
    expect(u.uColor[1]).toBeCloseTo(0xf3 / 255, 5)
    expect(u.uColor[2]).toBeCloseTo(1, 5)
    expect(u.uColor[0]).toBeCloseTo(0.9, 1)
    expect(u.uColor[1]).toBeCloseTo(0.95, 1)
    expect(u.uAlpha).toBe(0.5)
  })

  it('色は ColorSource（文字列）でも受け取れる', () => {
    const u = uniformsOf(make(0, 0, 1, '#ff0000'))
    expect([u.uColor[0], u.uColor[1], u.uColor[2]]).toEqual([1, 0, 0])
  })

  it('コンストラクタ時点で setWidths が呼ばれ padding が反映される', () => {
    expect(make(1.2, 0.1).padding).toBe(3)
  })

  it('シェーダの uniform 名と TS 側の uniform キーが一致する（uTexture / uInputClamp は pixi 供給）', () => {
    const declared = [...ACRYLIC_EDGE_FRAGMENT.matchAll(/^uniform \w+ (\w+);/gm)].map((m) => m[1])
    const pixiProvided = ['uTexture', 'uInputClamp']
    const mine = declared.filter((n) => !pixiProvided.includes(n)).sort()
    expect(mine).toEqual(Object.keys(uniformsOf(make())).sort())
    expect(declared).toEqual(expect.arrayContaining(pixiProvided))
  })
})

describe('AcrylicEdgeFilter: setWidths', () => {
  it.each([
    [0, 0, 1],
    [1.2, 0.1, 3], // ceil(1.3)=2 + 1
    [2, 1, 4], // ちょうど整数 3 → 3 + 1
    [-5, -5, 1], // 負は 0 に丸めて 1
    [-5, 3, 4], // 負の片方は 0、もう片方は生きる（ceil(3)+1）
  ])('setWidths(%s, %s) → padding %s（ceil(margin+line)+1）', (m, l, pad) => {
    const f = make()
    f.setWidths(m, l)
    expect(f.padding).toBe(pad)
  })

  it('呼び直しで padding が追従する（インスタンスは同一・再生成しない）', () => {
    const f = make(0, 0)
    expect(f.padding).toBe(1)
    f.setWidths(10, 4)
    expect(f.padding).toBe(15)
    f.setWidths(0, 0)
    expect(f.padding).toBe(1)
  })
})

describe('AcrylicEdgeFilter: apply', () => {
  it('uRadii = [margin×res, (margin+line)×res]、uTexel = 1/source の幅・高さ', () => {
    const f = make()
    f.setWidths(6, 4)
    applyWith(f, { width: 200, height: 100, resolution: 2 })
    const u = uniformsOf(f)
    expect(u.uRadii[0]).toBe(12)
    expect(u.uRadii[1]).toBe(20)
    expect(u.uTexel[0]).toBeCloseTo(1 / 200, 9)
    expect(u.uTexel[1]).toBeCloseTo(1 / 100, 9)
  })

  it('余白と線を取り違えない（uRadii[1] は 余白+線）', () => {
    const f = make()
    f.setWidths(3, 1)
    applyWith(f, { width: 10, height: 10, resolution: 1 })
    expect(Array.from(uniformsOf(f).uRadii)).toEqual([3, 4])
  })

  it('uRings は換算後の半径から computeEdgeSampling と一致して決まる', () => {
    const f = make()
    for (const [m, l, res] of [
      [6, 4, 1],
      [6, 4, 2],
      [0, 0, 1],
      [30, 20, 3],
    ]) {
      f.setWidths(m, l)
      applyWith(f, { width: 64, height: 64, resolution: res })
      const s = computeEdgeSampling(m * res, l * res)
      expect(Array.from(uniformsOf(f).uRings)).toEqual([s.innerRings, s.outerRings, s.directions])
    }
  })

  it('仕様値: margin=6, line=4, res=2 → rings [2,2] で方向 12（換算後の余白 12px・線 8px）', () => {
    const f = make()
    f.setWidths(6, 4)
    applyWith(f, { width: 64, height: 64, resolution: 2 })
    expect(Array.from(uniformsOf(f).uRings)).toEqual([2, 2, 12])
  })

  it('仕様値: 既定の最小幅 margin=2, line=1.5, res=1 → rings [1,1] で方向 9（線の幅を第 2 引数に渡す）', () => {
    // computeEdgeSampling の第 2 引数は「線の幅」。余白+線の半径を渡すと outer が 2 段・方向 14 に膨らむ
    const f = make()
    f.setWidths(2, 1.5)
    applyWith(f, { width: 64, height: 64, resolution: 1 })
    expect(Array.from(uniformsOf(f).uRings)).toEqual([1, 1, 9])
  })

  it.each([[0], [undefined]])('source.resolution=%s のとき res=1 として扱う', (resolution) => {
    const f = make()
    f.setWidths(6, 4)
    applyWith(f, { width: 64, height: 64, resolution })
    expect(Array.from(uniformsOf(f).uRadii)).toEqual([6, 10])
  })

  it('applyFilter を this / input / output / clearMode で 1 回呼ぶ', () => {
    const f = make(2, 1)
    const applyFilter = vi.fn()
    const input = { source: { width: 8, height: 8, resolution: 1 } } as unknown as Texture
    const output = {} as RenderSurface
    f.apply({ applyFilter } as unknown as FilterSystem, input, output, false)
    expect(applyFilter).toHaveBeenCalledTimes(1)
    expect(applyFilter).toHaveBeenCalledWith(f, input, output, false)
  })

  it('apply を解像度違いで呼び直すと uniform が追従する（古い値が残らない）', () => {
    const f = make()
    f.setWidths(6, 4)
    applyWith(f, { width: 100, height: 100, resolution: 3 })
    expect(uniformsOf(f).uRadii[0]).toBe(18)
    applyWith(f, { width: 50, height: 40, resolution: 1 })
    expect(Array.from(uniformsOf(f).uRadii)).toEqual([6, 10])
    expect(uniformsOf(f).uTexel[0]).toBeCloseTo(1 / 50, 9)
    expect(uniformsOf(f).uTexel[1]).toBeCloseTo(1 / 40, 9)
  })
})
