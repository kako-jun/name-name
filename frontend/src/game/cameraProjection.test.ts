import { describe, expect, it } from 'vitest'
import {
  computeCameraProjection,
  THEATER_CAMERA_REFERENCE_DEPTH,
  THEATER_ELEVATION_OFFSET_PER_DEPTH,
} from './cameraProjection'

describe('computeCameraProjection', () => {
  it('novel モードは depth/orientation/elevation に関わらず常に scale=1・verticalOffset=0（identity、既存動作と完全一致）', () => {
    expect(computeCameraProjection('Novel', 'Audience', null, 0)).toEqual({
      scale: 1,
      verticalOffset: 0,
    })
    expect(computeCameraProjection('Novel', 'Stage', 'LookUp', 100)).toEqual({
      scale: 1,
      verticalOffset: 0,
    })
    expect(computeCameraProjection('Novel', 'Audience', 'LookDown', -5)).toEqual({
      scale: 1,
      verticalOffset: 0,
    })
  })

  it('theater モードは depth=0 で scale=1（縮小なし）', () => {
    expect(computeCameraProjection('Theater', 'Audience', null, 0)).toEqual({
      scale: 1,
      verticalOffset: 0,
    })
  })

  it('theater モードは depth が増えるほど scale が単調に小さくなる', () => {
    const near = computeCameraProjection('Theater', 'Audience', null, 2).scale
    const mid = computeCameraProjection('Theater', 'Audience', null, 10).scale
    const far = computeCameraProjection('Theater', 'Audience', null, 100).scale
    expect(near).toBeLessThan(1)
    expect(mid).toBeLessThan(near)
    expect(far).toBeLessThan(mid)
    expect(far).toBeGreaterThan(0)
  })

  it('theater モードの scale は基準定数を使った式と一致する（定数を直書きせず参照）', () => {
    const depth = 5
    const expected = THEATER_CAMERA_REFERENCE_DEPTH / (THEATER_CAMERA_REFERENCE_DEPTH + depth)
    expect(computeCameraProjection('Theater', 'Audience', null, depth).scale).toBeCloseTo(expected)
  })

  it('theater モードは負値・NaN の depth を 0 相当にクランプする', () => {
    expect(computeCameraProjection('Theater', 'Audience', null, -10)).toEqual({
      scale: 1,
      verticalOffset: 0,
    })
    expect(computeCameraProjection('Theater', 'Audience', null, NaN)).toEqual({
      scale: 1,
      verticalOffset: 0,
    })
  })

  it('theater モードは orientation（客席/舞台）に関わらず同じ scale/verticalOffset を返す（#681 時点では未対応）', () => {
    const audience = computeCameraProjection('Theater', 'Audience', 'LookUp', 7)
    const stage = computeCameraProjection('Theater', 'Stage', 'LookUp', 7)
    expect(stage).toEqual(audience)
  })

  // 境界値: depth=0 を挟んだクランプの境界（Number.isFinite && Math.max(0, depth) の
  // `<0` 取り違え検出）。#7/#8 は同一 depth の符号だけが違う対を成す。
  it('theater モードは depth=-1e-9（0 未満）で scale=1 になる（クランプ境界の負側）', () => {
    expect(computeCameraProjection('Theater', 'Audience', null, -1e-9)).toEqual({
      scale: 1,
      verticalOffset: 0,
    })
  })

  it('theater モードは depth=1e-9（0 超過）で scale が 1 未満になる（#7 との対、クランプ境界の正側）', () => {
    const { scale } = computeCameraProjection('Theater', 'Audience', null, 1e-9)
    expect(scale).toBeLessThan(1)
    // 1 との差は depth が極小のため微小（式が単調に効いていることの確認、丸めで 1 に潰れていない）
    expect(1 - scale).toBeGreaterThan(0)
    expect(1 - scale).toBeLessThan(1e-6)
  })

  // 異常系: depth=Infinity は Number.isFinite で弾かれ 0 相当（scale=1）にフォールバックする。
  it('theater モードは depth=Infinity で scale=1 にフォールバックする（Number.isFinite ガード）', () => {
    expect(computeCameraProjection('Theater', 'Audience', null, Infinity)).toEqual({
      scale: 1,
      verticalOffset: 0,
    })
  })

  // 境界値: depth===THEATER_CAMERA_REFERENCE_DEPTH ちょうどで scale=0.5 になることを
  // 具体数値で固定する（式の typo 検出保険。定数は export された値を参照し直書きしない）。
  it('theater モードは depth===THEATER_CAMERA_REFERENCE_DEPTH ちょうどで scale=0.5 になる', () => {
    const { scale } = computeCameraProjection(
      'Theater',
      'Audience',
      null,
      THEATER_CAMERA_REFERENCE_DEPTH
    )
    expect(scale).toBe(0.5)
  })

  // --- elevation (#682) ---

  it('theater モードは elevation が null（水平）のとき verticalOffset=0（depth に関わらず）', () => {
    expect(computeCameraProjection('Theater', 'Audience', null, 0).verticalOffset).toBe(0)
    expect(computeCameraProjection('Theater', 'Audience', null, 50).verticalOffset).toBe(0)
  })

  // 境界値: depth=0 は `clampedDepth * n` の掛け算を経由すると `-0 * n` = -0 になりうる
  // （LookUp 側は負符号を掛けるため特に危険）。実装は `clampedDepth > 0` ガードで掛け算自体を
  // 迂回しているはずだが、それを Object.is で厳密確認する（0 と -0 は `toBe`/`===` では
  // 区別できないため、符号ビットを直接見る Object.is / 1/x === Infinity が必須）。
  it('theater モードは depth=0 のとき elevation=LookUp/LookDown でも verticalOffset が正の0（-0 ではない）になる', () => {
    const up = computeCameraProjection('Theater', 'Audience', 'LookUp', 0).verticalOffset
    const down = computeCameraProjection('Theater', 'Audience', 'LookDown', 0).verticalOffset
    expect(Object.is(up, 0)).toBe(true)
    expect(Object.is(down, 0)).toBe(true)
    expect(1 / up).toBe(Infinity)
    expect(1 / down).toBe(Infinity)
  })

  it('theater モードは elevation=LookUp のとき verticalOffset が負値になる', () => {
    const { verticalOffset } = computeCameraProjection('Theater', 'Audience', 'LookUp', 5)
    expect(verticalOffset).toBeLessThan(0)
  })

  it('theater モードは elevation=LookDown のとき verticalOffset が正値になる', () => {
    const { verticalOffset } = computeCameraProjection('Theater', 'Audience', 'LookDown', 5)
    expect(verticalOffset).toBeGreaterThan(0)
  })

  it('theater モードの verticalOffset は depth が増えるほど絶対値が単調に大きくなる（LookUp/LookDown 両方）', () => {
    const upNear = computeCameraProjection('Theater', 'Audience', 'LookUp', 2).verticalOffset
    const upFar = computeCameraProjection('Theater', 'Audience', 'LookUp', 10).verticalOffset
    expect(Math.abs(upFar)).toBeGreaterThan(Math.abs(upNear))

    const downNear = computeCameraProjection('Theater', 'Audience', 'LookDown', 2).verticalOffset
    const downFar = computeCameraProjection('Theater', 'Audience', 'LookDown', 10).verticalOffset
    expect(Math.abs(downFar)).toBeGreaterThan(Math.abs(downNear))
  })

  it('theater モードの verticalOffset は基準定数を使った式と一致する（定数を直書きせず参照）', () => {
    const depth = 6
    expect(computeCameraProjection('Theater', 'Audience', 'LookUp', depth).verticalOffset).toBe(
      -depth * THEATER_ELEVATION_OFFSET_PER_DEPTH
    )
    expect(computeCameraProjection('Theater', 'Audience', 'LookDown', depth).verticalOffset).toBe(
      depth * THEATER_ELEVATION_OFFSET_PER_DEPTH
    )
  })

  it('theater モードは elevation=LookUp/LookDown でも depth を負値・NaN から 0 相当にクランプする', () => {
    expect(computeCameraProjection('Theater', 'Audience', 'LookUp', -10).verticalOffset).toBe(0)
    expect(computeCameraProjection('Theater', 'Audience', 'LookDown', NaN).verticalOffset).toBe(0)
  })

  // 境界値: depth===THEATER_CAMERA_REFERENCE_DEPTH ちょうどでの verticalOffset を具体数値で
  // 固定する（scale 側の「ちょうど」境界値テストと対。式の typo 検出保険。定数は export された
  // 値を参照し直書きしない）。
  it('theater モードは depth===THEATER_CAMERA_REFERENCE_DEPTH ちょうどで verticalOffset が具体値になる', () => {
    const depth = THEATER_CAMERA_REFERENCE_DEPTH
    const up = computeCameraProjection('Theater', 'Audience', 'LookUp', depth).verticalOffset
    const down = computeCameraProjection('Theater', 'Audience', 'LookDown', depth).verticalOffset
    expect(up).toBe(-THEATER_CAMERA_REFERENCE_DEPTH * THEATER_ELEVATION_OFFSET_PER_DEPTH)
    expect(down).toBe(THEATER_CAMERA_REFERENCE_DEPTH * THEATER_ELEVATION_OFFSET_PER_DEPTH)
  })
})
