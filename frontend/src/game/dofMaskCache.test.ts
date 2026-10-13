import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Texture } from 'pixi.js'
import {
  DOF_MASK_RAMP_STEP,
  getSharedDofMask,
  quantizeDofRamp,
  resetSharedDofMasksForTest,
} from './dofMaskCache'

beforeEach(() => resetSharedDofMasksForTest())

describe('dofMaskCache (#745)', () => {
  it('刻み内で同じ割合は同じテクスチャを返し、1 度しか作らない', () => {
    const build = vi.fn(() => new Texture())
    const a = getSharedDofMask(0.5, build)
    const b = getSharedDofMask(0.5 + DOF_MASK_RAMP_STEP / 4, build)
    expect(a).not.toBeNull()
    expect(b).toBe(a)
    expect(build).toHaveBeenCalledTimes(1)
  })

  it('刻みを超えて違う割合は別のテクスチャ。build には量子化後の割合を渡す', () => {
    const build = vi.fn((r: number) => {
      void r
      return new Texture()
    })
    const a = getSharedDofMask(0.2, build)
    const b = getSharedDofMask(0.2 + DOF_MASK_RAMP_STEP * 3, build)
    expect(b).not.toBe(a)
    expect(build).toHaveBeenNthCalledWith(1, quantizeDofRamp(0.2))
  })

  it('作れなかった（null）ときは覚えず、次に作り直せる', () => {
    expect(getSharedDofMask(0.3, () => null)).toBeNull()
    const t = new Texture()
    expect(getSharedDofMask(0.3, () => t)).toBe(t)
  })
})
