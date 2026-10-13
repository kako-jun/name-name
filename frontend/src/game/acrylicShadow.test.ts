import { describe, expect, it } from 'vitest'
import { computeShadowTransform, renderGroundShadow } from './acrylicShadow'
import { resolveAcrylicParams } from './spriteStyle'

const P = resolveAcrylicParams()

describe('computeShadowTransform', () => {
  it('既定: 縦に 0.35 倍つぶし、右へ 1.4 傾ける（skewX は負）', () => {
    const t = computeShadowTransform(P, 1)
    expect(t.scaleX).toBe(1)
    expect(t.skewX).toBeCloseTo(-Math.atan(1.4), 9)
    // 描画上の縦の縮み = cos(skew) × scaleY = ks × castSquash
    expect(Math.cos(t.skewX) * t.scaleY).toBeCloseTo(0.35, 9)
  })
  it('上（y が負）の点は右へ、つぶした高さ 1px あたり castShear px ずれる', () => {
    const t = computeShadowTransform({ castSquash: 0.4, castShear: 1 }, 2)
    const y = -100 // 足元（pivot）から 100px 上
    const dx = Math.sin(t.skewX) * t.scaleY * y
    const dy = Math.cos(t.skewX) * t.scaleY * y
    expect(dy).toBeCloseTo(-100 * 2 * 0.4, 9)
    expect(dx / -dy).toBeCloseTo(1, 9)
    expect(dx).toBeGreaterThan(0)
  })
  it('castShear=0 は skew なし・負は左へ倒れる', () => {
    expect(computeShadowTransform({ castSquash: 0.5, castShear: 0 }, 1).skewX).toBeCloseTo(0)
    expect(computeShadowTransform({ castSquash: 0.5, castShear: -1 }, 1).skewX).toBeGreaterThan(0)
  })
})

describe('renderGroundShadow', () => {
  const w = 40
  const h = 40
  const shape = new Float32Array(w * h)
  for (let y = 10; y < 30; y++) for (let x = 10; x < 30; x++) shape[y * w + x] = 1
  const r = renderGroundShadow(shape, w, h, 400, P)
  const a = (x: number, y: number): number => r.rgba[(y * w + x) * 4 + 3]
  it('黒（rgb 0）で alpha だけが入り、最大でも castAlpha × 255 以下', () => {
    for (let i = 0; i < w * h; i++) {
      expect(r.rgba[i * 4]).toBe(0)
      expect(r.rgba[i * 4 + 1]).toBe(0)
      expect(r.rgba[i * 4 + 2]).toBe(0)
      expect(r.rgba[i * 4 + 3]).toBeLessThanOrEqual(Math.round(0.55 * 255))
    }
  })
  it('形の内側は濃く、外は薄い。縁はぼけている（ぼかしで外へにじむ）', () => {
    expect(a(20, 20)).toBeGreaterThan(a(2, 2))
    expect(a(9, 20)).toBeGreaterThan(0)
    expect(a(9, 20)).toBeLessThan(a(20, 20))
  })
  it('castAlpha=0 は全面透明・寸法は入力と同じ', () => {
    const z = renderGroundShadow(shape, w, h, 40, { ...P, castAlpha: 0 })
    expect(z.rgba.every((v) => v === 0)).toBe(true)
    expect([z.width, z.height]).toEqual([w, h])
  })
})
