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

describe('computeDofLevels: 追加の境界', () => {
  it.each([0, -3, 0.4, NaN, -Infinity])('levelCount=%s は n>=1 に丸められ有限値', (n) => {
    const lv = computeDofLevels(1000, DOF_DEFAULT_PARAMS, n)
    expect(lv.length).toBeGreaterThanOrEqual(1)
    for (const g of lv) {
      for (const v of [g.startY, g.maskHeight, g.rampFraction, g.blurStrength]) {
        expect(Number.isFinite(v)).toBe(true)
      }
    }
  })

  it('levelCount=1 は computeDofGradient と同値', () => {
    const [l] = computeDofLevels(1000, DOF_DEFAULT_PARAMS, 1)
    const g = computeDofGradient(1000)
    expect(l.startY).toBeCloseTo(g.startY)
    expect(l.rampFraction).toBeCloseTo(g.rampFraction)
    expect(l.blurStrength).toBeCloseTo(g.blurStrength)
  })

  it('全段の rampFraction は (0,1]、blurStrength は max*k/N', () => {
    const lv = computeDofLevels(800)
    const n = lv.length
    lv.forEach((g, i) => {
      expect(g.rampFraction).toBeGreaterThan(0)
      expect(g.rampFraction).toBeLessThanOrEqual(1)
      expect(g.blurStrength).toBeCloseTo((DOF_DEFAULT_PARAMS.maxBlurStrength * (i + 1)) / n)
    })
  })

  it('gradientRatio=0 でもゼロ除算せず、全段が同じ startY で rampFraction は最小値に張り付く', () => {
    const lv = computeDofLevels(800, { ...DOF_DEFAULT_PARAMS, gradientRatio: 0 })
    for (const g of lv) {
      expect(Number.isFinite(g.rampFraction)).toBe(true)
      expect(g.rampFraction).toBeGreaterThan(0)
      expect(g.startY).toBeCloseTo(lv[0].startY)
      expect(g.rampFraction).toBeCloseTo(lv[0].rampFraction)
    }
    expect(lv[0].rampFraction).toBeLessThan(0.01)
  })
})

describe('dofAlphaAt / dofMaskStops: 追加の境界', () => {
  it('dofAlphaAt は t について単調非減少で 0〜1', () => {
    let prev = -1
    for (let i = 0; i <= 20; i++) {
      const a = dofAlphaAt(i / 20, 0.5)
      expect(a).toBeGreaterThanOrEqual(prev)
      expect(a).toBeGreaterThanOrEqual(0)
      expect(a).toBeLessThanOrEqual(1)
      prev = a
    }
  })

  it('dofAlphaAt: t<0 は 0、t>1 は 1、不正な rampFraction でも 0〜1 の有限値', () => {
    expect(dofAlphaAt(-1, 0.5)).toBe(0)
    expect(dofAlphaAt(2, 0.5)).toBe(1)
    for (const r of [0, -1, NaN, 5]) {
      for (const t of [-1, 0, 0.5, 1, 2]) {
        const a = dofAlphaAt(t, r)
        expect(Number.isFinite(a)).toBe(true)
        expect(a).toBeGreaterThanOrEqual(0)
        expect(a).toBeLessThanOrEqual(1)
      }
    }
  })

  it.each([0.3, 1, 0, -1, NaN, 5])(
    'dofMaskStops(%s): offset 昇順・[0,1] 内・alpha 0〜1・先頭 alpha=0・末尾 alpha=1',
    (r) => {
      const stops = dofMaskStops(r)
      expect(stops[0].alpha).toBe(0)
      expect(stops[stops.length - 1].alpha).toBe(1)
      stops.forEach((s, i) => {
        expect(s.offset).toBeGreaterThanOrEqual(0)
        expect(s.offset).toBeLessThanOrEqual(1)
        expect(s.alpha).toBeGreaterThanOrEqual(0)
        expect(s.alpha).toBeLessThanOrEqual(1)
        if (i > 0) expect(s.offset).toBeGreaterThanOrEqual(stops[i - 1].offset)
      })
    }
  )
})

describe('normalizeBackgroundDof: 追加', () => {
  it('非 string は例外なく off、前後の改行は trim', () => {
    for (const v of [0, 1, true, {}, []]) {
      expect(normalizeBackgroundDof(v as unknown as string)).toBe('off')
    }
    expect(normalizeBackgroundDof('On\n')).toBe('on')
  })
})
