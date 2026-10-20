import { describe, expect, it } from 'vitest'
import { WARP_COLOR, WARP_DEFAULTS, sampleWarp } from './fieldWarp'

const T = { outMs: 100, holdMs: 50, inMs: 200 }

describe('sampleWarp (#864)', () => {
  it('out は 0→1、境界ちょうどで次の相へ', () => {
    expect(sampleWarp(T, 0)).toEqual({ phase: 'out', alpha: 0 })
    expect(sampleWarp(T, 50)).toEqual({ phase: 'out', alpha: 0.5 })
    expect(sampleWarp(T, 100)).toEqual({ phase: 'hold', alpha: 1 })
  })
  it('hold は 1 のまま、境界で in', () => {
    expect(sampleWarp(T, 149).phase).toBe('hold')
    expect(sampleWarp(T, 150)).toEqual({ phase: 'in', alpha: 1 })
  })
  it('in は 1→0、全部過ぎたら done（alpha 0）', () => {
    expect(sampleWarp(T, 250)).toEqual({ phase: 'in', alpha: 0.5 })
    expect(sampleWarp(T, 350)).toEqual({ phase: 'done', alpha: 0 })
    expect(sampleWarp(T, 99999)).toEqual({ phase: 'done', alpha: 0 })
  })
  it('時間 0 の区間は飛ばす', () => {
    expect(sampleWarp({ outMs: 0, holdMs: 0, inMs: 100 }, 0)).toEqual({ phase: 'in', alpha: 1 })
    expect(sampleWarp({ outMs: 0, holdMs: 0, inMs: 0 }, 0).phase).toBe('done')
  })
  it('負・NaN の経過は 0 扱い', () => {
    expect(sampleWarp(T, -5)).toEqual({ phase: 'out', alpha: 0 })
    expect(sampleWarp(T, NaN)).toEqual({ phase: 'out', alpha: 0 })
  })
  it('alpha は常に 0..1', () => {
    for (let t = -10; t < 400; t += 7) {
      const a = sampleWarp(WARP_DEFAULTS.fade, t).alpha
      expect(a).toBeGreaterThanOrEqual(0)
      expect(a).toBeLessThanOrEqual(1)
    }
  })
  it('既定: fade は黒・flash は白、どちらの時間も正', () => {
    expect(WARP_COLOR.fade).toBe(0x000000)
    expect(WARP_COLOR.flash).toBe(0xffffff)
    for (const k of ['fade', 'flash'] as const) {
      expect(WARP_DEFAULTS[k].outMs).toBeGreaterThan(0)
      expect(WARP_DEFAULTS[k].inMs).toBeGreaterThan(0)
    }
  })
})
