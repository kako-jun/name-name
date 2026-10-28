/**
 * boardSway.ts (#701) の純粋関数テスト。
 * シアターの歩行中だけ板が傾く揺らぎの、境界・上限・有効条件を縛る。
 */
import { describe, it, expect } from 'vitest'
import {
  BOARD_SWAY_MAX_SKEW_RAD,
  BOARD_SWAY_PERIOD_MS,
  computeBoardSway,
  isBoardSwayEnabled,
} from './boardSway'

const D = 1400

describe('computeBoardSway', () => {
  it('移動開始（elapsed=0）と時間 0 未満は 0', () => {
    expect(computeBoardSway(0, D)).toBe(0)
    expect(computeBoardSway(-10, D)).toBe(0)
  })

  it('移動終了（elapsed>=duration）以降は厳密に 0（最終ポーズに傾きが残らない）', () => {
    expect(computeBoardSway(D, D)).toBe(0)
    expect(computeBoardSway(D + 1, D)).toBe(0)
    expect(computeBoardSway(99999, D)).toBe(0)
  })

  it('開始・終了の近傍で連続に 0 へ収束する（包絡が 0 に向かう）', () => {
    const near = (t: number) => Math.abs(computeBoardSway(t, D))
    expect(near(1)).toBeLessThan(near(100) + 1e-12)
    expect(near(1)).toBeLessThan(0.001)
    expect(near(D - 1)).toBeLessThan(0.001)
    expect(near(D - 1)).toBeLessThan(BOARD_SWAY_MAX_SKEW_RAD * 0.01)
  })

  it('全区間で振幅上限を超えず、途中では実際に揺れる（0 固定ではない）', () => {
    let maxAbs = 0
    let hasPositive = false
    let hasNegative = false
    for (let t = 0; t < D; t += 5) {
      const v = computeBoardSway(t, D)
      expect(Number.isFinite(v)).toBe(true)
      expect(Math.abs(v)).toBeLessThanOrEqual(BOARD_SWAY_MAX_SKEW_RAD + 1e-12)
      maxAbs = Math.max(maxAbs, Math.abs(v))
      if (v > 0) hasPositive = true
      if (v < 0) hasNegative = true
    }
    expect(maxAbs).toBeGreaterThan(BOARD_SWAY_MAX_SKEW_RAD * 0.8)
    expect(hasPositive).toBe(true)
    expect(hasNegative).toBe(true)
  })

  it('周期ごとに符号が変わる（四半周期で最大、半周期でゼロ交差）', () => {
    expect(computeBoardSway(BOARD_SWAY_PERIOD_MS / 4, D)).toBeGreaterThan(0)
    expect(computeBoardSway((BOARD_SWAY_PERIOD_MS * 3) / 4, D)).toBeLessThan(0)
    expect(Math.abs(computeBoardSway(BOARD_SWAY_PERIOD_MS / 2, D))).toBeLessThan(1e-12)
  })

  it('決定論的: 同じ入力は同じ値', () => {
    expect(computeBoardSway(333, D)).toBe(computeBoardSway(333, D))
  })

  it('不正入力（duration<=0・NaN・Infinity）は 0', () => {
    expect(computeBoardSway(100, 0)).toBe(0)
    expect(computeBoardSway(100, -5)).toBe(0)
    expect(computeBoardSway(NaN, D)).toBe(0)
    expect(computeBoardSway(100, NaN)).toBe(0)
    expect(computeBoardSway(Infinity, D)).toBe(0)
    expect(computeBoardSway(100, Infinity)).toBe(0)
  })
})

describe('isBoardSwayEnabled', () => {
  it('シアターで書き出し中でなく動き減らす設定でもなければ有効', () => {
    expect(isBoardSwayEnabled({ isTheater: true, exporting: false, reducedMotion: false })).toBe(
      true
    )
  })
  it('ノベルでは常に無効', () => {
    expect(isBoardSwayEnabled({ isTheater: false, exporting: false, reducedMotion: false })).toBe(
      false
    )
  })
  it('書き出し中は無効', () => {
    expect(isBoardSwayEnabled({ isTheater: true, exporting: true, reducedMotion: false })).toBe(
      false
    )
  })
  it('prefers-reduced-motion では無効', () => {
    expect(isBoardSwayEnabled({ isTheater: true, exporting: false, reducedMotion: true })).toBe(
      false
    )
  })
})
