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

describe('countAppendedLines: 境界・限界 (#755 QA)', () => {
  it('prev が空・next が空・両方空', () => {
    expect(countAppendedLines([], [])).toBe(0)
    expect(countAppendedLines(['a'], [])).toBe(0)
    expect(countAppendedLines([], ['a'])).toBe(1)
  })

  it('先頭が 1 件捨てられ 1 件追記（30 件上限の定常状態）', () => {
    const prev = Array.from({ length: 30 }, (_, i) => `l${i}`)
    const next = [...prev.slice(1), 'new']
    expect(countAppendedLines(prev, next)).toBe(1)
  })

  it('先頭が 3 件捨てられ 3 件追記', () => {
    const prev = Array.from({ length: 30 }, (_, i) => `l${i}`)
    const next = [...prev.slice(3), 'n1', 'n2', 'n3']
    expect(countAppendedLines(prev, next)).toBe(3)
  })

  it('連続する同一文面: 末尾追記は正しく数える', () => {
    expect(countAppendedLines(['a', 'a'], ['a', 'a', 'a'])).toBe(1)
  })

  it('限界の現状仕様: 全行が同一文面で 1 件捨て 1 件追記すると 0 と数える（即時表示側に倒れる）', () => {
    expect(countAppendedLines(['a', 'a', 'a'], ['a', 'a', 'a'])).toBe(0)
  })

  it('限界の現状仕様: 同一文面でタイプされず、tracker は新規行を待たせない', () => {
    let t = syncBattleLog(makeBattleLogTracker(), ['a', 'a', 'a'])
    t = skipBattleLog(t)
    t = syncBattleLog(t, ['a', 'a', 'a'])
    expect(isBattleLogTyping(t)).toBe(false)
    expect(visibleBattleLogTail(t, 4)).toEqual(['a', 'a', 'a'])
  })

  it('入力配列を破壊しない', () => {
    const prev = ['a', 'b']
    const next = ['b', 'c']
    countAppendedLines(prev, next)
    expect(prev).toEqual(['a', 'b'])
    expect(next).toEqual(['b', 'c'])
  })
})

describe('BattleLogTracker: 追加観点 (#755 QA)', () => {
  it('空ログを取り込んでも何も出ず、typing でもない', () => {
    const t = syncBattleLog(makeBattleLogTracker(), [])
    expect(visibleBattleLogTail(t, 4)).toEqual([])
    expect(isBattleLogTyping(t)).toBe(false)
  })

  it('同じログを再 sync してもタイプ状態が巻き戻らない（redraw 相当）', () => {
    let t = syncBattleLog(makeBattleLogTracker(), ['abc'])
    t = tickBattleLog(t, MS, MS)
    t = syncBattleLog(t, ['abc'])
    t = syncBattleLog(t, ['abc'])
    expect(visibleBattleLogTail(t, 4)).toEqual(['a'])
    expect(isBattleLogTyping(t)).toBe(true)
  })

  it('空文字の行は即完了で、後続のタイプを塞がない', () => {
    let t = syncBattleLog(makeBattleLogTracker(), ['', 'ab'])
    expect(visibleBattleLogTail(t, 4)).toEqual(['', ''])
    expect(isBattleLogTyping(t)).toBe(true)
    t = tickBattleLog(t, MS, MS)
    expect(visibleBattleLogTail(t, 4)).toEqual(['', 'a'])
  })

  it('複数行を上から順に: 前の行が終わるまで次の行は 0 文字のまま', () => {
    let t = syncBattleLog(makeBattleLogTracker(), ['ab', 'cd'])
    t = tickBattleLog(t, MS, MS)
    expect(visibleBattleLogTail(t, 4)).toEqual(['a'])
    t = tickBattleLog(t, MS, MS)
    expect(visibleBattleLogTail(t, 4)).toEqual(['ab', ''])
    t = tickBattleLog(t, MS, MS)
    expect(visibleBattleLogTail(t, 4)).toEqual(['ab', 'c'])
    t = tickBattleLog(t, MS, MS)
    expect(visibleBattleLogTail(t, 4)).toEqual(['ab', 'cd'])
    expect(isBattleLogTyping(t)).toBe(false)
  })

  it('30 件上限で先頭が捨てられ続けても、タイプ中の行の文面が化けない', () => {
    const base = Array.from({ length: 30 }, (_, i) => `l${i}`)
    let t = syncBattleLog(makeBattleLogTracker(), base)
    t = skipBattleLog(t)
    let log = [...base.slice(1), 'hello']
    t = syncBattleLog(t, log)
    t = tickBattleLog(t, MS * 2, MS)
    expect(visibleBattleLogTail(t, 1)).toEqual(['he'])
    // タイプ中にさらに 2 件積まれて先頭が 2 件捨てられる
    log = [...log.slice(2), 'x', 'y']
    t = syncBattleLog(t, log)
    expect(visibleBattleLogTail(t, 3)).toEqual(['l28', 'l29', 'he'])
    t = tickBattleLog(t, MS * 3, MS)
    expect(visibleBattleLogTail(t, 3)).toEqual(['l29', 'hello', ''])
  })

  it('タイプ中の行自体が一括置換で流れ去っても例外なく次へ進む', () => {
    let t = syncBattleLog(makeBattleLogTracker(), ['aaa', 'bbb', 'ccc'])
    t = syncBattleLog(t, ['ddd', 'eee', 'fff'])
    expect(visibleBattleLogTail(t, 4)).toEqual([''])
    t = tickBattleLog(t, MS, MS)
    expect(visibleBattleLogTail(t, 4)).toEqual(['d'])
    expect(isBattleLogTyping(t)).toBe(true)
  })

  it('skip は typing でも待ちでもなければ同一参照を返す・二重 skip も安全', () => {
    const t0 = makeBattleLogTracker()
    expect(skipBattleLog(t0)).toBe(t0)
    const t1 = skipBattleLog(syncBattleLog(t0, ['abc']))
    expect(skipBattleLog(t1)).toBe(t1)
  })

  it('skip 後に tick しても何も変わらない', () => {
    const t = skipBattleLog(syncBattleLog(makeBattleLogTracker(), ['abc']))
    expect(tickBattleLog(t, MS, MS)).toBe(t)
  })

  it('skip 後に新しい行が積まれればまたタイプされる', () => {
    let t = skipBattleLog(syncBattleLog(makeBattleLogTracker(), ['abc']))
    t = syncBattleLog(t, ['abc', 'de'])
    expect(visibleBattleLogTail(t, 4)).toEqual(['abc', ''])
    expect(isBattleLogTyping(t)).toBe(true)
  })
})

describe('tickBattleLog: deltaMS / msPerChar 境界 (#755 QA)', () => {
  const typing = () => syncBattleLog(makeBattleLogTracker(), ['abcd'])

  it('1 文字分に満たない端数は繰り越され、足して 1 文字になる', () => {
    let t = tickBattleLog(typing(), MS / 2, MS)
    expect(visibleBattleLogTail(t, 1)).toEqual([''])
    t = tickBattleLog(t, MS / 2, MS)
    expect(visibleBattleLogTail(t, 1)).toEqual(['a'])
  })

  it('境界-1 / 境界 / 境界+1: MS-1 では 0 文字、MS で 1 文字、MS+1 でも 1 文字', () => {
    expect(visibleBattleLogTail(tickBattleLog(typing(), MS - 1, MS), 1)).toEqual([''])
    expect(visibleBattleLogTail(tickBattleLog(typing(), MS, MS), 1)).toEqual(['a'])
    expect(visibleBattleLogTail(tickBattleLog(typing(), MS + 1, MS), 1)).toEqual(['a'])
  })

  it('負の deltaMS・NaN は進めない（巻き戻らない）', () => {
    let t = tickBattleLog(typing(), MS, MS)
    t = tickBattleLog(t, -1000, MS)
    expect(visibleBattleLogTail(t, 1)).toEqual(['a'])
    t = tickBattleLog(t, Number.NaN, MS)
    expect(visibleBattleLogTail(t, 1)).toEqual(['a'])
  })

  it('msPerChar 0 / 負 / NaN は 1 tick でその行を即完了', () => {
    for (const ms of [0, -5, Number.NaN]) {
      const t = tickBattleLog(typing(), 1, ms)
      expect(visibleBattleLogTail(t, 1)).toEqual(['abcd'])
      expect(isBattleLogTyping(t)).toBe(false)
    }
  })

  it('msPerChar 0 でも複数行は 1 tick 1 行（次の行は 0 文字から始まる）', () => {
    let t = syncBattleLog(makeBattleLogTracker(), ['ab', 'cd'])
    t = tickBattleLog(t, 1, 0)
    expect(visibleBattleLogTail(t, 4)).toEqual(['ab', ''])
    t = tickBattleLog(t, 1, 0)
    expect(visibleBattleLogTail(t, 4)).toEqual(['ab', 'cd'])
  })

  it('巨大 deltaMS でも行末で止まり、次行は繰り越しなしで 0 文字から', () => {
    let t = syncBattleLog(makeBattleLogTracker(), ['ab', 'cd'])
    t = tickBattleLog(t, MS * 1000, MS)
    expect(visibleBattleLogTail(t, 4)).toEqual(['ab', ''])
  })

  it('typing でないときの tick は同一参照', () => {
    const t = makeBattleLogTracker()
    expect(tickBattleLog(t, MS, MS)).toBe(t)
  })
})

describe('visibleBattleLogTail: 行数境界 (#755 QA)', () => {
  const done = () => skipBattleLog(syncBattleLog(makeBattleLogTracker(), ['a', 'b', 'c']))

  it('count = 長さ-1 / 長さ / 長さ+1', () => {
    expect(visibleBattleLogTail(done(), 2)).toEqual(['b', 'c'])
    expect(visibleBattleLogTail(done(), 3)).toEqual(['a', 'b', 'c'])
    expect(visibleBattleLogTail(done(), 4)).toEqual(['a', 'b', 'c'])
  })

  it('count 0 / 負は空配列', () => {
    expect(visibleBattleLogTail(done(), 0)).toEqual([])
    expect(visibleBattleLogTail(done(), -1)).toEqual([])
  })

  it('タイプ中に表示行数 (count) だけが変わっても、未開始行は出ず最終表示行は部分文字列のまま', () => {
    let t = syncBattleLog(makeBattleLogTracker(), ['aa', 'bb', 'cc'])
    t = tickBattleLog(t, MS * 3, MS) // aa 完了, bb 0 文字から開始（繰り越しなし）
    t = tickBattleLog(t, MS, MS)
    expect(visibleBattleLogTail(t, 4)).toEqual(['aa', 'b'])
    expect(visibleBattleLogTail(t, 1)).toEqual(['b'])
    expect(visibleBattleLogTail(t, 2)).toEqual(['aa', 'b'])
  })

  it('表示用の配列を書き換えても tracker は壊れない', () => {
    const t = done()
    visibleBattleLogTail(t, 3)[0] = 'zzz'
    expect(visibleBattleLogTail(t, 3)).toEqual(['a', 'b', 'c'])
  })
})

describe('normalizeBattleLogTypewriter: 追加 (#755 QA)', () => {
  it.each([
    ['On', 'on'],
    ['ON', 'on'],
    ['\ton\n', 'on'],
    ['onn', 'off'],
    ['o n', 'off'],
    ['true', 'off'],
    ['1', 'off'],
    ['OFF', 'off'],
  ] as const)('%j → %s', (raw, expected) => {
    expect(normalizeBattleLogTypewriter(raw)).toBe(expected)
  })

  it('文字列以外が実行時に紛れても off', () => {
    for (const v of [1, true, {}, []]) {
      expect(normalizeBattleLogTypewriter(v as never)).toBe('off')
    }
  })
})
