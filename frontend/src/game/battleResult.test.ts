import { describe, expect, it } from 'vitest'
import {
  RESULT_HOLD_DQ_MS,
  RESULT_HOLD_FF_MS,
  RESULT_SKIP_GUARD_MS,
  advanceResultElapsed,
  canSkipResultHold,
  isResultHoldDone,
  resultHoldMs,
  resultMessageText,
  resultOutcomeOf,
  windowWord,
} from './battleResult'

describe('battleResult (#745 分割4)', () => {
  it('待機時間は ff の方が長く、どちらも正で飛ばせる猶予より長い', () => {
    expect(resultHoldMs('dq')).toBe(RESULT_HOLD_DQ_MS)
    expect(resultHoldMs('ff')).toBe(RESULT_HOLD_FF_MS)
    expect(RESULT_HOLD_FF_MS).toBeGreaterThan(RESULT_HOLD_DQ_MS)
    expect(RESULT_HOLD_DQ_MS).toBeGreaterThan(RESULT_SKIP_GUARD_MS)
  })

  it('勝敗だけが対象で、逃走・進行中は null', () => {
    expect(resultOutcomeOf('victory')).toBe('victory')
    expect(resultOutcomeOf('defeat')).toBe('defeat')
    expect(resultOutcomeOf('escaped')).toBeNull()
    expect(resultOutcomeOf('party-input')).toBeNull()
  })

  it('経過は加算され、負の dt は無視する。待機時間ちょうどで完了', () => {
    expect(advanceResultElapsed(100, 50)).toBe(150)
    expect(advanceResultElapsed(100, -30)).toBe(100)
    expect(isResultHoldDone(RESULT_HOLD_DQ_MS - 1, RESULT_HOLD_DQ_MS)).toBe(false)
    expect(isResultHoldDone(RESULT_HOLD_DQ_MS, RESULT_HOLD_DQ_MS)).toBe(true)
  })

  it('スキップは猶予を過ぎてから', () => {
    expect(canSkipResultHold(0)).toBe(false)
    expect(canSkipResultHold(RESULT_SKIP_GUARD_MS - 1)).toBe(false)
    expect(canSkipResultHold(RESULT_SKIP_GUARD_MS)).toBe(true)
  })

  it('メッセージ窓: 行動の名前が優先、無ければ勝敗の言葉、どちらも無ければ null', () => {
    expect(windowWord('ファイア', 'victory')).toBe('ファイア')
    expect(windowWord(null, 'victory')).toBe(resultMessageText('victory'))
    expect(windowWord(null, 'defeat')).toBe(resultMessageText('defeat'))
    expect(windowWord(null, null)).toBeNull()
  })
})
