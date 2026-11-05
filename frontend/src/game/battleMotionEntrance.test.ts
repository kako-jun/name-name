import { describe, expect, it } from 'vitest'
import {
  DEFAULT_MOTION_TIMING,
  SNAPPY_MOTION_TIMING,
  entranceTotalMs,
  sampleEntrance,
  type MotionTiming,
} from './battleMotion'

const T: MotionTiming = {
  ...DEFAULT_MOTION_TIMING,
  entranceMs: 200,
  entranceEase: 'outQuad',
  entrancePartyDelayMs: 100,
}

describe('sampleEntrance (#1037)', () => {
  it('default も有効（200ms・snappy と同じ暫定値。#1110）', () => {
    expect(entranceTotalMs(DEFAULT_MOTION_TIMING)).toBe(200)
    expect(sampleEntrance(0, 'enemy', 100, 200, 800)).toEqual({ dx: -200, done: false })
  })
  it('entranceMs 0 は無効（dx 0・done）', () => {
    const off = { ...DEFAULT_MOTION_TIMING, entranceMs: 0 }
    expect(sampleEntrance(0, 'enemy', 100, 200, 800, off)).toEqual({ dx: 0, done: true })
    expect(entranceTotalMs(off)).toBe(0)
  })
  it('snappy は有効（200ms）', () => {
    expect(entranceTotalMs(SNAPPY_MOTION_TIMING)).toBe(200)
  })
  it('総時間は味方の遅れを含む', () => {
    expect(entranceTotalMs(T)).toBe(300)
  })
  it('敵は枠の右端が x=0 の外から出発し 0 に収束する', () => {
    expect(sampleEntrance(0, 'enemy', 100, 250, 800, T)).toEqual({ dx: -250, done: false })
    const mid = sampleEntrance(100, 'enemy', 100, 250, 800, T)
    expect(mid.dx).toBeCloseTo(-250 * 0.25)
    expect(sampleEntrance(200, 'enemy', 100, 250, 800, T)).toEqual({ dx: 0, done: true })
  })
  it('味方は枠の左端が画面右端の外から出発し、遅れの間は開始位置', () => {
    expect(sampleEntrance(0, 'party', 600, 700, 800, T)).toEqual({ dx: 200, done: false })
    expect(sampleEntrance(100, 'party', 600, 700, 800, T)).toEqual({ dx: 200, done: false })
    expect(sampleEntrance(200, 'party', 600, 700, 800, T).dx).toBeCloseTo(200 * 0.25)
    expect(sampleEntrance(300, 'party', 600, 700, 800, T)).toEqual({ dx: 0, done: true })
  })
  it('非有限値は {0, true}', () => {
    expect(sampleEntrance(NaN, 'enemy', 1, 2, 800, T)).toEqual({ dx: 0, done: true })
    expect(sampleEntrance(0, 'party', 1, 2, Infinity, T)).toEqual({ dx: 0, done: true })
  })
  it('elapsed が負なら出発位置のまま（敵・味方とも）', () => {
    expect(sampleEntrance(-50, 'enemy', 100, 250, 800, T)).toEqual({ dx: -250, done: false })
    expect(sampleEntrance(-50, 'party', 600, 700, 800, T)).toEqual({ dx: 200, done: false })
  })
  it('境界: 敵は elapsed=entranceMs ちょうどで done、直前は未完', () => {
    expect(sampleEntrance(199, 'enemy', 100, 250, 800, T).done).toBe(false)
    expect(sampleEntrance(200, 'enemy', 100, 250, 800, T).done).toBe(true)
    expect(sampleEntrance(10_000, 'enemy', 100, 250, 800, T)).toEqual({ dx: 0, done: true })
  })
  it('境界: 味方は delay + entranceMs ちょうどで done、直前は未完。遅れの途中も開始位置', () => {
    expect(sampleEntrance(50, 'party', 600, 700, 800, T)).toEqual({ dx: 200, done: false })
    expect(sampleEntrance(299, 'party', 600, 700, 800, T).done).toBe(false)
    expect(sampleEntrance(300, 'party', 600, 700, 800, T).done).toBe(true)
    expect(sampleEntrance(99999, 'party', 600, 700, 800, T)).toEqual({ dx: 0, done: true })
  })
  it('敵と味方で符号が逆（敵は負、味方は正）。途中も同じ符号のまま単調に 0 へ', () => {
    let prevE = -Infinity
    let prevP = Infinity
    for (let t = 0; t < 200; t += 10) {
      const e = sampleEntrance(t, 'enemy', 100, 250, 800, T).dx
      const p = sampleEntrance(t + 100, 'party', 600, 700, 800, T).dx
      expect(e).toBeLessThanOrEqual(0)
      expect(p).toBeGreaterThanOrEqual(0)
      expect(e).toBeGreaterThanOrEqual(prevE)
      expect(p).toBeLessThanOrEqual(prevP)
      prevE = e
      prevP = p
    }
  })
  it('スロット幅が違っても終点は 0、始点は枠が画面外に出る位置', () => {
    for (const [l, r] of [
      [0, 10],
      [100, 700],
      [790, 800],
    ] as const) {
      expect(sampleEntrance(0, 'enemy', l, r, 800, T).dx + r).toBe(0) // 右端が x=0
      expect(sampleEntrance(0, 'party', l, r, 800, T).dx + l).toBe(800) // 左端が画面右端
      expect(sampleEntrance(300, 'enemy', l, r, 800, T).dx).toBe(0)
      expect(sampleEntrance(300, 'party', l, r, 800, T).dx).toBe(0)
    }
  })
  it('outQuad は出だしが速く、inOutQuad は中間点でちょうど半分', () => {
    const out = sampleEntrance(100, 'enemy', 0, 200, 800, { ...T, entranceEase: 'outQuad' })
    const io = sampleEntrance(100, 'enemy', 0, 200, 800, { ...T, entranceEase: 'inOutQuad' })
    expect(out.dx).toBeCloseTo(-200 * 0.25) // 半分の時間で 75% 進む
    expect(io.dx).toBeCloseTo(-200 * 0.5)
    const o2 = sampleEntrance(50, 'enemy', 0, 200, 800, { ...T, entranceEase: 'outQuad' }).dx
    const i2 = sampleEntrance(50, 'enemy', 0, 200, 800, { ...T, entranceEase: 'inOutQuad' }).dx
    expect(Math.abs(o2)).toBeLessThan(Math.abs(i2))
  })
  it('味方の遅れ 0 なら敵と同時に始まり同時に終わる（総時間も entranceMs）', () => {
    const t0 = { ...T, entrancePartyDelayMs: 0 }
    expect(entranceTotalMs(t0)).toBe(200)
    expect(sampleEntrance(199, 'party', 600, 700, 800, t0).done).toBe(false)
    expect(sampleEntrance(200, 'party', 600, 700, 800, t0).done).toBe(true)
    expect(sampleEntrance(200, 'enemy', 0, 100, 800, t0).done).toBe(true)
    const a = sampleEntrance(80, 'enemy', 0, 100, 800, t0).dx / -100
    const b = sampleEntrance(80, 'party', 700, 800, 800, t0).dx / 100
    expect(a).toBeCloseTo(b)
  })
  it('遅れが負・NaN でも 0 として扱う', () => {
    const neg = { ...T, entrancePartyDelayMs: -50 }
    const nan = { ...T, entrancePartyDelayMs: NaN }
    expect(entranceTotalMs(neg)).toBe(200)
    expect(entranceTotalMs(nan)).toBe(200)
    expect(sampleEntrance(0, 'party', 600, 700, 800, neg).done).toBe(false)
    expect(sampleEntrance(200, 'party', 600, 700, 800, nan).done).toBe(true)
  })
  it('entranceMs <= 0 / NaN は無効（entranceTotalMs 0・dx 0・done）', () => {
    for (const ms of [0, -10, NaN]) {
      const t = { ...T, entranceMs: ms }
      expect(entranceTotalMs(t)).toBe(0)
      expect(sampleEntrance(0, 'enemy', 0, 100, 800, t)).toEqual({ dx: 0, done: true })
      expect(sampleEntrance(0, 'party', 0, 100, 800, t)).toEqual({ dx: 0, done: true })
    }
  })
  it('非有限値は全引数（elapsed・slotLeft・slotRight・screenWidth）で {0, true}', () => {
    expect(sampleEntrance(Infinity, 'enemy', 1, 2, 800, T)).toEqual({ dx: 0, done: true })
    expect(sampleEntrance(0, 'enemy', NaN, 2, 800, T)).toEqual({ dx: 0, done: true })
    expect(sampleEntrance(0, 'enemy', 1, Infinity, 800, T)).toEqual({ dx: 0, done: true })
    expect(sampleEntrance(0, 'party', 1, 2, NaN, T)).toEqual({ dx: 0, done: true })
  })
  it('結果は水平オフセット dx だけを返す（dy・回転などを持たない）', () => {
    expect(Object.keys(sampleEntrance(10, 'enemy', 0, 100, 800, T)).sort()).toEqual(['done', 'dx'])
  })
})
