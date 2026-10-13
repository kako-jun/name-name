import { describe, expect, it } from 'vitest'
import { computePlateLayout, gaussianBlur, renderAcrylicPlate, smoothstep } from './acrylicPlate'
import { resolveAcrylicParams } from './spriteStyle'

const P = resolveAcrylicParams()

/** 中央に size x size の不透明な正方形がある n x n の alpha */
function square(n: number, size: number): Uint8Array {
  const a = new Uint8Array(n * n)
  const o = Math.floor((n - size) / 2)
  for (let y = o; y < o + size; y++) for (let x = o; x < o + size; x++) a[y * n + x] = 255
  return a
}

describe('smoothstep / gaussianBlur', () => {
  it('smoothstep: 端で 0/1・中央で 0.5・e0==e1 は階段', () => {
    expect(smoothstep(0, 1, -1)).toBe(0)
    expect(smoothstep(0, 1, 2)).toBe(1)
    expect(smoothstep(0, 1, 0.5)).toBeCloseTo(0.5)
    expect(smoothstep(1, 1, 0.9)).toBe(0)
    expect(smoothstep(1, 1, 1.1)).toBe(1)
  })
  it('gaussianBlur: 半径 0 はコピー・値は 0〜1 に収まり・総和はほぼ保存される', () => {
    const src = new Float32Array(30 * 30)
    src[15 * 30 + 15] = 1
    expect(Array.from(gaussianBlur(src, 30, 30, 0))).toEqual(Array.from(src))
    const b = gaussianBlur(src, 30, 30, 3)
    expect(Math.max(...b)).toBeLessThanOrEqual(1)
    expect(Math.min(...b)).toBeGreaterThanOrEqual(0)
    expect(b.reduce((s, v) => s + v, 0)).toBeCloseTo(1, 3)
    expect(b[15 * 30 + 15]).toBeLessThan(1)
  })
})

describe('computePlateLayout', () => {
  it('広がり = (margin + line) × 長辺、リム = line × 長辺、pad は広がり以上', () => {
    const l = computePlateLayout(400, 800, { marginRatio: 0.03, lineWidthRatio: 0.02 })
    expect(l.spread).toBeCloseTo(40)
    expect(l.rim).toBeCloseTo(16)
    expect(l.pad).toBeGreaterThanOrEqual(l.spread)
  })
  it('非有限・負・0 でも 1px 以上で NaN にならない', () => {
    for (const bad of [NaN, Infinity, -1, 0]) {
      const l = computePlateLayout(0, 0, { marginRatio: bad, lineWidthRatio: bad })
      expect(l.spread).toBeGreaterThanOrEqual(1)
      expect(Number.isFinite(l.pad)).toBe(true)
    }
  })
})

describe('renderAcrylicPlate', () => {
  const n = 120
  const alpha = square(n, 60)
  const r = renderAcrylicPlate(alpha, n, n, P)
  const at = (x: number, y: number): number[] => {
    const i = ((y + r.pad) * r.width + x + r.pad) * 4
    return [r.rgba[i], r.rgba[i + 1], r.rgba[i + 2], r.rgba[i + 3]]
  }

  it('寸法は (w + 2pad) x (h + 2pad)', () => {
    expect(r.width).toBe(n + r.pad * 2)
    expect(r.height).toBe(n + r.pad * 2)
    expect(r.rgba).toHaveLength(r.width * r.height * 4)
  })
  it('遠い外側は完全に透明、四隅も透明', () => {
    expect(at(-r.pad, -r.pad)[3]).toBe(0)
    expect(at(n + r.pad - 1, n + r.pad - 1)[3]).toBe(0)
  })
  it('スプライトの外へ板が広がる（輪郭の少し外は不透明度 > 0）が、広がりの外には出ない', () => {
    const { spread } = computePlateLayout(n, n, P)
    const edgeX = 30 // 正方形の左端 x
    expect(at(edgeX - 2, 60)[3]).toBeGreaterThan(0)
    expect(at(edgeX - Math.ceil(spread) - 5, 60)[3]).toBe(0)
  })
  it('内側（奥）はごく薄い透明: 不透明度は fillAlpha 程度に収まる', () => {
    const a = at(60, 60)[3] / 255
    expect(a).toBeGreaterThan(0)
    expect(a).toBeLessThan(0.35)
  })
  it('縁（リム）は内側より明るく不透明', () => {
    const rim = at(24, 60)[3]
    const inner = at(60, 60)[3]
    expect(rim).toBeGreaterThan(inner)
  })
  it('光が当たる左上の縁は、反対側（右下）の縁より強い', () => {
    const maxA = (pts: Array<[number, number]>): number =>
      Math.max(...pts.map(([x, y]) => at(x, y)[3]))
    const left = maxA([20, 22, 24, 26, 28].map((x) => [x, 60] as [number, number]))
    const right = maxA([91, 93, 95, 97, 99].map((x) => [x, 60] as [number, number]))
    expect(left).toBeGreaterThan(right)
  })
  it('透明な画像は全面透明', () => {
    const e = renderAcrylicPlate(new Uint8Array(20 * 20), 20, 20, P)
    expect(e.rgba.every((v) => v === 0)).toBe(true)
  })
  it('不正な寸法・足りない alpha は 1x1 の透明', () => {
    for (const [a, w, h] of [
      [new Uint8Array(0), 0, 0],
      [new Uint8Array(3), 10, 10],
    ] as const) {
      const e = renderAcrylicPlate(a, w, h, P)
      expect([e.width, e.height]).toEqual([1, 1])
      expect(Array.from(e.rgba)).toEqual([0, 0, 0, 0])
    }
  })
})
