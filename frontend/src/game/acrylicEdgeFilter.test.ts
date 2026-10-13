/**
 * AcrylicEdgeFilter (#737) の単体テスト。
 *
 * GLSL のコンパイルと実描画は対象外（jsdom に WebGL が無い）。コンストラクタ・setWidths・apply の
 * 「論理 px → 実 px の変位」換算と uniform の組み立てだけを、`filterManager.applyFilter` をスタブして検証する。
 */
import { describe, expect, it, vi } from 'vitest'
import type { FilterSystem, RenderSurface, Texture } from 'pixi.js'
import { ACRYLIC_EDGE_FRAGMENT, AcrylicEdgeFilter } from './acrylicEdgeFilter'
import { computeEdgeOffsets } from './spriteStyle'

interface Uniforms {
  uTexel: Float32Array
  uCounts: Float32Array
  uInner: Float32Array
  uOuter: Float32Array
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
  source: {
    width: number
    height: number
    pixelWidth?: number
    pixelHeight?: number
    resolution?: number
  }
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
    const declared = [...ACRYLIC_EDGE_FRAGMENT.matchAll(/^uniform \w+ (\w+)(?:\[\d+\])?;/gm)].map(
      (m) => m[1]
    )
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

describe('AcrylicEdgeFilter: apply（DPR 換算）', () => {
  // pixi.js 8: source.width は論理幅、source.pixelWidth = 論理幅 × resolution（実ピクセル幅）
  const source = (w: number, h: number, res: number) => ({
    width: w,
    height: h,
    pixelWidth: w * res,
    pixelHeight: h * res,
    resolution: res,
  })
  const pairs = (a: Float32Array, n: number): [number, number][] =>
    Array.from({ length: n }, (_, i) => [a[i * 2], a[i * 2 + 1]])

  it('uTexel = 1/pixelWidth, 1/pixelHeight（論理幅ではなく実ピクセル幅で割る）', () => {
    const f = make()
    f.setWidths(6, 4)
    applyWith(f, source(200, 100, 2))
    const u = uniformsOf(f)
    expect(u.uTexel[0]).toBeCloseTo(1 / 400, 9)
    expect(u.uTexel[1]).toBeCloseTo(1 / 200, 9)
  })

  it('uCounts と uInner / uOuter は computeEdgeOffsets(margin, line, resolution) と一致する', () => {
    const f = make()
    for (const [m, l, res] of [
      [6, 4, 1],
      [6, 4, 2],
      [2, 1.5, 2],
      [3, 2, 1.5],
      [5, 3, 3],
    ]) {
      f.setWidths(m, l)
      applyWith(f, source(64, 64, res))
      const u = uniformsOf(f)
      const o = computeEdgeOffsets(m, l, res)
      const tag = `m=${m} l=${l} res=${res}`
      expect(u.uCounts[0], tag).toBe(o.inner.length)
      expect(u.uCounts[1], tag).toBe(o.outer.length)
      expect(pairs(u.uInner, o.inner.length), tag).toEqual(
        o.inner.map((p) => [Math.fround(p[0]), Math.fround(p[1])])
      )
      expect(pairs(u.uOuter, o.outer.length), tag).toEqual(
        o.outer.map((p) => [Math.fround(p[0]), Math.fround(p[1])])
      )
    }
  })

  it('余白と線を取り違えない（外側の半径は 余白+線、内側の最大半径は余白）', () => {
    const f = make()
    f.setWidths(3, 1)
    applyWith(f, source(10, 10, 1))
    const u = uniformsOf(f)
    const r = (a: Float32Array, i: number): number => Math.hypot(a[i * 2], a[i * 2 + 1])
    for (let i = 0; i < u.uCounts[1]; i++) expect(r(u.uOuter, i)).toBeCloseTo(4, 5)
    let maxInner = 0
    for (let i = 0; i < u.uCounts[0]; i++) maxInner = Math.max(maxInner, r(u.uInner, i))
    expect(maxInner).toBeCloseTo(3, 5)
  })

  // resolution=1 / 1.5 / 2 / 3 のどれでも、UV 上の変位を論理 px に直すと同じ＝DPR で二重にかからない
  it.each([[1], [1.5], [2], [3]])(
    'resolution=%s: UV 変位の論理 px が resolution に依存せず、padding がリングを囲む',
    (res) => {
      const margin = 6
      const line = 4
      const f = make()
      f.setWidths(margin, line)
      const logicalW = 80
      const logicalH = 60
      applyWith(f, source(logicalW, logicalH, res))
      const u = uniformsOf(f)
      let maxLogical = 0
      let minOuterLogical = Infinity
      let maxOuterLogical = 0
      for (let i = 0; i < u.uCounts[1]; i++) {
        // 実 px の変位 × uTexel = UV 変位。論理 px = UV 変位 × 論理幅/高さ
        const lx = u.uOuter[i * 2] * u.uTexel[0] * logicalW
        const ly = u.uOuter[i * 2 + 1] * u.uTexel[1] * logicalH
        const d = Math.hypot(lx, ly)
        minOuterLogical = Math.min(minOuterLogical, d)
        maxOuterLogical = Math.max(maxOuterLogical, d)
        maxLogical = Math.max(maxLogical, Math.abs(lx), Math.abs(ly))
      }
      expect(minOuterLogical).toBeCloseTo(margin + line, 4)
      expect(maxOuterLogical).toBeCloseTo(margin + line, 4)
      // 論理 px の padding が到達距離（余白+線）以上＝リングはフィルタ矩形の内側に収まる
      expect(f.padding).toBeGreaterThanOrEqual(Math.ceil(margin + line))
      expect(maxOuterLogical).toBeLessThanOrEqual(f.padding)
      // 内側サンプルも同様に余白以内
      for (let i = 0; i < u.uCounts[0]; i++) {
        const lx = u.uInner[i * 2] * u.uTexel[0] * logicalW
        const ly = u.uInner[i * 2 + 1] * u.uTexel[1] * logicalH
        expect(Math.hypot(lx, ly)).toBeLessThanOrEqual(margin + 1e-4)
      }
    }
  )

  it('仕様値: margin=2, line=1.5, res=2 は 内側 7・外側 8 サンプル（res を落とす変異で変位が半分になる）', () => {
    const f = make()
    f.setWidths(2, 1.5)
    applyWith(f, source(64, 64, 2))
    const u = uniformsOf(f)
    expect([u.uCounts[0], u.uCounts[1]]).toEqual([7, 8])
    // 外側の半径は (2+1.5)×2 = 7 実 px
    expect(Math.hypot(u.uOuter[0], u.uOuter[1])).toBeCloseTo(7, 4)
  })

  it.each([[0], [undefined]])('source.resolution=%s のとき res=1 として扱う', (resolution) => {
    const f = make()
    f.setWidths(6, 4)
    applyWith(f, { width: 64, height: 64, pixelWidth: 64, pixelHeight: 64, resolution })
    const o = computeEdgeOffsets(6, 4, 1)
    expect(uniformsOf(f).uCounts[0]).toBe(o.inner.length)
    expect(Math.hypot(uniformsOf(f).uOuter[0], uniformsOf(f).uOuter[1])).toBeCloseTo(10, 4)
  })

  it('幅が変わらない間は配列を作り直さず、setWidths / 解像度の変更で更新される', () => {
    const f = make()
    f.setWidths(6, 4)
    applyWith(f, source(64, 64, 1))
    const u = uniformsOf(f)
    u.uInner[0] = 123 // 改ざんしても、同条件の apply では上書きされない（再計算しない）
    applyWith(f, source(64, 64, 1))
    expect(u.uInner[0]).toBe(123)
    f.setWidths(3, 2) // 幅の変更で更新
    applyWith(f, source(64, 64, 1))
    expect(u.uCounts[0]).toBe(computeEdgeOffsets(3, 2, 1).inner.length)
    expect(u.uInner[0]).not.toBe(123)
    applyWith(f, source(64, 64, 2)) // 解像度の変更で更新
    expect(Math.hypot(u.uOuter[0], u.uOuter[1])).toBeCloseTo(10, 4) // (3+2)×2
  })

  it.each([
    [6, 4, 6, 2],
    [6, 4, 3, 4],
  ])('余白だけ・線だけが変わったときも変位列を作り直す（%s,%s → %s,%s）', (m0, l0, m1, l1) => {
    const f = make()
    f.setWidths(m0, l0)
    applyWith(f, source(64, 64, 1))
    f.setWidths(m1, l1)
    applyWith(f, source(64, 64, 1))
    const o = computeEdgeOffsets(m1, l1, 1)
    const u = uniformsOf(f)
    expect([u.uCounts[0], u.uCounts[1]]).toEqual([o.inner.length, o.outer.length])
  })

  it('使わない末尾は 0 に戻る（幅を小さくしたとき古いサンプルが残らない）', () => {
    const f = make()
    f.setWidths(6, 4)
    applyWith(f, source(64, 64, 1))
    f.setWidths(1, 0)
    applyWith(f, source(64, 64, 1))
    const u = uniformsOf(f)
    expect(u.uCounts[1]).toBe(0)
    expect(Array.from(u.uOuter).every((v) => v === 0)).toBe(true)
    const n = u.uCounts[0] * 2
    expect(Array.from(u.uInner.subarray(n)).every((v) => v === 0)).toBe(true)
  })

  it('applyFilter を this / input / output / clearMode で 1 回呼ぶ', () => {
    const f = make(2, 1)
    const applyFilter = vi.fn()
    const input = { source: source(8, 8, 1) } as unknown as Texture
    const output = {} as RenderSurface
    f.apply({ applyFilter } as unknown as FilterSystem, input, output, false)
    expect(applyFilter).toHaveBeenCalledTimes(1)
    expect(applyFilter).toHaveBeenCalledWith(f, input, output, false)
  })
})

describe('AcrylicEdgeFilter: GLSL 整合', () => {
  it('配列 uniform のサイズと MAX_* 定数が spriteStyle の上限と一致する', () => {
    expect(ACRYLIC_EDGE_FRAGMENT).toContain('uniform vec2 uInner[40];')
    expect(ACRYLIC_EDGE_FRAGMENT).toContain('uniform vec2 uOuter[24];')
    expect(ACRYLIC_EDGE_FRAGMENT).toContain('const int MAX_INNER = 40;')
    expect(ACRYLIC_EDGE_FRAGMENT).toContain('const int MAX_OUTER = 24;')
  })

  it('uniform 配列の Float32Array 長は 2×サイズ', () => {
    const u = uniformsOf(make())
    expect(u.uInner.length).toBe(80)
    expect(u.uOuter.length).toBe(48)
  })

  it('合成式がシェーダに残っている（ring = clamp(outerMax - innerMax)、本体を上書きしない (1 - src.a)）', () => {
    expect(ACRYLIC_EDGE_FRAGMENT).toContain('clamp(outerMax - innerMax, 0.0, 1.0)')
    // 変位（実 px）に uTexel を掛けて UV にする。DPR 修正の核心（外すと線が消えるか全面が塗られる）
    expect(ACRYLIC_EDGE_FRAGMENT).toMatch(/vTextureCoord\s*\+\s*offsetPx\s*\*\s*uTexel/)
    expect(ACRYLIC_EDGE_FRAGMENT).toContain('uAlpha * ring * (1.0 - src.a)')
    expect(ACRYLIC_EDGE_FRAGMENT).toContain('outerMax = max(outerMax, innerMax);')
    // 内側ループは uCounts.x、外側ループは uCounts.y で打ち切る（取り違えない）
    expect(ACRYLIC_EDGE_FRAGMENT).toMatch(
      /uCounts\.x\) break;\s+innerMax = max\(innerMax, alphaAt\(uInner\[i\]\)\)/
    )
    expect(ACRYLIC_EDGE_FRAGMENT).toMatch(
      /uCounts\.y\) break;\s+outerMax = max\(outerMax, alphaAt\(uOuter\[i\]\)\)/
    )
  })
})
