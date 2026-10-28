/**
 * boardFlip.ts (#707) の純粋関数テスト。
 * シアターモードの立ち絵ポーズ変更で板を Y 軸回転させる演出の角度・四隅計算を縛る。
 */
import { describe, it, expect } from 'vitest'
import {
  BOARD_FLIP_MAX_ANGLE_RAD,
  computeBoardFlipCorners,
  computeBoardFlipFrame,
} from './boardFlip'

const HALF_PI = Math.PI / 2
const MAX = BOARD_FLIP_MAX_ANGLE_RAD

describe('computeBoardFlipFrame', () => {
  it('out: elapsed=0 で可視・角度0', () => {
    expect(computeBoardFlipFrame('out', 0, 1000)).toEqual({ visible: true, angleRad: 0 })
  })

  it('out: half 未満で可視かつ単調増加し π/2 未満', () => {
    let prev = -1
    for (const t of [0, 100, 200, 300, 400, 499]) {
      const f = computeBoardFlipFrame('out', t, 1000)
      expect(f.visible).toBe(true)
      expect(f.angleRad).toBeGreaterThanOrEqual(prev)
      expect(f.angleRad).toBeLessThan(MAX + 1e-12)
      prev = f.angleRad
    }
    expect(computeBoardFlipFrame('out', 499, 1000).angleRad).toBeGreaterThan(
      computeBoardFlipFrame('out', 100, 1000).angleRad
    )
  })

  it('out: half 以上で不可視（angle=π/2）', () => {
    expect(computeBoardFlipFrame('out', 500, 1000)).toEqual({ visible: false, angleRad: MAX })
    expect(computeBoardFlipFrame('out', 5000, 1000)).toEqual({ visible: false, angleRad: MAX })
  })

  it('in: half 未満で不可視（-π/2）', () => {
    expect(computeBoardFlipFrame('in', 0, 1000)).toEqual({ visible: false, angleRad: -MAX })
    expect(computeBoardFlipFrame('in', 499, 1000)).toEqual({ visible: false, angleRad: -MAX })
  })

  it('in: half 以降は可視で単調増加し total で 0', () => {
    // half ちょうどは edge-on の退化角なので描かない（setCorners が非有限値になる）。
    expect(computeBoardFlipFrame('in', 500, 1000)).toEqual({ visible: false, angleRad: -MAX })
    let prev = -Infinity
    for (const t of [501, 600, 700, 800, 900, 999]) {
      const f = computeBoardFlipFrame('in', t, 1000)
      expect(f.visible).toBe(true)
      expect(f.angleRad).toBeGreaterThanOrEqual(prev)
      expect(f.angleRad).toBeLessThanOrEqual(0)
      prev = f.angleRad
    }
    const end = computeBoardFlipFrame('in', 1000, 1000)
    expect(end.visible).toBe(true)
    expect(Math.abs(end.angleRad)).toBe(0)
    expect(Math.abs(computeBoardFlipFrame('in', 9999, 1000).angleRad)).toBe(0)
  })

  it.each([0, -100, NaN, Infinity])(
    'totalMs=%s は out 不可視・in 可視で角度の向きを保つ',
    (total) => {
      expect(computeBoardFlipFrame('out', 100, total)).toEqual({
        visible: false,
        angleRad: MAX,
      })
      expect(computeBoardFlipFrame('in', 100, total)).toEqual({ visible: true, angleRad: 0 })
    }
  )

  it('in/out とも角度の絶対値が MAX を超えない（退化角 ±π/2 を返さない）', () => {
    for (let t = 0; t <= 1000; t += 1) {
      for (const role of ['out', 'in'] as const) {
        const f = computeBoardFlipFrame(role, t, 1000)
        expect(Math.abs(f.angleRad)).toBeLessThanOrEqual(MAX)
        expect(Math.abs(f.angleRad)).toBeLessThan(HALF_PI)
      }
    }
  })

  it('out: fromAngleRad（in 途中の現在角）から MAX まで連続して回る', () => {
    const from = -1.0
    expect(computeBoardFlipFrame('out', 0, 1000, from)).toEqual({ visible: true, angleRad: from })
    let prev = from
    for (const t of [100, 200, 300, 400, 499]) {
      const f = computeBoardFlipFrame('out', t, 1000, from)
      expect(f.angleRad).toBeGreaterThan(prev)
      expect(f.angleRad).toBeLessThanOrEqual(MAX)
      prev = f.angleRad
    }
    // 範囲外・非有限の開始角は丸める/0 に倒す。
    expect(computeBoardFlipFrame('out', 0, 1000, 99).angleRad).toBe(MAX)
    expect(computeBoardFlipFrame('out', 0, 1000, NaN).angleRad).toBe(0)
  })

  it('out(fromAngleRad<0): in の終端速度から角速度が連続し、単調増加で MAX に届く', () => {
    const total = 1000
    const half = total / 2
    const dt = 0.01
    // in の p 地点（経過 = half + p*half）の数値微分と、そこから始めた out の初速を比べる。
    for (const p of [0.2, 0.5, 0.8]) {
      const e = half + p * half
      const a0 = computeBoardFlipFrame('in', e, total).angleRad
      const vIn =
        (computeBoardFlipFrame('in', e + dt, total).angleRad -
          computeBoardFlipFrame('in', e - dt, total).angleRad) /
        (2 * dt)
      const vOut =
        (computeBoardFlipFrame('out', dt, total, a0).angleRad -
          computeBoardFlipFrame('out', 0, total, a0).angleRad) /
        dt
      expect(vOut).toBeCloseTo(vIn, 4)
      let prev = a0 - 1e-9
      for (let t = 0; t < half; t += 5) {
        const f = computeBoardFlipFrame('out', t, total, a0)
        expect(f.angleRad).toBeGreaterThan(prev)
        expect(f.angleRad).toBeLessThanOrEqual(MAX)
        prev = f.angleRad
      }
    }
    // 開始角 0 は従来どおり初速 0（p²）。
    const v0 = computeBoardFlipFrame('out', 0.01, total, 0).angleRad / 0.01
    expect(v0).toBeCloseTo(0, 3)
  })

  it('elapsed が負・NaN は 0 にクランプされる', () => {
    expect(computeBoardFlipFrame('out', -50, 1000)).toEqual(computeBoardFlipFrame('out', 0, 1000))
    const nanOut = computeBoardFlipFrame('out', NaN, 1000)
    expect(nanOut.visible).toBe(true)
    expect(nanOut.angleRad).toBe(0)
    // in は負・NaN とも half 未満扱いで不可視（-π/2）。NaN でも角度が NaN にならない。
    expect(computeBoardFlipFrame('in', -50, 1000)).toEqual({ visible: false, angleRad: -MAX })
    const nanIn = computeBoardFlipFrame('in', NaN, 1000)
    expect(Number.isNaN(nanIn.angleRad)).toBe(false)
  })
})

describe('computeBoardFlipCorners', () => {
  const cx = 400
  const bottom = 450
  const w = 200
  const h = 300

  it('angle=0 で矩形に一致する', () => {
    const c = computeBoardFlipCorners(cx, bottom, w, h, 0)
    expect(c.x0).toBeCloseTo(cx - w / 2)
    expect(c.y0).toBeCloseTo(bottom - h)
    expect(c.x1).toBeCloseTo(cx + w / 2)
    expect(c.y1).toBeCloseTo(bottom - h)
    expect(c.x2).toBeCloseTo(cx + w / 2)
    expect(c.y2).toBeCloseTo(bottom)
    expect(c.x3).toBeCloseTo(cx - w / 2)
    expect(c.y3).toBeCloseTo(bottom)
  })

  it.each([HALF_PI, -HALF_PI, MAX, -MAX])(
    'angle=%s でほぼ線（縁はあと数px）だが退化せず全て有限値',
    (a) => {
      const c = computeBoardFlipCorners(cx, bottom, w, h, a)
      for (const v of Object.values(c)) expect(Number.isFinite(v)).toBe(true)
      expect(Math.abs(c.x0 - c.x3)).toBeLessThan(3)
      expect(Math.abs(c.x1 - c.x2)).toBeLessThan(3)
      expect(Math.abs(c.x0 - cx)).toBeLessThan(3)
      // ±π/2 ちょうどを渡しても MAX と同じ四隅（退化角を丸める）。
      expect(c).toEqual(computeBoardFlipCorners(cx, bottom, w, h, a > 0 ? MAX : -MAX))
    }
  )

  it('正の角度では右辺（奥側）が左辺より縦に縮む', () => {
    const c = computeBoardFlipCorners(cx, bottom, w, h, 0.8)
    const leftH = c.y3 - c.y0
    const rightH = c.y2 - c.y1
    expect(rightH).toBeLessThan(leftH)
    expect(leftH).toBeGreaterThan(h)
  })

  it('angle と -angle は左右鏡像になる', () => {
    const p = computeBoardFlipCorners(cx, bottom, w, h, 0.7)
    const n = computeBoardFlipCorners(cx, bottom, w, h, -0.7)
    expect(n.x0).toBeCloseTo(2 * cx - p.x1)
    expect(n.x1).toBeCloseTo(2 * cx - p.x0)
    expect(n.x2).toBeCloseTo(2 * cx - p.x3)
    expect(n.x3).toBeCloseTo(2 * cx - p.x2)
    expect(n.y0).toBeCloseTo(p.y1)
    expect(n.y1).toBeCloseTo(p.y0)
    expect(n.y2).toBeCloseTo(p.y3)
    expect(n.y3).toBeCloseTo(p.y2)
  })

  it('幅・高さ 0 の板でも四隅が有限値', () => {
    const c = computeBoardFlipCorners(cx, bottom, 0, 0, 0.5)
    for (const v of Object.values(c)) expect(Number.isFinite(v)).toBe(true)
  })

  it('横長の板でも分母が正で全角度で有限・奥行きで反転しない', () => {
    const wide = 2000
    const hh = 100
    for (let a = -HALF_PI; a <= HALF_PI + 1e-9; a += HALF_PI / 8) {
      const c = computeBoardFlipCorners(cx, bottom, wide, hh, a)
      for (const v of Object.values(c)) expect(Number.isFinite(v)).toBe(true)
      // 上辺は下辺より常に上（縦が反転しない）。
      expect(c.y0).toBeLessThan(c.y3)
      expect(c.y1).toBeLessThan(c.y2)
    }
  })
})
