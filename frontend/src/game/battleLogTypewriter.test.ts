import { describe, expect, it } from 'vitest'
import {
  BATTLE_LOG_MS_PER_CHAR,
  countAppendedLines,
  isBattleLogTyping,
  makeBattleLogTracker,
  normalizeBattleLogTypewriter,
  skipBattleLog,
  syncBattleLog,
  tickBattleLog,
  visibleBattleLogTail,
} from './battleLogTypewriter'

const MS = BATTLE_LOG_MS_PER_CHAR

describe('normalizeBattleLogTypewriter', () => {
  it("'on' のみ on。未指定・空・未知値は off", () => {
    expect(normalizeBattleLogTypewriter('on')).toBe('on')
    expect(normalizeBattleLogTypewriter(' ON ')).toBe('on')
    for (const v of [undefined, null, '', 'off', 'foo']) {
      expect(normalizeBattleLogTypewriter(v)).toBe('off')
    }
  })
})

describe('countAppendedLines', () => {
  it('追記・変化なし・先頭切り捨て付き追記・重なり無し', () => {
    expect(countAppendedLines([], ['a', 'b'])).toBe(2)
    expect(countAppendedLines(['a', 'b'], ['a', 'b'])).toBe(0)
    expect(countAppendedLines(['a', 'b'], ['a', 'b', 'c'])).toBe(1)
    expect(countAppendedLines(['a', 'b', 'c'], ['b', 'c', 'd', 'e'].slice(0, 3))).toBe(1)
    expect(countAppendedLines(['a', 'b', 'c'], ['x', 'y'])).toBe(2)
  })
})

describe('BattleLogTracker', () => {
  it('新規行だけをタイプし、表示済みの行は即時表示', () => {
    let t = syncBattleLog(makeBattleLogTracker(), ['aa'])
    t = skipBattleLog(t)
    t = syncBattleLog(t, ['aa', 'bcd'])
    expect(visibleBattleLogTail(t, 4)).toEqual(['aa', ''])
    t = tickBattleLog(t, MS * 2, MS)
    expect(visibleBattleLogTail(t, 4)).toEqual(['aa', 'bc'])
    t = tickBattleLog(t, MS, MS)
    expect(visibleBattleLogTail(t, 4)).toEqual(['aa', 'bcd'])
    expect(isBattleLogTyping(t)).toBe(false)
  })

  it('複数行が一度に積まれたら順にタイプし、未開始行は出さない', () => {
    let t = syncBattleLog(makeBattleLogTracker(), ['a', 'b'])
    expect(visibleBattleLogTail(t, 4)).toEqual([''])
    t = tickBattleLog(t, MS, MS)
    expect(visibleBattleLogTail(t, 4)).toEqual(['a', ''])
    expect(isBattleLogTyping(t)).toBe(true)
  })

  it('ログが流れても（先頭切り捨て）タイプ中の行が別の行に化けない', () => {
    let t = syncBattleLog(makeBattleLogTracker(), ['a', 'b', 'c'])
    t = skipBattleLog(t)
    t = syncBattleLog(t, ['a', 'b', 'c', 'xyz'])
    t = tickBattleLog(t, MS, MS)
    t = syncBattleLog(t, ['b', 'c', 'xyz', 'w']) // 先頭 a が捨てられ w が追加
    expect(visibleBattleLogTail(t, 4)).toEqual(['b', 'c', 'x'])
    t = tickBattleLog(t, MS * 2, MS)
    expect(visibleBattleLogTail(t, 4)).toEqual(['b', 'c', 'xyz', ''])
  })

  it('skip で待ち行も含め全文表示し、以後 typing は終わる', () => {
    let t = syncBattleLog(makeBattleLogTracker(), ['abc', 'def'])
    t = skipBattleLog(t)
    expect(visibleBattleLogTail(t, 4)).toEqual(['abc', 'def'])
    expect(isBattleLogTyping(t)).toBe(false)
  })
})
