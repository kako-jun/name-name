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
  it('default は無効（dx 0・done）', () => {
    expect(sampleEntrance(0, 'enemy', 100, 200, 800)).toEqual({ dx: 0, done: true })
    expect(entranceTotalMs(DEFAULT_MOTION_TIMING)).toBe(0)
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
})
