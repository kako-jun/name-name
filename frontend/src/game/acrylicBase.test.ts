import { describe, expect, it } from 'vitest'
import {
  BASE_TEXTURE_WIDTH,
  SLIT_CENTER_RATIO,
  computeBaseLayout,
  computeSlitY,
  renderAcrylicBase,
} from './acrylicBase'
import { resolveAcrylicParams } from './spriteStyle'

const P = resolveAcrylicParams()

describe('computeBaseLayout', () => {
  it('影の半幅 = テクスチャ半幅 − 余白、上面の半径 = 影 / shadowScale、ry = rx × 高さ比', () => {
    const L = computeBaseLayout(512, P)
    expect(L.shadowRx).toBe(254)
    expect(L.rx).toBeCloseTo(254 / 1.2)
    expect(L.ry).toBeCloseTo((254 / 1.2) * 0.28)
    expect(L.thickness).toBeCloseTo(L.ry * 0.18)
    expect(L.cx).toBe(256)
  })
  it('影・側面の厚みを含めてテクスチャ高さに収まる', () => {
    for (const thick of [0, 0.1, 0.2]) {
      for (const sc of [1, 1.2, 2]) {
        const L = computeBaseLayout(512, { ...P, baseThicknessRatio: thick, shadowScale: sc })
        const sry = L.ry * sc
        expect(L.cyTop + L.thickness + sry).toBeLessThanOrEqual(L.height)
        expect(L.cyTop - Math.max(sry, L.ry)).toBeGreaterThanOrEqual(0)
      }
    }
  })
})

describe('renderAcrylicBase', () => {
  const r = renderAcrylicBase(BASE_TEXTURE_WIDTH, P)
  const px = (x: number, y: number): number[] => {
    const i = (Math.floor(y) * r.width + Math.floor(x)) * 4
    return [r.rgba[i], r.rgba[i + 1], r.rgba[i + 2], r.rgba[i + 3]]
  }
  it('寸法とバッファ長が一致し、四隅は透明', () => {
    expect(r.rgba).toHaveLength(r.width * r.height * 4)
    expect(px(0, 0)[3]).toBe(0)
    expect(px(r.width - 1, r.height - 1)[3]).toBe(0)
  })
  // 面・帯の濃さは、下に敷く影を除いて比べる
  const noShadow = renderAcrylicBase(BASE_TEXTURE_WIDTH, { ...P, shadowAlpha: 0 })
  const pxN = (x: number, y: number): number =>
    noShadow.rgba[(Math.floor(y) * noShadow.width + Math.floor(x)) * 4 + 3]
  it('上面はごく薄い透明（背景がうっすら透ける）', () => {
    const a = pxN(r.cx, r.cyTop + r.ry * 0.5) / 255
    expect(a).toBeGreaterThan(0.05)
    expect(a).toBeLessThan(0.4)
  })
  it('側面の帯は上面より濃い透明', () => {
    const top = pxN(r.cx, r.cyTop + r.ry * 0.5)
    const side = pxN(r.cx, r.cyTop + r.ry + r.thickness * 0.5)
    expect(side).toBeGreaterThan(top)
  })
  it('左上の縁のハイライトは右下の縁より強い', () => {
    const t = Math.PI / 4
    const at = (sx: number, sy: number): number => {
      let m = 0
      for (let k = 0.9; k <= 1.0; k += 0.01)
        m = Math.max(
          m,
          px(r.cx + sx * r.rx * Math.cos(t) * k, r.cyTop + sy * r.ry * Math.sin(t) * k)[3]
        )
      return m
    }
    expect(at(-1, -1)).toBeGreaterThan(at(1, 1))
  })
  it('接地の影は中心で濃く縁で薄い（柔らかい）', () => {
    const y = r.cyTop + r.thickness
    const left = px(r.cx - r.shadowRx + 3, y)[3]
    const near = px(r.cx - r.rx * 1.1, y)[3]
    expect(near).toBeGreaterThanOrEqual(left)
  })
  it('差し込み口（スリット）は上面の奥側にあり、周囲より暗い', () => {
    const slit = px(r.cx, r.cyTop - r.ry * 0.28)
    const around = px(r.cx, r.cyTop + r.ry * 0.3)
    expect(slit[0]).toBeLessThan(around[0])
  })
  it('slitAlpha=0・baseFillAlpha=0・側面 0 でも例外なく有限', () => {
    const z = renderAcrylicBase(256, {
      ...P,
      slitAlpha: 0,
      baseFillAlpha: 0,
      baseSideAlpha: 0,
      baseThicknessRatio: 0,
    })
    expect(z.rgba.length).toBe(z.width * z.height * 4)
  })
})

describe('computeSlitY (#760)', () => {
  it('スリットの中心は上面の中心から奥側へ ry の 0.28 倍（仕様値）', () => {
    expect(SLIT_CENTER_RATIO).toBe(0.28)
    expect(computeSlitY(100, 50)).toBeCloseTo(86)
  })
  it('台座テクスチャの最も暗い行（スリット）が computeSlitY と一致する（描画と板のクリップ位置がずれない）', () => {
    const r = renderAcrylicBase(BASE_TEXTURE_WIDTH, { ...P, shadowAlpha: 0 })
    // スリットの帯（暗く不透明な行）の重心 y
    let sum = 0
    let wsum = 0
    for (let y = 0; y < r.height; y++) {
      const i = (y * r.width + Math.floor(r.cx)) * 4
      const w = Math.max(0, r.rgba[i + 3] * (255 - r.rgba[i]) - 8000)
      sum += w * (y + 0.5)
      wsum += w
    }
    const best = sum / wsum - 0.5
    expect(Math.abs(best + 0.5 - computeSlitY(r.cyTop, r.ry))).toBeLessThanOrEqual(2)
  })
})

// ---------------------------------------------------------------------------
// #760 追加観点（旧フィルタの「色・不透明度の反映」「幅が解像度に依らない」を台座ラスタで守る）
// ---------------------------------------------------------------------------
describe('renderAcrylicBase: パラメータの反映 (#760)', () => {
  const noShadow = { ...P, shadowAlpha: 0 }
  const at = (r: ReturnType<typeof renderAcrylicBase>, x: number, y: number): number[] => {
    const i = (Math.floor(y) * r.width + Math.floor(x)) * 4
    return [r.rgba[i], r.rgba[i + 1], r.rgba[i + 2], r.rgba[i + 3]]
  }
  const total = (r: ReturnType<typeof renderAcrylicBase>): number => {
    let t = 0
    for (let i = 3; i < r.rgba.length; i += 4) t += r.rgba[i]
    return t
  }

  it('lineColor が縁の色に反映される（上面の左上の縁: 赤は R 優位・青は B 優位）', () => {
    const find = (color: number): number[] => {
      const r = renderAcrylicBase(BASE_TEXTURE_WIDTH, { ...noShadow, lineColor: color })
      const t = Math.PI / 4
      let best = [0, 0, 0, 0]
      for (let k = 0.93; k <= 0.99; k += 0.01) {
        const p = at(r, r.cx - r.rx * Math.cos(t) * k, r.cyTop - r.ry * Math.sin(t) * k)
        if (p[3] > best[3]) best = p
      }
      return best
    }
    const red = find(0xff0000)
    const blue = find(0x0000ff)
    expect(red[0]).toBeGreaterThan(red[2] + 40)
    expect(blue[2]).toBeGreaterThan(blue[0] + 40)
  })

  it('lineAlpha=0 で縁のハイライトが消える（台座全体の不透明度の合計が減り、左上の縁が弱まる）', () => {
    const on = renderAcrylicBase(BASE_TEXTURE_WIDTH, noShadow)
    const off = renderAcrylicBase(BASE_TEXTURE_WIDTH, { ...noShadow, lineAlpha: 0 })
    expect(total(off)).toBeLessThan(total(on))
    const t = Math.PI / 4
    const edge = (r: ReturnType<typeof renderAcrylicBase>): number =>
      Math.max(
        ...[0.93, 0.95, 0.97, 0.99].map(
          (k) => at(r, r.cx - r.rx * Math.cos(t) * k, r.cyTop - r.ry * Math.sin(t) * k)[3]
        )
      )
    expect(edge(off)).toBeLessThan(edge(on))
  })

  it('shadowAlpha=0 で接地の影が消え、上げると影の不透明度が上がる', () => {
    const r0 = renderAcrylicBase(BASE_TEXTURE_WIDTH, { ...P, shadowAlpha: 0 })
    const r4 = renderAcrylicBase(BASE_TEXTURE_WIDTH, { ...P, shadowAlpha: 0.4 })
    const r8 = renderAcrylicBase(BASE_TEXTURE_WIDTH, { ...P, shadowAlpha: 0.8 })
    // 台座の左側面の外にはみ出す影（上面・側面の外）
    const x = r0.cx - r0.rx * 1.08
    const y = r0.cyTop + r0.thickness
    expect(at(r0, x, y)[3]).toBe(0)
    expect(at(r4, x, y)[3]).toBeGreaterThan(0)
    expect(at(r8, x, y)[3]).toBeGreaterThan(at(r4, x, y)[3])
  })

  it('baseFillAlpha / baseSideAlpha は面・帯の濃さにそのまま効く（0 で上面の面が消える）', () => {
    const r = renderAcrylicBase(BASE_TEXTURE_WIDTH, noShadow)
    const flat = renderAcrylicBase(BASE_TEXTURE_WIDTH, {
      ...noShadow,
      baseFillAlpha: 0,
      slitAlpha: 0,
    })
    const thick = renderAcrylicBase(BASE_TEXTURE_WIDTH, { ...noShadow, baseFillAlpha: 0.6 })
    const y = r.cyTop + r.ry * 0.5
    expect(at(flat, r.cx, y)[3]).toBe(0)
    expect(at(thick, r.cx, y)[3]).toBeGreaterThan(at(r, r.cx, y)[3])
    const sideY = r.cyTop + r.ry + r.thickness * 0.5
    const sideThick = renderAcrylicBase(BASE_TEXTURE_WIDTH, { ...noShadow, baseSideAlpha: 0.7 })
    expect(at(sideThick, r.cx, sideY)[3]).toBeGreaterThan(at(r, r.cx, sideY)[3])
  })

  it('baseThicknessRatio=0 は側面の帯がなく、テクスチャも低い（厚みぶん高さが増える）', () => {
    const flat = computeBaseLayout(512, { ...P, baseThicknessRatio: 0 })
    const thick = computeBaseLayout(512, P)
    expect(flat.thickness).toBe(0)
    expect(thick.height).toBeGreaterThanOrEqual(flat.height)
    const r = renderAcrylicBase(BASE_TEXTURE_WIDTH, { ...noShadow, baseThicknessRatio: 0 })
    // 上面の真下（旧: 側面の帯）は透明
    expect(at(r, r.cx, r.cyTop + r.ry * 1.15)[3]).toBe(0)
  })

  it('スリットの暗さ slitAlpha を 0 にすると、スリット位置が周囲より暗くなくなる', () => {
    const on = renderAcrylicBase(BASE_TEXTURE_WIDTH, noShadow)
    const off = renderAcrylicBase(BASE_TEXTURE_WIDTH, { ...noShadow, slitAlpha: 0 })
    const y = computeSlitY(on.cyTop, on.ry)
    expect(at(on, on.cx, y)[3]).toBeGreaterThan(at(off, off.cx, y)[3])
  })

  it('テクスチャ幅が小さくても（8・2・1）NaN にならず、寸法とバッファ長が一致する', () => {
    for (const w of [1, 2, 8, 64]) {
      const r = renderAcrylicBase(w, P)
      expect(r.width).toBe(w)
      expect(r.height).toBeGreaterThan(0)
      expect(r.rgba).toHaveLength(r.width * r.height * 4)
      expect(Number.isFinite(r.cx + r.cyTop + r.rx + r.ry)).toBe(true)
    }
  })

  it('解像度（テクスチャ幅）を変えても形は相似: 幅 2 倍で全寸法が約 2 倍（縮小して使っても比率が崩れない）', () => {
    const a = computeBaseLayout(256, P)
    const b = computeBaseLayout(512, P)
    expect(b.rx / a.rx).toBeCloseTo(2, 1)
    expect(b.ry / a.ry).toBeCloseTo(2, 1)
    expect(b.thickness / a.thickness).toBeCloseTo(2, 1)
  })

  it('同じ入力なら同じラスタ（純粋・決定的）', () => {
    const a = renderAcrylicBase(128, P)
    const b = renderAcrylicBase(128, P)
    expect(Array.from(a.rgba)).toEqual(Array.from(b.rgba))
  })

  it('computeSlitY: ry=0 なら上面の中心そのもの・ry が大きいほど奥（y が小さい）', () => {
    expect(computeSlitY(100, 0)).toBe(100)
    expect(computeSlitY(100, 40)).toBeLessThan(computeSlitY(100, 20))
    expect(computeSlitY(100, 50)).toBeCloseTo(86, 9)
  })
})
