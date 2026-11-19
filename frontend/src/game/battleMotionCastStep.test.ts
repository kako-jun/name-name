/** 呪文・わざ・アイテムも、前へ踏み出して構え、効果が着いたら戻る (#1222)。行動の長さ・命中の時刻は変えない */
import { describe, expect, it } from 'vitest'
import { DEFAULT_MOTION_TIMING, SNAPPY_MOTION_TIMING, sampleActor } from './battleMotion'

describe.each([
  ['default', DEFAULT_MOTION_TIMING],
  ['snappy', SNAPPY_MOTION_TIMING],
])('sampleActor: 呪文・わざ・アイテムの踏み出し (%s)', (_name, T) => {
  const dist = T.attackStepDistance
  for (const kind of ['spell', 'skill', 'item'] as const) {
    it(`${kind}: 0 で始まり、命中時刻まで前に出て、castMs で 0 に戻る`, () => {
      expect(sampleActor(kind, 0, T).forward).toBe(0)
      const stepMs = Math.min(T.attackStepMs, T.castHitMs)
      expect(sampleActor(kind, stepMs, T).forward).toBeCloseTo(dist, 10)
      expect(sampleActor(kind, stepMs / 2, T).forward).toBeGreaterThan(0)
      expect(sampleActor(kind, stepMs / 2, T).forward).toBeLessThan(dist)
      expect(sampleActor(kind, T.castHitMs - 1, T).forward).toBeCloseTo(dist, 10)
      expect(sampleActor(kind, T.castHitMs, T).forward).toBeCloseTo(dist, 10)
      const mid = (T.castHitMs + T.castMs) / 2
      expect(sampleActor(kind, mid, T).forward).toBeGreaterThan(0)
      expect(sampleActor(kind, mid, T).forward).toBeLessThan(dist)
      expect(sampleActor(kind, T.castMs, T).forward).toBe(0)
      expect(sampleActor(kind, T.castMs + 500, T).forward).toBe(0)
    })
  }

  it('ポーズは従来どおり（構え → castMs から idle）', () => {
    expect(sampleActor('spell', 10, T).pose).toBe('cast')
    expect(sampleActor('skill', 10, T).pose).toBe('special')
    expect(sampleActor('item', 10, T).pose).toBe('ready')
    expect(sampleActor('spell', T.castMs, T).pose).toBe('idle')
  })

  it('notice / status は踏み出さない。攻撃は従来どおり', () => {
    for (const kind of ['notice', 'status'] as const)
      for (const t of [0, T.castHitMs, T.castMs / 2])
        expect(sampleActor(kind, t, T).forward).toBe(0)
    expect(sampleActor('attack', T.attackStepMs, T).forward).toBeCloseTo(T.attackStepDistance, 10)
  })

  it('castMs <= castHitMs でも割り算で壊れず、命中時刻で戻る', () => {
    const bad = { ...T, castMs: T.castHitMs }
    expect(sampleActor('spell', bad.castHitMs - 1, bad).forward).toBeGreaterThan(0)
    expect(sampleActor('spell', bad.castHitMs, bad).forward).toBe(0)
    expect(Number.isFinite(sampleActor('spell', bad.castHitMs + 1, bad).forward)).toBe(true)
  })
})
