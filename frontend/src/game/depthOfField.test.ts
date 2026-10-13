import { describe, expect, it } from 'vitest'
import {
  DOF_DEFAULT_PARAMS,
  DOF_EDGE_EXTEND,
  computeDofQuad,
  DOF_LEVEL_COUNT,
  computeDofGradient,
  computeDofLevels,
  dofAlphaAt,
  dofMaskStops,
  normalizeBackgroundDof,
} from './depthOfField'

describe('normalizeBackgroundDof', () => {
  it('on だけ on。未指定・空・未知値は off', () => {
    expect(normalizeBackgroundDof('on')).toBe('on')
    expect(normalizeBackgroundDof(' ON ')).toBe('on')
    expect(normalizeBackgroundDof('off')).toBe('off')
    expect(normalizeBackgroundDof('foo')).toBe('off')
    expect(normalizeBackgroundDof('')).toBe('off')
    expect(normalizeBackgroundDof(null)).toBe('off')
    expect(normalizeBackgroundDof(undefined)).toBe('off')
  })
})

describe('computeDofGradient', () => {
  it('既定: 定数どおりに配置される（目視調整値なのでリテラルでなく定数参照）', () => {
    const g = computeDofGradient(1000)
    const { startRatio, gradientRatio } = DOF_DEFAULT_PARAMS
    expect(g.startY).toBeCloseTo(1000 * startRatio)
    expect(g.maskHeight).toBeCloseTo(1000 * (1 - startRatio))
    expect(g.rampFraction).toBeCloseTo(Math.min(1, gradientRatio / (1 - startRatio)))
    expect(g.blurStrength).toBe(DOF_DEFAULT_PARAMS.maxBlurStrength)
  })
  it('幅が下端を越えるときは下端で切り詰める（割合 1）', () => {
    const g = computeDofGradient(1000, { startRatio: 0.8, gradientRatio: 0.9, maxBlurStrength: 3 })
    expect(g.rampFraction).toBe(1)
    expect(g.blurStrength).toBe(3)
  })
  it('異常値でも落ちない（幅 0・開始が下端・NaN・負の高さ）', () => {
    const a = computeDofGradient(500, { startRatio: 0.5, gradientRatio: 0, maxBlurStrength: 6 })
    expect(a.rampFraction).toBeGreaterThan(0)
    const b = computeDofGradient(500, { startRatio: 1, gradientRatio: 0.4, maxBlurStrength: NaN })
    expect(b.maskHeight).toBe(0)
    expect(b.rampFraction).toBe(1)
    expect(b.blurStrength).toBe(0)
    expect(computeDofGradient(-10).maskHeight).toBe(0)
    expect(
      computeDofGradient(100, { startRatio: -1, gradientRatio: 2, maxBlurStrength: -5 })
    ).toMatchObject({
      startY: 0,
      maskHeight: 100,
      rampFraction: 1,
      blurStrength: 0,
    })
  })
})

describe('既定定数の仕様 (#753)', () => {
  it('ぼけ始めは画面高さの 50%、勾配は下端でちょうど最大（割合 1）', () => {
    expect(DOF_DEFAULT_PARAMS.startRatio).toBe(0.5)
    const g = computeDofGradient(1000)
    expect(g.startY).toBeCloseTo(500)
    expect(g.rampFraction).toBeCloseTo(1)
  })
})

describe('dofAlphaAt / dofMaskStops', () => {
  it('上端 0 → ramp で 1 → 以降 1', () => {
    expect(dofAlphaAt(0, 0.5)).toBe(0)
    expect(dofAlphaAt(0.25, 0.5)).toBeCloseTo(0.5)
    expect(dofAlphaAt(0.5, 0.5)).toBe(1)
    expect(dofAlphaAt(1, 0.5)).toBe(1)
    expect(dofAlphaAt(NaN, 0.5)).toBe(0)
  })
  it('色止めは alphaAt と一致する端点を持つ', () => {
    expect(dofMaskStops(1)).toEqual([
      { offset: 0, alpha: 0 },
      { offset: 1, alpha: 1 },
    ])
    expect(dofMaskStops(0.5)).toEqual([
      { offset: 0, alpha: 0 },
      { offset: 0.5, alpha: 1 },
      { offset: 1, alpha: 1 },
    ])
  })
})

describe('computeDofLevels (#753)', () => {
  it('段数ぶん・強さは弱→強で最後が最大・マスクの 0→1 区間が隣接して下端まで続く', () => {
    const lv = computeDofLevels(1000)
    const { startRatio, gradientRatio, maxBlurStrength } = DOF_DEFAULT_PARAMS
    expect(lv).toHaveLength(DOF_LEVEL_COUNT)
    expect(lv[0].startY).toBeCloseTo(1000 * startRatio)
    expect(lv[lv.length - 1].blurStrength).toBeCloseTo(maxBlurStrength)
    for (let k = 1; k < lv.length; k++) {
      expect(lv[k].blurStrength).toBeGreaterThan(lv[k - 1].blurStrength)
      // 段 k-1 が 1 になる位置 = 段 k が立ち上がり始める位置
      const prevFull = lv[k - 1].startY + lv[k - 1].maskHeight * lv[k - 1].rampFraction
      expect(lv[k].startY).toBeCloseTo(prevFull)
    }
    const last = lv[lv.length - 1]
    expect(last.startY + last.maskHeight * last.rampFraction).toBeCloseTo(
      1000 * (startRatio + gradientRatio)
    )
  })
  it('異常値でも NaN にならない', () => {
    for (const l of computeDofLevels(
      0,
      { startRatio: 1, gradientRatio: 0, maxBlurStrength: NaN },
      0
    )) {
      expect(Number.isFinite(l.startY + l.maskHeight + l.rampFraction + l.blurStrength)).toBe(true)
    }
  })
  it('最大ぼかしは下端で明らかに見える強さ', () => {
    expect(DOF_DEFAULT_PARAMS.maxBlurStrength).toBeGreaterThanOrEqual(8)
  })
})

describe('computeDofQuad / DOF_EDGE_EXTEND (画面端のぼけ欠け対策)', () => {
  it('広げる量は最大ぼかしの padding（strength * 2）以上', () => {
    expect(DOF_EDGE_EXTEND).toBeGreaterThanOrEqual(DOF_DEFAULT_PARAMS.maxBlurStrength * 2)
  })

  it('幅は背景幅 + 2 * extend、高さは背景高 + 2 * extend。原点は -extend', () => {
    const q = computeDofQuad(800, 450, 24)
    const xs = [0, 2, 4, 6].map((i) => q.positions[i])
    const ys = [1, 3, 5, 7].map((i) => q.positions[i])
    expect(Math.max(...xs) - Math.min(...xs)).toBe(800 + 2 * 24)
    expect(Math.max(...ys) - Math.min(...ys)).toBe(450 + 2 * 24)
    expect(Math.min(...xs)).toBe(-24)
    expect(Math.min(...ys)).toBe(-24)
  })

  it('UV は 0〜1 の外側へ extend / サイズ だけはみ出す（端ピクセルの繰り返し）', () => {
    const q = computeDofQuad(100, 50, 10)
    expect(q.uvs[0]).toBeCloseTo(-10 / 100)
    expect(q.uvs[1]).toBeCloseTo(-10 / 50)
    expect(q.uvs[4]).toBeCloseTo(1 + 10 / 100)
    expect(q.uvs[5]).toBeCloseTo(1 + 10 / 50)
    expect(Array.from(q.indices)).toEqual([0, 1, 2, 0, 2, 3])
  })

  it('サイズ 0 でも NaN にならない', () => {
    const q = computeDofQuad(0, 0, 10)
    expect([...q.positions, ...q.uvs].every(Number.isFinite)).toBe(true)
  })
})
