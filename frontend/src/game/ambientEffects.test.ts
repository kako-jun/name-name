/**
 * イベント絵アンビエント演出 (#582) の時間→値 純粋計算のユニットテスト。
 * `screenEffects.test.ts` と同じ流儀: PixiJS に依存しない純粋関数を直接呼んで検証する。
 */
import { describe, expect, it, vi } from 'vitest'
import {
  buildDisplacementNoiseCanvas,
  CANDLE_STEP_MS,
  computeCandleFlicker,
  computeWobbleOffset,
} from './ambientEffects'

describe('computeWobbleOffset: 異常な elapsedMs は 0 扱いになる', () => {
  // 入力契約（doc comment）: 非有限値/負値は 0 扱い。elapsedMs=0 と同じ結果になることで確認する。
  const zeroBaseline = computeWobbleOffset(0)

  it('負値は 0 扱い', () => {
    expect(computeWobbleOffset(-100)).toEqual(zeroBaseline)
  })

  it('NaN は 0 扱い', () => {
    expect(computeWobbleOffset(NaN)).toEqual(zeroBaseline)
  })

  it('Infinity は 0 扱い', () => {
    expect(computeWobbleOffset(Infinity)).toEqual(zeroBaseline)
  })
})

describe('computeCandleFlicker: ステップ境界 (TUI版 apply_candle と対称)', () => {
  it('elapsedMs=119(step=0)→120(step=1)でステップが変わり値が変化する', () => {
    expect(computeCandleFlicker(119)).not.toBe(computeCandleFlicker(120))
  })

  it('elapsedMs=120→121は同じstep=1のため値は変化しない', () => {
    expect(computeCandleFlicker(120)).toBe(computeCandleFlicker(121))
  })
})

describe('computeCandleFlicker: 出力範囲', () => {
  it('出力は常に [0.86, 1.0] のクランプ範囲に収まる', () => {
    for (let ms = 0; ms < CANDLE_STEP_MS * 50; ms += 37) {
      const v = computeCandleFlicker(ms)
      expect(v).toBeGreaterThanOrEqual(0.86)
      expect(v).toBeLessThanOrEqual(1.0)
    }
  })
})

describe('computeCandleFlicker: stepMs<=0 は既定 CANDLE_STEP_MS にフォールバックする', () => {
  it('stepMs=0 は既定 CANDLE_STEP_MS を使ったのと同じ値になる', () => {
    expect(computeCandleFlicker(500, 0)).toBe(computeCandleFlicker(500, CANDLE_STEP_MS))
  })

  it('stepMs が負値も既定 CANDLE_STEP_MS を使ったのと同じ値になる', () => {
    expect(computeCandleFlicker(500, -50)).toBe(computeCandleFlicker(500, CANDLE_STEP_MS))
  })
})

describe('buildDisplacementNoiseCanvas: jsdom 環境での防御的フォールバック', () => {
  it('jsdom（canvas 2D 未実装）では null を返し、console.error も呼ばれない', () => {
    // このリポの vitest jsdom 環境には `canvas` npm パッケージ（jsdom の optional peer dep）が
    // 導入されていない（package-lock.json 上は jsdom の peerDependenciesMeta.optional のみで
    // node_modules/canvas は存在しない）ため、getContext('2d') は仕様どおり null を返す。
    // buildDisplacementNoiseCanvas の doc comment が明示する防御的フォールバックを直接ロックする。
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    const result = buildDisplacementNoiseCanvas()

    expect(result).toBeNull()
    expect(errorSpy).not.toHaveBeenCalled()

    errorSpy.mockRestore()
  })
})
