/**
 * イベント絵ピクセレート遷移 (#583) の時間→値 純粋計算のユニットテスト。
 * `ambientEffects.test.ts`/`screenEffects.test.ts` と同じ流儀: PixiJS に依存しない純粋関数を
 * 直接呼んで検証する。
 */
import { describe, expect, it } from 'vitest'
import {
  computeCoarsenSize,
  computeRefineSize,
  computeSwapAtMs,
  isCoarsenComplete,
  isRefineComplete,
  PIXELATE_TRANSITION_MAX_SIZE,
} from './pixelateTransition'

// ---- F-1: 異常な elapsedMs (負値/NaN/Infinity) は 0 扱いになる ----

describe('異常な elapsedMs (負値/NaN/Infinity) は 0 扱いになる', () => {
  it('computeCoarsenSize: elapsedMs=0 と同じ結果になる', () => {
    const zeroBaseline = computeCoarsenSize(0, 1000)
    expect(computeCoarsenSize(-100, 1000)).toBe(zeroBaseline)
    expect(computeCoarsenSize(NaN, 1000)).toBe(zeroBaseline)
    expect(computeCoarsenSize(Infinity, 1000)).toBe(zeroBaseline)
  })

  it('computeRefineSize: elapsedMs=0 と同じ結果になる', () => {
    const zeroBaseline = computeRefineSize(0, 1000)
    expect(computeRefineSize(-100, 1000)).toBe(zeroBaseline)
    expect(computeRefineSize(NaN, 1000)).toBe(zeroBaseline)
    expect(computeRefineSize(Infinity, 1000)).toBe(zeroBaseline)
  })

  it('isCoarsenComplete: elapsedMs=0 と同じ結果になる', () => {
    const zeroBaseline = isCoarsenComplete(0, 1000)
    expect(isCoarsenComplete(-100, 1000)).toBe(zeroBaseline)
    expect(isCoarsenComplete(NaN, 1000)).toBe(zeroBaseline)
    // Infinity は非有限として 0 扱いになる一方、素の 0 との比較は isCoarsenComplete(0, 1000) と
    // 同じ false のはず（swapAtMs=1000 に対し 0 はまだ未到達）。
    expect(isCoarsenComplete(Infinity, 1000)).toBe(zeroBaseline)
  })

  it('isRefineComplete: elapsedMs=0 と同じ結果になる', () => {
    const zeroBaseline = isRefineComplete(0, 1000)
    expect(isRefineComplete(-100, 1000)).toBe(zeroBaseline)
    expect(isRefineComplete(NaN, 1000)).toBe(zeroBaseline)
    expect(isRefineComplete(Infinity, 1000)).toBe(zeroBaseline)
  })
})

// ---- F-2: computeSwapAtMs の境界(duration<=0/通常/巨大値) ----

describe('computeSwapAtMs の境界', () => {
  it('duration<=0 は 0 を返す（0 と負値の両方）', () => {
    expect(computeSwapAtMs(0)).toBe(0)
    expect(computeSwapAtMs(-500)).toBe(0)
  })

  it('通常の duration は ratio(既定0.5)を掛けた値を返す', () => {
    expect(computeSwapAtMs(1000)).toBe(500)
    expect(computeSwapAtMs(800)).toBe(400)
  })

  it('巨大値(Number.MAX_VALUE)でも NaN/Infinity にならず比例した値を返す', () => {
    const result = computeSwapAtMs(Number.MAX_VALUE)
    expect(Number.isFinite(result)).toBe(true)
    expect(result).toBe(Number.MAX_VALUE * 0.5)
  })

  it('duration が非有限(Infinity)は 0 扱いになる', () => {
    expect(computeSwapAtMs(Infinity)).toBe(0)
  })

  it('ratio を明示指定すると既定0.5を上書きできる', () => {
    expect(computeSwapAtMs(1000, 0.25)).toBe(250)
  })
})

// ---- F-3: computeCoarsenSize の境界(swapAtMs-1/swapAtMs/swapAtMs+1) ----

describe('computeCoarsenSize の swapAtMs 境界', () => {
  // swapAtMs=10 という小さい値を選ぶことで、境界-1(9ms)でもまだ t<1 となり
  // 境界ちょうど(10ms)の最大値と数値上はっきり区別できるようにする
  // （swapAtMsが大きいと丸めで差が出ない）。
  const swapAtMs = 10

  it('境界-1(9ms)は最大値未満', () => {
    const size = computeCoarsenSize(9, swapAtMs)
    expect(size).toBeLessThan(PIXELATE_TRANSITION_MAX_SIZE)
  })

  it('境界ちょうど(10ms)は最大値に到達する', () => {
    expect(computeCoarsenSize(10, swapAtMs)).toBe(PIXELATE_TRANSITION_MAX_SIZE)
  })

  it('境界+1(11ms)も最大値でクランプされ超えない', () => {
    expect(computeCoarsenSize(11, swapAtMs)).toBe(PIXELATE_TRANSITION_MAX_SIZE)
  })
})

// ---- F-4: computeRefineSize の境界(remainingMs-1/remainingMs/remainingMs+1) ----

describe('computeRefineSize の remainingMs 境界', () => {
  const remainingMs = 10

  it('境界-1(9ms)は最小値(1)より大きい', () => {
    const size = computeRefineSize(9, remainingMs)
    expect(size).toBeGreaterThan(1)
  })

  it('境界ちょうど(10ms)は最小値(1)に到達する', () => {
    expect(computeRefineSize(10, remainingMs)).toBe(1)
  })

  it('境界+1(11ms)も最小値(1)でクランプされ下回らない', () => {
    expect(computeRefineSize(11, remainingMs)).toBe(1)
  })
})

// ---- F-5: 端点での最小/最大値 ----

describe('端点(elapsedMs=0)での最小/最大値', () => {
  it('computeCoarsenSize は開始直後(elapsedMs=0)で最小値(1、最も細かい)を返す', () => {
    expect(computeCoarsenSize(0, 1000)).toBe(1)
  })

  it('computeRefineSize は開始直後(elapsedMs=0)で最大値(最も粗い)を返す（スワップ直後は粗いまま）', () => {
    expect(computeRefineSize(0, 1000)).toBe(PIXELATE_TRANSITION_MAX_SIZE)
  })
})

// ---- F-6: swapAtMs<=0 での即座 maxSize ----

describe('computeCoarsenSize: swapAtMs<=0 は即座に maxSize を返す', () => {
  it('swapAtMs=0 は elapsedMs に関わらず maxSize', () => {
    expect(computeCoarsenSize(0, 0)).toBe(PIXELATE_TRANSITION_MAX_SIZE)
    expect(computeCoarsenSize(500, 0)).toBe(PIXELATE_TRANSITION_MAX_SIZE)
  })

  it('swapAtMs が負値も maxSize（所要時間0＝瞬時切替と同じ扱い）', () => {
    expect(computeCoarsenSize(100, -50)).toBe(PIXELATE_TRANSITION_MAX_SIZE)
  })
})

// ---- F-7: isCoarsenComplete / isRefineComplete の境界 ----

describe('isCoarsenComplete の境界(swapAtMs-1/swapAtMs/swapAtMs+1)', () => {
  it('境界-1(99ms)は未完了', () => {
    expect(isCoarsenComplete(99, 100)).toBe(false)
  })

  it('境界ちょうど(100ms)は完了', () => {
    expect(isCoarsenComplete(100, 100)).toBe(true)
  })

  it('境界+1(101ms)も完了のまま', () => {
    expect(isCoarsenComplete(101, 100)).toBe(true)
  })
})

describe('isRefineComplete の境界(remainingMs-1/remainingMs/remainingMs+1)', () => {
  it('境界-1(99ms)は未完了', () => {
    expect(isRefineComplete(99, 100)).toBe(false)
  })

  it('境界ちょうど(100ms)は完了', () => {
    expect(isRefineComplete(100, 100)).toBe(true)
  })

  it('境界+1(101ms)も完了のまま', () => {
    expect(isRefineComplete(101, 100)).toBe(true)
  })
})
