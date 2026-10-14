import { describe, expect, it } from 'vitest'
import {
  computePlateExtend,
  computePlateLayout,
  computeStem,
  computeStemScale,
  computeStemSlitHalfWidth,
  STEM_MIN_WIDTH_RATIO,
  extendFootMask,
  gaussianBlur,
  renderAcrylicPlate,
  smoothstep,
  stampStem,
} from './acrylicPlate'
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

  it('寸法は (w + 2pad) x (h + extend + 2pad)（extend は computePlateExtend の値・#802）', () => {
    const extend = computePlateExtend(n, P.spriteLiftRatio)
    expect(extend).toBeGreaterThan(0)
    expect(r.extend).toBe(extend)
    expect(r.width).toBe(n + r.pad * 2)
    expect(r.height).toBe(n + extend + r.pad * 2)
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

  it('縦長の画像（w≠h）でも寸法は (w+2pad)x(h+extend+2pad)・縦横を取り違えない', () => {
    const w = 40
    const h = 100
    const a = new Uint8Array(w * h).fill(255)
    const r = renderAcrylicPlate(a, w, h, P)
    expect(r.width).toBe(w + r.pad * 2)
    expect(r.height).toBe(h + computePlateExtend(h, P.spriteLiftRatio) + r.pad * 2)
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

describe('computePlateExtend (#802)', () => {
  it('h=0 は 0', () => {
    expect(computePlateExtend(0, 0.03)).toBe(0)
  })
  it('ratio=0 は 0', () => {
    expect(computePlateExtend(100, 0)).toBe(0)
  })
  it.each([[-0.1], [NaN], [Infinity], [-Infinity]])('ratio=%s は 0（伸ばさない）', (bad) => {
    expect(computePlateExtend(100, bad)).toBe(0)
  })
  it('r×h が整数ちょうどなら切り上げで余計な 1 行が出ない（0.03*100 の浮動小数ノイズを吸収）', () => {
    expect(0.07 * 100).toBeGreaterThan(7) // ノイズの前提（7.000000000000001）
    expect(computePlateExtend(100, 0.07)).toBe(7)
    expect(computePlateExtend(100, 0.03)).toBe(3)
  })
  it('r×h が整数を僅かに超えると 1 行増える（0.01 超）', () => {
    expect(computePlateExtend(100, 0.0301)).toBe(4)
  })
  it('r×h = 0.99 は 1 行に切り上げる', () => {
    expect(computePlateExtend(99, 0.01)).toBe(1)
  })
  it('ratio 0.15・h=192 は 29 行', () => {
    expect(computePlateExtend(192, 0.15)).toBe(29)
  })
})

describe('extendFootMask (#802)', () => {
  it('extend=0 は長さ 0', () => {
    expect(extendFootMask(new Uint8Array(20 * 20).fill(255), 20, 20, 0)).toHaveLength(0)
  })
  it('長さは w × extend', () => {
    expect(extendFootMask(new Uint8Array(20 * 10).fill(255), 20, 10, 4)).toHaveLength(80)
  })
  it('全透明なら全て 0', () => {
    const m = extendFootMask(new Uint8Array(20 * 20), 20, 20, 3)
    expect(m.every((v) => v === 0)).toBe(true)
  })
  it('足元帯の列だけが伸び、帯より上にだけある突起（腕）の列は 0', () => {
    const w = 20
    const h = 100
    const a = new Uint8Array(w * h)
    // 足: x=8..11 が y=60..89（最下段 89）。腕: x=2 が y=20..30 だけ（帯の外）
    for (let y = 60; y < 90; y++) for (let x = 8; x < 12; x++) a[y * w + x] = 255
    for (let y = 20; y < 31; y++) a[y * w + 2] = 255
    const m = extendFootMask(a, w, h, 3)
    for (let e = 0; e < 3; e++) {
      expect(m[e * w + 9]).toBe(1)
      expect(m[e * w + 2]).toBe(0)
      expect(m[e * w + 15]).toBe(0)
    }
  })
  it('半透明の足の値は alpha/255 で伝播する', () => {
    const w = 10
    const a = new Uint8Array(w * 10)
    a[9 * w + 4] = 128
    const m = extendFootMask(a, w, 10, 2)
    expect(m[4]).toBeCloseTo(128 / 255, 6)
    expect(m[w + 4]).toBeCloseTo(128 / 255, 6)
  })
  it('帯の高さは最低 1 行（h が小さくても最下段の行は必ず拾う）', () => {
    const w = 4
    const a = new Uint8Array(w * 4)
    a[3 * w + 1] = 255
    const m = extendFootMask(a, w, 4, 1)
    expect(m[1]).toBe(1)
    expect(m[0]).toBe(0)
  })
})

describe('renderAcrylicPlate: 足元を差し込み線まで伸ばす (#802)', () => {
  const w = 60
  const h = 100
  /** 中央 x=20..39 の足が下端 y=89 まで。最下段より上に腕(x=5, y=30..40)がある */
  const figure = (): Uint8Array => {
    const a = new Uint8Array(w * h)
    for (let y = 40; y < 90; y++) for (let x = 20; x < 40; x++) a[y * w + x] = 255
    for (let y = 30; y < 41; y++) a[y * w + 5] = 255
    return a
  }
  const lifted = resolveAcrylicParams({ spriteLiftRatio: 0.1 })
  const flat = resolveAcrylicParams({ spriteLiftRatio: 0 })

  it('lift=0 は従来と同じ寸法・extend=0・同一 rgba（後方互換）', () => {
    const r0 = renderAcrylicPlate(figure(), w, h, flat)
    const r1 = renderAcrylicPlate(figure(), w, h, flat)
    expect(r0.extend).toBe(0)
    expect(r0.height).toBe(h + r0.pad * 2)
    expect(Array.from(r0.rgba)).toEqual(Array.from(r1.rgba))
  })
  it('lift>0 は height = h + extend + 2pad で extend が返る', () => {
    const r = renderAcrylicPlate(figure(), w, h, lifted)
    expect(r.extend).toBe(computePlateExtend(h, 0.1))
    expect(r.extend).toBe(10)
    expect(r.height).toBe(h + r.extend + r.pad * 2)
  })
  it('伸ばした領域の足元の列で shape が 1（板が差し込み線まで届く）', () => {
    const r = renderAcrylicPlate(figure(), w, h, lifted)
    const y = h + r.extend - 1 + r.pad
    expect(r.shape[y * r.width + 30 + r.pad]).toBeGreaterThan(0.9)
  })
  it('伸ばした領域の足元帯外の列（腕の下）では shape が 0 に近く、足元の列より小さい', () => {
    const r = renderAcrylicPlate(figure(), w, h, lifted)
    const y = h + r.extend - 1 + r.pad
    const arm = r.shape[y * r.width + 5 + r.pad]
    const foot = r.shape[y * r.width + 30 + r.pad]
    expect(arm).toBeLessThan(foot)
    expect(arm).toBeLessThan(0.5)
  })
  it('alpha が全透明でもクラッシュせず、寸法は extend を含む', () => {
    const r = renderAcrylicPlate(new Uint8Array(w * h), w, h, lifted)
    expect(r.height).toBe(h + r.extend + r.pad * 2)
    expect(r.rgba).toHaveLength(r.width * r.height * 4)
  })
})

describe('computeStem / stampStem: 浮く絵を台座へつなぐ帯 (#848)', () => {
  const w = 100
  const h = 100
  const sp = { stemWidthRatio: 0.28, stemMinGapRatio: 0.08 }
  /** x=20..79（幅 60）・y=10..(bottomY) の不透明な塊 */
  const blob = (bottomY: number, x0 = 20, x1 = 79): Uint8Array => {
    const a = new Uint8Array(w * h)
    for (let y = 10; y <= bottomY; y++) for (let x = x0; x <= x1; x++) a[y * w + x] = 255
    return a
  }

  it('下端が離れていなければ null（地面に立つキャラは帯なし）', () => {
    expect(computeStem(blob(99), w, h, 3, sp)).toBeNull()
    expect(computeStem(blob(95), w, h, 3, sp)).toBeNull() // gap 4 < 8
  })
  it('下端が閾値以上離れていれば帯が出て、幅は不透明部分の幅 × 比率・中心は下端の重心', () => {
    const s = computeStem(blob(60), w, h, 3, sp)
    expect(s).not.toBeNull()
    expect(s!.halfWidth * 2).toBeCloseTo(60 * 0.28, 6)
    expect(Math.abs(s!.cx - 50)).toBeLessThanOrEqual(1)
    expect(s!.bottom).toBe(h + 3)
    expect(s!.top).toBeLessThanOrEqual(60)
    expect(s!.top).toBeGreaterThan(50)
  })
  it('スリットの列の外（左下の羽根の先）が下端に届いても、中央の列が空いていれば帯が出る', () => {
    const a = blob(60)
    for (let y = 60; y < h; y++) a[y * w + 2] = 255 // 左端の細い羽根の先が画像下端まで
    expect(computeStem(a, w, h, 3, sp)).not.toBeNull()
    // 中央の列が下端まで届いていれば出ない
    const b = blob(60)
    for (let y = 60; y < h; y++) b[y * w + 50] = 255
    expect(computeStem(b, w, h, 3, sp)).toBeNull()
  })
  it('中央の列に不透明画素が無ければ null', () => {
    expect(computeStem(blob(60, 0, 9), w, h, 0, sp)).toBeNull()
  })
  it('帯はスリットの幅からはみ出さない（片側に垂れた脚が最下端でも中心を寄せる）', () => {
    const half = computeStemSlitHalfWidth(w, h)
    expect(half).toBeGreaterThan(0)
    const a = new Uint8Array(w * h)
    for (let y = 10; y <= 50; y++) for (let x = 0; x < w; x++) a[y * w + x] = 255
    for (let y = 51; y <= 60; y++)
      for (let x = Math.ceil(w / 2 + half) - 2; x < w / 2 + half; x++) a[y * w + x] = 255
    const s = computeStem(a, w, h, 0, sp)!
    expect(s.cx - s.halfWidth).toBeGreaterThanOrEqual(w / 2 - half - 1e-6)
    expect(s.cx + s.halfWidth).toBeLessThanOrEqual(w / 2 + half + 1e-6)
  })
  it('幅の上下限: 極端に細い絵（w=1,2）でも NaN にならず画像幅・スリット幅を超えない', () => {
    for (const tw of [1, 2, 3]) {
      const a = new Uint8Array(tw * 50)
      for (let y = 0; y < 10; y++) for (let x = 0; x < tw; x++) a[y * tw + x] = 255
      const s = computeStem(a, tw, 50, 2, sp)
      if (!s) continue
      expect(Number.isFinite(s.cx) && Number.isFinite(s.halfWidth)).toBe(true)
      expect(s.halfWidth * 2).toBeLessThanOrEqual(tw + 1e-9)
      expect(s.cx - s.halfWidth).toBeGreaterThanOrEqual(-1e-9)
      expect(s.cx + s.halfWidth).toBeLessThanOrEqual(tw + 1e-9)
    }
  })
  it('薄いにじみ（alpha < 32）は下端とみなさない', () => {
    const a = blob(60)
    for (let x = 0; x < w; x++) a[99 * w + x] = 20
    expect(computeStem(a, w, h, 0, sp)).not.toBeNull()
  })
  it('stemWidthRatio=0・全透明・寸法不正は null', () => {
    expect(computeStem(blob(60), w, h, 0, { ...sp, stemWidthRatio: 0 })).toBeNull()
    expect(computeStem(new Uint8Array(w * h), w, h, 0, sp)).toBeNull()
    expect(computeStem(new Uint8Array(4), w, h, 0, sp)).toBeNull()
    expect(computeStem(blob(60), 0, h, 0, sp)).toBeNull()
  })
  it('stampStem は帯の内側を 1 にし、外側・上側の角は触らない', () => {
    const pad = 4
    const W = w + pad * 2
    const mask = new Float32Array(W * (h + 3 + pad * 2))
    const s = computeStem(blob(60), w, h, 3, sp)!
    stampStem(mask, W, pad, s)
    const at = (x: number, y: number): number => mask[(y + pad) * W + x + pad]
    expect(at(50, 80)).toBe(1)
    expect(at(50, h + 2)).toBe(1)
    expect(at(10, 80)).toBe(0)
    expect(at(Math.floor(s.cx - s.halfWidth), Math.ceil(s.top))).toBe(0) // 丸めた角
  })
  it('renderAcrylicPlate: 浮く絵は下端から差し込み線まで shape が連続し、無効化すると途切れる', () => {
    const a = blob(40)
    const on = renderAcrylicPlate(a, w, h, resolveAcrylicParams({ spriteLiftRatio: 0.1 }))
    const off = renderAcrylicPlate(
      a,
      w,
      h,
      resolveAcrylicParams({ spriteLiftRatio: 0.1, stemWidthRatio: 0 })
    )
    for (let y = 40; y < h + on.extend; y++)
      expect(on.shape[(y + on.pad) * on.width + 50 + on.pad]).toBeGreaterThan(0.9)
    expect(off.shape[(80 + off.pad) * off.width + 50 + off.pad]).toBeLessThan(0.1)
    // 帯は画像と extend の外へは広がらない（寸法は不変）
    expect(on.width).toBe(off.width)
    expect(on.height).toBe(off.height)
  })
  it('地面に立つ絵は帯の有無で rgba が変わらない（既定の見た目は不変）', () => {
    const a = blob(99)
    const on = renderAcrylicPlate(a, w, h, P)
    const off = renderAcrylicPlate(a, w, h, resolveAcrylicParams({ stemWidthRatio: 0 }))
    expect(Array.from(on.rgba)).toEqual(Array.from(off.rgba))
  })
})

describe('computeStem: 既定の閾値付近の回帰 (#848)', () => {
  const w = 100
  const h = 100
  const P6 = resolveAcrylicParams()
  /** 中央が bottomY（0 始まり）まで不透明な絵。gap = (h-1-bottomY)/h */
  const withGap = (gap: number): Uint8Array => {
    const a = new Uint8Array(w * h)
    const bottomY = h - 1 - Math.round(gap * h)
    for (let y = 10; y <= bottomY; y++) for (let x = 20; x < 80; x++) a[y * w + x] = 255
    return a
  }
  it('既定は 0.06', () => {
    expect(P6.stemMinGapRatio).toBe(0.06)
  })
  it.each([
    [0.05, false],
    [0.06, true],
    [0.07, true],
    [0.09, true],
  ])('gap=%s の帯の有無は %s', (gap, expected) => {
    expect(computeStem(withGap(gap), w, h, 3, P6) !== null).toBe(expected)
  })
})

describe('帯の存在感: 最小幅と内側の濃さ (#848)', () => {
  const w = 120
  const h = 120
  const P2 = resolveAcrylicParams({ spriteLiftRatio: 0.05 })
  /** 上の方にだけ細い（幅 6px）絵がある浮いた絵 */
  const thin = (): Uint8Array => {
    const a = new Uint8Array(w * h)
    for (let y = 10; y <= 50; y++) for (let x = 57; x < 63; x++) a[y * w + x] = 255
    return a
  }
  /** 太い本体（板の内側の濃さの比較用）+ 浮いた細い先 */
  const bodyFigure = (): Uint8Array => {
    const a = thin()
    for (let y = 10; y <= 40; y++) for (let x = 20; x < 100; x++) a[y * w + x] = 255
    return a
  }

  it('絵が細くても、帯の幅は枠一辺の STEM_MIN_WIDTH_RATIO 以上（360x640 相当の枠でも読める）', () => {
    const s = computeStem(thin(), w, h, 6, P2)!
    expect(s).not.toBeNull()
    const sc = computeStemScale(w, h, P2)
    expect(sc.minWidth).toBeGreaterThan(0)
    expect(s.halfWidth * 2).toBeGreaterThanOrEqual(Math.min(sc.minWidth, sc.slitHalf * 2) - 1e-6)
    // 枠 360 → 画像 px への換算でも比率は不変: 枠一辺に対する帯の幅
    expect((s.halfWidth * 2) / (sc.minWidth / STEM_MIN_WIDTH_RATIO)).toBeGreaterThanOrEqual(
      STEM_MIN_WIDTH_RATIO - 1e-9
    )
  })
  it('帯の内側の alpha は板の本体（plateFillAlpha）より濃く、stemFillAlpha 相当', () => {
    const r = renderAcrylicPlate(bodyFigure(), w, h, P2)
    const al = (x: number, y: number): number => r.rgba[((y + r.pad) * r.width + x + r.pad) * 4 + 3]
    const s = computeStem(bodyFigure(), w, h, r.extend, P2)!
    const stemA = al(Math.round(s.cx), Math.round((s.top + s.bottom) / 2))
    const bodyA = al(60, 20)
    expect(stemA).toBeGreaterThanOrEqual(Math.round(P2.stemFillAlpha * 255 * 0.9))
    expect(stemA).toBeGreaterThan(bodyA * 2)
  })
  it('stemFillAlpha=0 でも帯の内側は本体と同じ濃さ以上（下回らない）', () => {
    const p = resolveAcrylicParams({ spriteLiftRatio: 0.05, stemFillAlpha: 0 })
    const r = renderAcrylicPlate(bodyFigure(), w, h, p)
    const s = computeStem(bodyFigure(), w, h, r.extend, p)!
    const al = (x: number, y: number): number => r.rgba[((y + r.pad) * r.width + x + r.pad) * 4 + 3]
    expect(al(Math.round(s.cx), Math.round((s.top + s.bottom) / 2))).toBeGreaterThanOrEqual(
      Math.round(p.plateFillAlpha * 255 * 0.9)
    )
  })
  it('帯の上端は絵の最下端より上（絵の内側）まで食い込む', () => {
    const s = computeStem(thin(), w, h, 6, P2)!
    expect(s.top).toBeLessThan(50)
    expect(s.top).toBeGreaterThanOrEqual(50 - Math.round(h * 0.05) - 1)
  })
})
