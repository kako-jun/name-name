/**
 * 天候の粒の純粋計算 (#706)。決定論性（同入力＝同出力・乱数の混入なし）、種類ごとの落下・揺れ・回転、
 * 回り込み、強さと粒数、入力契約。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WeatherKind } from '../types'
import {
  WEATHER_BASE_COUNT,
  WEATHER_INTENSITY_DEFAULT,
  WEATHER_INTENSITY_MAX,
  WEATHER_INTENSITY_MIN,
  WEATHER_MAX_PARTICLES,
  WEATHER_WRAP_MARGIN,
  clampWeatherIntensity,
  computeWeatherParticle,
  createWeatherParticleParams,
  evaluateWeatherParticle,
  weatherParticleCount,
} from './weatherParticles'

const W = 450
const H = 800
const KINDS: WeatherKind[] = ['Rain', 'Snow', 'Sakura']

afterEach(() => {
  vi.restoreAllMocks()
})

describe('clampWeatherIntensity', () => {
  it('範囲内はそのまま、範囲外は 0.1〜3.0 にクランプ', () => {
    expect(clampWeatherIntensity(1.5)).toBe(1.5)
    expect(clampWeatherIntensity(99)).toBe(WEATHER_INTENSITY_MAX)
    expect(clampWeatherIntensity(0.01)).toBe(WEATHER_INTENSITY_MIN)
  })
  it('非数値・非有限・0 以下は既定 1.0', () => {
    for (const v of [NaN, Infinity, -Infinity, 0, -1, '2', null, undefined]) {
      expect(clampWeatherIntensity(v)).toBe(WEATHER_INTENSITY_DEFAULT)
    }
  })
})

describe('weatherParticleCount', () => {
  it('強さ 1.0 で種類ごとの基準数（数十〜百弱）', () => {
    for (const k of KINDS) {
      const n = weatherParticleCount(k, 1)
      expect(n).toBe(WEATHER_BASE_COUNT[k])
      expect(n).toBeGreaterThanOrEqual(20)
      expect(n).toBeLessThanOrEqual(150)
    }
  })
  it('強さに比例して増減する', () => {
    for (const k of KINDS) {
      expect(weatherParticleCount(k, 2)).toBeGreaterThan(weatherParticleCount(k, 1))
      expect(weatherParticleCount(k, 0.5)).toBeLessThan(weatherParticleCount(k, 1))
    }
  })
  it('上限でクランプされ、強さ最小でも 1 粒以上', () => {
    for (const k of KINDS) {
      expect(weatherParticleCount(k, 1e9)).toBeLessThanOrEqual(WEATHER_MAX_PARTICLES)
      expect(weatherParticleCount(k, WEATHER_INTENSITY_MIN)).toBeGreaterThanOrEqual(1)
    }
    expect(weatherParticleCount('Rain', WEATHER_INTENSITY_MAX)).toBeLessThanOrEqual(
      WEATHER_MAX_PARTICLES
    )
  })
  it('不正な強さは既定扱い', () => {
    expect(weatherParticleCount('Snow', NaN)).toBe(WEATHER_BASE_COUNT.Snow)
  })
})

describe('createWeatherParticleParams（固定シード）', () => {
  it('同じ (kind, index) は何度作っても同じ', () => {
    for (const k of KINDS) {
      expect(createWeatherParticleParams(k, 7)).toEqual(createWeatherParticleParams(k, 7))
    }
  })
  it('Math.random を使わない（呼ばれたら失敗する）', () => {
    const spy = vi.spyOn(Math, 'random').mockImplementation(() => {
      throw new Error('Math.random は使わない')
    })
    for (const k of KINDS) {
      createWeatherParticleParams(k, 3)
      computeWeatherParticle(k, 3, 1234, W, H)
    }
    expect(spy).not.toHaveBeenCalled()
  })
  it('時計（Date.now / performance.now）にも依存しない', () => {
    const d = vi.spyOn(Date, 'now').mockImplementation(() => {
      throw new Error('Date.now は使わない')
    })
    const p = vi.spyOn(performance, 'now').mockImplementation(() => {
      throw new Error('performance.now は使わない')
    })
    for (const k of KINDS) {
      createWeatherParticleParams(k, 3)
      computeWeatherParticle(k, 3, 1234, W, H)
    }
    expect(d).not.toHaveBeenCalled()
    expect(p).not.toHaveBeenCalled()
  })
  it('粒ごと・種類ごとに別の値になる（全粒が同じ位置に重ならない）', () => {
    const xs = new Set<number>()
    for (let i = 0; i < 30; i++) xs.add(createWeatherParticleParams('Rain', i).x0)
    expect(xs.size).toBe(30)
    expect(createWeatherParticleParams('Rain', 0)).not.toEqual(
      createWeatherParticleParams('Snow', 0)
    )
  })
  it('パラメータは範囲内（0〜1 の位置・位相）', () => {
    for (const k of KINDS) {
      for (let i = 0; i < 50; i++) {
        const p = createWeatherParticleParams(k, i)
        expect(p.x0).toBeGreaterThanOrEqual(0)
        expect(p.x0).toBeLessThan(1)
        expect(p.y0).toBeGreaterThanOrEqual(0)
        expect(p.y0).toBeLessThan(1)
        expect(p.size).toBeGreaterThan(0)
        expect(p.speedMul).toBeGreaterThan(0)
      }
    }
  })
})

describe('computeWeatherParticle（時間→位置）', () => {
  it('決定論: 同じ入力は同じ出力（呼ぶ順序・回数に依存しない）', () => {
    for (const k of KINDS) {
      const a = computeWeatherParticle(k, 5, 3210, W, H)
      computeWeatherParticle(k, 9, 99999, W, H)
      const b = computeWeatherParticle(k, 5, 3210, W, H)
      expect(b).toEqual(a)
    }
  })

  it('evaluateWeatherParticle（再利用バッファ版）と computeWeatherParticle が一致', () => {
    const out = { x: 0, y: 0, rotation: 0, scale: 1, alpha: 1 }
    for (const k of KINDS) {
      for (const t of [0, 16, 1000, 77777]) {
        const p = createWeatherParticleParams(k, 4)
        evaluateWeatherParticle(k, p, t, W, H, out)
        expect(out).toEqual(computeWeatherParticle(k, 4, t, W, H))
      }
    }
  })

  it('時刻 0 でも画面全体に散らばっている（上端に固まらない）', () => {
    for (const k of KINDS) {
      const ys: number[] = []
      for (let i = 0; i < 40; i++) ys.push(computeWeatherParticle(k, i, 0, W, H).y)
      expect(Math.max(...ys)).toBeGreaterThan(H * 0.7)
      expect(Math.min(...ys)).toBeLessThan(H * 0.3)
    }
  })

  it('落下する: 短い間隔で y が増える（回り込み直後を除く）', () => {
    for (const k of KINDS) {
      let down = 0
      let total = 0
      for (let i = 0; i < 40; i++) {
        const a = computeWeatherParticle(k, i, 1000, W, H)
        const b = computeWeatherParticle(k, i, 1020, W, H)
        total++
        if (b.y > a.y) down++
      }
      expect(down).toBeGreaterThanOrEqual(total - 3)
    }
  })

  it('雨は雪・桜より速く落ちる', () => {
    const speed = (k: WeatherKind) => {
      let sum = 0
      for (let i = 0; i < 20; i++) {
        const p = createWeatherParticleParams(k, i)
        const a = evaluateWeatherParticle(k, p, 1000, W, H, {
          x: 0,
          y: 0,
          rotation: 0,
          scale: 1,
          alpha: 1,
        }).y
        const b = evaluateWeatherParticle(k, p, 1010, W, H, {
          x: 0,
          y: 0,
          rotation: 0,
          scale: 1,
          alpha: 1,
        }).y
        sum += (b > a ? b - a : b - a + H + WEATHER_WRAP_MARGIN * 2) / 0.01
      }
      return sum / 20
    }
    expect(speed('Rain')).toBeGreaterThan(speed('Snow') * 5)
    expect(speed('Rain')).toBeGreaterThan(speed('Sakura') * 5)
  })

  it('下端を抜けたら上端の外へ戻る（周期的に回り込む）。y は常に余白込みの範囲内', () => {
    for (const k of KINDS) {
      for (let i = 0; i < 20; i++) {
        let min = Infinity
        let max = -Infinity
        for (let t = 0; t < 120000; t += 250) {
          const y = computeWeatherParticle(k, i, t, W, H).y
          min = Math.min(min, y)
          max = Math.max(max, y)
          expect(y).toBeGreaterThanOrEqual(-WEATHER_WRAP_MARGIN)
          expect(y).toBeLessThan(H + WEATHER_WRAP_MARGIN)
        }
        // 十分長く見れば上端付近と下端付近の両方を通る＝回り込んでいる
        expect(min).toBeLessThan(H * 0.1)
        expect(max).toBeGreaterThan(H * 0.9)
      }
    }
  })

  it('周期: 1 周期ぶん進むと y が元に戻る（雨で検証）', () => {
    const p = createWeatherParticleParams('Rain', 2)
    const out = { x: 0, y: 0, rotation: 0, scale: 1, alpha: 1 }
    const y0 = evaluateWeatherParticle('Rain', p, 500, W, H, out).y
    // 落下速度 1.4 画面/秒 × speedMul → 1 周期 = 1/(1.4*speedMul) 秒
    const periodMs = 1000 / (1.4 * p.speedMul)
    const y1 = evaluateWeatherParticle('Rain', p, 500 + periodMs, W, H, out).y
    expect(y1).toBeCloseTo(y0, 3)
  })

  it('x は左右にも回り込み、常に余白込みの範囲内', () => {
    for (const k of KINDS) {
      for (let i = 0; i < 20; i++) {
        for (let t = 0; t < 60000; t += 500) {
          const x = computeWeatherParticle(k, i, t, W, H).x
          expect(x).toBeGreaterThanOrEqual(-WEATHER_WRAP_MARGIN)
          expect(x).toBeLessThan(W + WEATHER_WRAP_MARGIN)
        }
      }
    }
  })

  it('雪は周期的に左右へ揺れる（x が往復する）。雨は揺れず一定方向に流れる', () => {
    // 雪: 短時間で x が増減の両方向に動く
    const p = createWeatherParticleParams('Snow', 1)
    const out = { x: 0, y: 0, rotation: 0, scale: 1, alpha: 1 }
    const xs: number[] = []
    for (let t = 0; t < 6000; t += 100) xs.push(evaluateWeatherParticle('Snow', p, t, W, H, out).x)
    const diffs = xs.slice(1).map((x, i) => x - xs[i])
    expect(diffs.some((d) => d > 0.01)).toBe(true)
    expect(diffs.some((d) => d < -0.01)).toBe(true)
    // 雨: 回り込み以外では x は単調に減る（左へ流れる）
    const q = createWeatherParticleParams('Rain', 1)
    const rx: number[] = []
    for (let t = 0; t < 400; t += 20) rx.push(evaluateWeatherParticle('Rain', q, t, W, H, out).x)
    const rd = rx
      .slice(1)
      .map((x, i) => x - rx[i])
      .filter((d) => Math.abs(d) < 100)
    expect(rd.every((d) => d < 0)).toBe(true)
  })

  it('桜は雪より大きく揺れる', () => {
    const amp = (k: WeatherKind) => {
      let sum = 0
      for (let i = 0; i < 20; i++) {
        const p = createWeatherParticleParams(k, i)
        const out = { x: 0, y: 0, rotation: 0, scale: 1, alpha: 1 }
        // ドリフト成分を除くため、揺れの 1 周期の中の x の振れ幅を速度補正して比較する代わりに
        // 揺れ振幅の定数そのもの（x の最大偏差）を長めの窓で見る。
        let min = Infinity
        let max = -Infinity
        for (let t = 0; t < 4000; t += 50) {
          const x = evaluateWeatherParticle(k, p, t, W, H, out).x
          min = Math.min(min, x)
          max = Math.max(max, x)
        }
        sum += max - min
      }
      return sum / 20
    }
    expect(amp('Sakura')).toBeGreaterThan(amp('Snow'))
  })

  it('桜は回転し続け、雪は回転せず、雨は落下方向に傾いた一定の角度', () => {
    const out = { x: 0, y: 0, rotation: 0, scale: 1, alpha: 1 }
    const sp = createWeatherParticleParams('Sakura', 3)
    const r0 = evaluateWeatherParticle('Sakura', sp, 0, W, H, out).rotation
    const r1 = evaluateWeatherParticle('Sakura', sp, 1000, W, H, out).rotation
    expect(r1).not.toBe(r0)
    expect(Math.abs(r1 - r0)).toBeCloseTo(1.4, 5)
    const snow = createWeatherParticleParams('Snow', 3)
    expect(evaluateWeatherParticle('Snow', snow, 0, W, H, out).rotation).toBe(0)
    expect(evaluateWeatherParticle('Snow', snow, 5000, W, H, out).rotation).toBe(0)
    const rain = createWeatherParticleParams('Rain', 3)
    const a = evaluateWeatherParticle('Rain', rain, 0, W, H, out).rotation
    const b = evaluateWeatherParticle('Rain', rain, 9000, W, H, out).rotation
    expect(a).toBe(b)
    expect(a).toBeGreaterThan(0)
    expect(a).toBeLessThan(0.5)
    // 0.25 / 1.4 は weatherParticles.ts の MOTION.Rain の drift / fall と同期が必要（定数を変えたらここも直す）。
    // 傾きは実際の落下距離（高さ + 上下の余白）に対する横流れの比
    expect(a).toBeCloseTo(Math.atan2(0.25 * W, 1.4 * (H + WEATHER_WRAP_MARGIN * 2)), 10)
  })

  it('入力契約: 負・NaN・Infinity の時刻は 0 扱い、不正な画面寸法でも NaN を返さない', () => {
    for (const k of KINDS) {
      const base = computeWeatherParticle(k, 2, 0, W, H)
      expect(computeWeatherParticle(k, 2, -500, W, H)).toEqual(base)
      expect(computeWeatherParticle(k, 2, NaN, W, H)).toEqual(base)
      expect(computeWeatherParticle(k, 2, Infinity, W, H)).toEqual(base)
      const z = computeWeatherParticle(k, 2, 1000, 0, NaN)
      for (const v of Object.values(z)) expect(Number.isFinite(v)).toBe(true)
    }
  })

  it('大きな経過時間でも有限で範囲内（数時間再生しても破綻しない）', () => {
    for (const k of KINDS) {
      const f = computeWeatherParticle(k, 6, 3.6e7, W, H)
      expect(Number.isFinite(f.x) && Number.isFinite(f.y)).toBe(true)
      expect(f.y).toBeGreaterThanOrEqual(-WEATHER_WRAP_MARGIN)
      expect(f.y).toBeLessThan(H + WEATHER_WRAP_MARGIN)
    }
  })
})
