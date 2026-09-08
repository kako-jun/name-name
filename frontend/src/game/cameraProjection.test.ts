import { describe, expect, it } from 'vitest'
import { computeCameraProjection, THEATER_CAMERA_REFERENCE_DEPTH } from './cameraProjection'

describe('computeCameraProjection', () => {
  it('novel モードは depth/orientation に関わらず常に scale=1（identity、既存動作と完全一致）', () => {
    expect(computeCameraProjection('Novel', 'Audience', 0)).toEqual({ scale: 1 })
    expect(computeCameraProjection('Novel', 'Stage', 100)).toEqual({ scale: 1 })
    expect(computeCameraProjection('Novel', 'Audience', -5)).toEqual({ scale: 1 })
  })

  it('theater モードは depth=0 で scale=1（縮小なし）', () => {
    expect(computeCameraProjection('Theater', 'Audience', 0)).toEqual({ scale: 1 })
  })

  it('theater モードは depth が増えるほど scale が単調に小さくなる', () => {
    const near = computeCameraProjection('Theater', 'Audience', 2).scale
    const mid = computeCameraProjection('Theater', 'Audience', 10).scale
    const far = computeCameraProjection('Theater', 'Audience', 100).scale
    expect(near).toBeLessThan(1)
    expect(mid).toBeLessThan(near)
    expect(far).toBeLessThan(mid)
    expect(far).toBeGreaterThan(0)
  })

  it('theater モードの scale は基準定数を使った式と一致する（定数を直書きせず参照）', () => {
    const depth = 5
    const expected = THEATER_CAMERA_REFERENCE_DEPTH / (THEATER_CAMERA_REFERENCE_DEPTH + depth)
    expect(computeCameraProjection('Theater', 'Audience', depth).scale).toBeCloseTo(expected)
  })

  it('theater モードは負値・NaN の depth を 0 相当にクランプする', () => {
    expect(computeCameraProjection('Theater', 'Audience', -10)).toEqual({ scale: 1 })
    expect(computeCameraProjection('Theater', 'Audience', NaN)).toEqual({ scale: 1 })
  })

  it('theater モードは orientation（客席/舞台）に関わらず同じ scale を返す（#681 時点では未対応）', () => {
    const audience = computeCameraProjection('Theater', 'Audience', 7)
    const stage = computeCameraProjection('Theater', 'Stage', 7)
    expect(stage).toEqual(audience)
  })
})
