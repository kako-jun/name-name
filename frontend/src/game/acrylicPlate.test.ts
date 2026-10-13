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

// ---------------------------------------------------------------------------
// #760 追加観点。旧 AcrylicEdgeFilter のテストが守っていた性質（色・不透明度の反映、lineAlpha=0 で枠が消える、
// 解像度に依存しない幅、再実行で追従）を新方式（元画像解像度の板ラスタ）で守る。
// ---------------------------------------------------------------------------
describe('renderAcrylicPlate: パラメータの反映 (#760)', () => {
  const n = 120
  const alpha = square(n, 60)
  const render = (over: Partial<typeof P>): ReturnType<typeof renderAcrylicPlate> =>
    renderAcrylicPlate(alpha, n, n, { ...P, ...over })
  const px = (r: ReturnType<typeof renderAcrylicPlate>, x: number, y: number): number[] => {
    const i = ((y + r.pad) * r.width + x + r.pad) * 4
    return [r.rgba[i], r.rgba[i + 1], r.rgba[i + 2], r.rgba[i + 3]]
  }
  /** 全ピクセルの alpha 合計 */
  const total = (r: ReturnType<typeof renderAcrylicPlate>): number => {
    let t = 0
    for (let i = 3; i < r.rgba.length; i += 4) t += r.rgba[i]
    return t
  }

  it('lineColor が縁の色に反映される（赤 0xff0000 は R が B より十分大きく、既定の水色 0xe6f3ff は B ≥ R）', () => {
    const red = px(render({ lineColor: 0xff0000 }), 24, 60)
    const def = px(render({}), 24, 60)
    expect(red[0] - red[2]).toBeGreaterThan(60)
    expect(def[2]).toBeGreaterThanOrEqual(def[0])
  })

  it('lineAlpha=0 で縁（リム）が消える: 縁の不透明度が内側の面程度まで落ちる', () => {
    const off = render({ lineAlpha: 0 })
    const on = render({})
    expect(px(off, 24, 60)[3]).toBeLessThan(px(on, 24, 60)[3])
    expect(px(off, 24, 60)[3] / 255).toBeLessThan(0.35)
    // 左上・右下の差（リムの光側強調）も消える
    const maxOf = (r: ReturnType<typeof renderAcrylicPlate>, xs: number[]): number =>
      Math.max(...xs.map((x) => px(r, x, 60)[3]))
    expect(maxOf(on, [20, 22, 24, 26])).toBeGreaterThan(maxOf(on, [93, 95, 97, 99]))
  })

  it('lineAlpha が大きいほど縁は濃い（単調）', () => {
    const a = (v: number): number => px(render({ lineAlpha: v }), 24, 60)[3]
    expect(a(0.2)).toBeLessThan(a(0.5))
    expect(a(0.5)).toBeLessThan(a(0.9))
  })

  it('plateFillAlpha=0 / specularAlpha=0 / innerShadowAlpha=0 で奥の面が完全に透明、plateFillAlpha を上げると面が濃くなる', () => {
    const none = render({ plateFillAlpha: 0, specularAlpha: 0, innerShadowAlpha: 0 })
    expect(px(none, 60, 60)[3]).toBe(0)
    const thin = render({ plateFillAlpha: 0.07, specularAlpha: 0, innerShadowAlpha: 0 })
    const thick = render({ plateFillAlpha: 0.4, specularAlpha: 0, innerShadowAlpha: 0 })
    expect(px(thin, 60, 60)[3]).toBeCloseTo(Math.round(0.07 * 255), -1)
    expect(px(thick, 60, 60)[3]).toBeGreaterThan(px(thin, 60, 60)[3])
  })

  it('specularAlpha を上げると鏡面ハイライトの筋ぶん板全体の不透明度の合計が増える', () => {
    const base = { plateFillAlpha: 0.07, innerShadowAlpha: 0 }
    expect(total(render({ ...base, specularAlpha: 0.6 }))).toBeGreaterThan(
      total(render({ ...base, specularAlpha: 0 }))
    )
  })

  it('innerShadowAlpha は光と反対側（右の縁の内側）にだけ効き、光側（左の縁の内側）は変わらない', () => {
    const off = render({ innerShadowAlpha: 0 })
    const on = render({ innerShadowAlpha: 0.6 })
    // 正方形は x 30〜89。右の縁のすぐ内側と、左の縁のすぐ内側
    const right = (r: ReturnType<typeof renderAcrylicPlate>): number =>
      Math.max(...[86, 87, 88, 89].map((x) => px(r, x, 60)[3]))
    const left = (r: ReturnType<typeof renderAcrylicPlate>): number =>
      Math.max(...[30, 31, 32, 33].map((x) => px(r, x, 60)[3]))
    expect(right(on)).toBeGreaterThan(right(off))
    expect(left(on)).toBe(left(off))
  })

  it('板の幅は画像の大きさに比例する（解像度に依らない: 2 倍の画像は 2 倍の広がり）', () => {
    const small = computePlateLayout(100, 200, P)
    const big = computePlateLayout(200, 400, P)
    expect(big.spread / small.spread).toBeCloseTo(2, 9)
    expect(big.rim / small.rim).toBeCloseTo(2, 9)
  })

  it('同じ入力なら同じラスタ（純粋・決定的）で、入力の alpha を壊さない', () => {
    const a1 = square(n, 60)
    const copy = Uint8Array.from(a1)
    const r1 = renderAcrylicPlate(a1, n, n, P)
    const r2 = renderAcrylicPlate(a1, n, n, P)
    expect(Array.from(a1)).toEqual(Array.from(copy))
    expect(Array.from(r1.rgba)).toEqual(Array.from(r2.rgba))
    expect(Array.from(r1.shape)).toEqual(Array.from(r2.shape))
  })

  it('shape は 0〜1・寸法は rgba と一致し、元画像の不透明部分では 1、遠い外では 0（影の元になる）', () => {
    const r = render({})
    expect(r.shape).toHaveLength(r.width * r.height)
    expect(r.shape.every((v) => v >= 0 && v <= 1)).toBe(true)
    expect(r.shape[(60 + r.pad) * r.width + 60 + r.pad]).toBeCloseTo(1, 6)
    expect(r.shape[0]).toBe(0)
  })

  it('縦長の画像（w≠h）でも寸法は (w+2pad)x(h+2pad)・縦横を取り違えない', () => {
    const w = 40
    const h = 100
    const a = new Uint8Array(w * h).fill(255)
    const r = renderAcrylicPlate(a, w, h, P)
    expect(r.width).toBe(w + r.pad * 2)
    expect(r.height).toBe(h + r.pad * 2)
    expect(r.rgba).toHaveLength(r.width * r.height * 4)
    expect(r.shape).toHaveLength(r.width * r.height)
  })

  it('全面不透明の画像でも板は画像の外へ広がる（pad ぶん）', () => {
    const w = 40
    const a = new Uint8Array(w * w).fill(255)
    const r = renderAcrylicPlate(a, w, w, P)
    expect(r.rgba[(r.pad - 2) * r.width * 4 + (r.pad + 20) * 4 + 3]).toBeGreaterThan(0)
  })

  it('lineColor の下位ビットと上位ビットを取り違えない（0x0000ff は B 優位・0xff0000 は R 優位）', () => {
    const b = px(render({ lineColor: 0x0000ff }), 24, 60)
    expect(b[2]).toBeGreaterThan(b[0] + 60)
  })
})
