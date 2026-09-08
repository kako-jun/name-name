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

  // 境界値: depth=0 を挟んだクランプの境界（Number.isFinite && Math.max(0, depth) の
  // `<0` 取り違え検出）。#7/#8 は同一 depth の符号だけが違う対を成す。
  it('theater モードは depth=-1e-9（0 未満）で scale=1 になる（クランプ境界の負側）', () => {
    expect(computeCameraProjection('Theater', 'Audience', -1e-9)).toEqual({ scale: 1 })
  })

  it('theater モードは depth=1e-9（0 超過）で scale が 1 未満になる（#7 との対、クランプ境界の正側）', () => {
    const { scale } = computeCameraProjection('Theater', 'Audience', 1e-9)
    expect(scale).toBeLessThan(1)
    // 1 との差は depth が極小のため微小（式が単調に効いていることの確認、丸めで 1 に潰れていない）
    expect(1 - scale).toBeGreaterThan(0)
    expect(1 - scale).toBeLessThan(1e-6)
  })

  // 異常系: depth=Infinity は Number.isFinite で弾かれ 0 相当（scale=1）にフォールバックする。
  it('theater モードは depth=Infinity で scale=1 にフォールバックする（Number.isFinite ガード）', () => {
    expect(computeCameraProjection('Theater', 'Audience', Infinity)).toEqual({ scale: 1 })
  })

  // 境界値: depth===THEATER_CAMERA_REFERENCE_DEPTH ちょうどで scale=0.5 になることを
  // 具体数値で固定する（式の typo 検出保険。定数は export された値を参照し直書きしない）。
  it('theater モードは depth===THEATER_CAMERA_REFERENCE_DEPTH ちょうどで scale=0.5 になる', () => {
    const { scale } = computeCameraProjection('Theater', 'Audience', THEATER_CAMERA_REFERENCE_DEPTH)
    expect(scale).toBe(0.5)
  })
})
