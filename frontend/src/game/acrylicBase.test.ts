import { describe, expect, it } from 'vitest'
import { BASE_TEXTURE_WIDTH, computeBaseLayout, renderAcrylicBase } from './acrylicBase'
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
