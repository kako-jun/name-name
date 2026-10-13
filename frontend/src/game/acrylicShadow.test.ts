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

// ---------------------------------------------------------------------------
// #760 追加観点。過去事故「影が薄すぎて見えなかった」を既定値のリテラルで固定する。
// ---------------------------------------------------------------------------
describe('地面の影: 既定の濃さ・変形の仕様値 (#760)', () => {
  const w = 40
  const h = 40
  const shape = new Float32Array(w * h)
  for (let y = 10; y < 30; y++) for (let x = 10; x < 30; x++) shape[y * w + x] = 1
  // 80x80 の大きな形（中心はぼかしても 1 のまま）。中心 (60,60)
  const bw = 120
  const big = new Float32Array(bw * bw)
  for (let y = 20; y < 100; y++) for (let x = 20; x < 100; x++) big[y * bw + x] = 1
  const alphaAt = (r: { rgba: Uint8ClampedArray }, x: number, y: number, ww = w): number =>
    r.rgba[(y * ww + x) * 4 + 3]
  const bigAt = (r: { rgba: Uint8ClampedArray }, x: number, y: number): number =>
    alphaAt(r, x, y, bw)

  it('既定: 形の内側の影は alpha 140（= round(0.55 × 255)）。薄すぎて見えない事故を防ぐ下限', () => {
    const r = renderGroundShadow(big, bw, bw, 400, P)
    expect(bigAt(r, 60, 60)).toBe(140)
  })

  it('既定の変形（リテラル）: ks=1 で scaleX 1・scaleY ≈ 0.6022・skewX ≈ -0.9505', () => {
    const t = computeShadowTransform(P, 1)
    expect(t.scaleX).toBe(1)
    expect(t.scaleY).toBeCloseTo(0.35 * Math.sqrt(1 + 1.4 * 1.4), 6)
    expect(t.scaleY).toBeCloseTo(0.6022, 3)
    expect(t.skewX).toBeCloseTo(-0.9505, 3)
  })

  it('castAlpha を上げると影が濃くなり、1 を超える値・負の値は 0〜255 に収まる', () => {
    const a = (v: number): number =>
      bigAt(renderGroundShadow(big, bw, bw, 400, { ...P, castAlpha: v }), 60, 60)
    expect(a(0.3)).toBe(77)
    expect(a(1)).toBe(255)
    expect(a(5)).toBe(255)
    expect(a(-1)).toBe(0)
    expect(a(0.3)).toBeLessThan(a(0.55))
  })

  it('castBlurRatio=0 はぼかしなし（形の境界が段差のまま）、上げると外へにじむ', () => {
    const crisp = renderGroundShadow(shape, w, h, 400, { ...P, castBlurRatio: 0 })
    expect(alphaAt(crisp, 20, 20)).toBe(140)
    expect(alphaAt(crisp, 9, 20)).toBe(0)
    expect(alphaAt(crisp, 10, 20)).toBe(140)
    const soft = renderGroundShadow(shape, w, h, 400, { ...P, castBlurRatio: 0.05 })
    expect(alphaAt(soft, 9, 20)).toBeGreaterThan(0)
  })

  it('ぼかし半径は元画像の長辺に比例（長辺が 2 倍なら同じ ratio でにじみが広がる）', () => {
    const near = renderGroundShadow(shape, w, h, 100, P)
    const far = renderGroundShadow(shape, w, h, 1000, P)
    let sumNear = 0
    let sumFar = 0
    for (let i = 3; i < near.rgba.length; i += 4) {
      sumNear += near.rgba[i]
      sumFar += far.rgba[i]
    }
    // 総量はほぼ保存され、広くぼかすと中心が薄くなる
    expect(alphaAt(far, 20, 20)).toBeLessThanOrEqual(alphaAt(near, 20, 20))
    expect(sumFar).toBeGreaterThan(0)
    expect(sumNear).toBeGreaterThan(0)
  })

  it('srcMaxSide=0・形が空でも落ちない（全面透明）', () => {
    const empty = renderGroundShadow(new Float32Array(w * h), w, h, 0, P)
    expect(empty.rgba.every((v) => v === 0)).toBe(true)
  })

  it('ks=0 でも NaN にならず scale は 0（縮尺 0 のスプライト）', () => {
    const t = computeShadowTransform(P, 0)
    expect(t.scaleX).toBe(0)
    expect(t.scaleY).toBe(0)
    expect(Number.isFinite(t.skewX)).toBe(true)
  })

  it('castSquash が小さいほど縦に潰れる（scaleY は squash に比例）', () => {
    const a = computeShadowTransform({ castSquash: 0.2, castShear: 0 }, 1)
    const b = computeShadowTransform({ castSquash: 0.4, castShear: 0 }, 1)
    expect(b.scaleY / a.scaleY).toBeCloseTo(2, 9)
  })
})
