import { describe, expect, it } from 'vitest'
import {
  BATTLE_LOG_MS_PER_CHAR,
  type BattleLogTracker,
  isBattleLogTyping,
  makeBattleLogTracker,
  normalizeBattleLogTypewriter,
  skipBattleLog,
  syncBattleLog,
  tickBattleLog,
  visibleBattleLogTail,
} from './battleLogTypewriter'

const MS = BATTLE_LOG_MS_PER_CHAR

/**
 * エンジン側の `logTotal` を模して syncBattleLog を呼ぶ。`appended` は前回から積まれた行数
 * （省略時は log の長さの増分＝先頭切り捨てなしの追記）。
 */
function sync(t: BattleLogTracker, log: readonly string[], appended = log.length - t.seen.length) {
  return syncBattleLog(t, log, t.total + appended)
}

describe('normalizeBattleLogTypewriter', () => {
  it("'on' のみ on。未指定・空・未知値は off", () => {
    expect(normalizeBattleLogTypewriter('on')).toBe('on')
    expect(normalizeBattleLogTypewriter(' ON ')).toBe('on')
    for (const v of [undefined, null, '', 'off', 'foo']) {
      expect(normalizeBattleLogTypewriter(v)).toBe('off')
    }
  })
})

describe('BattleLogTracker', () => {
  it('新規行だけをタイプし、表示済みの行は即時表示', () => {
    let t = sync(makeBattleLogTracker(), ['aa'])
    t = skipBattleLog(t)
    t = sync(t, ['aa', 'bcd'])
    expect(visibleBattleLogTail(t, 4)).toEqual(['aa', ''])
    t = tickBattleLog(t, MS * 2, MS)
    expect(visibleBattleLogTail(t, 4)).toEqual(['aa', 'bc'])
    t = tickBattleLog(t, MS, MS)
    expect(visibleBattleLogTail(t, 4)).toEqual(['aa', 'bcd'])
    expect(isBattleLogTyping(t)).toBe(false)
  })

  it('複数行が一度に積まれたら順にタイプし、未開始行は出さない', () => {
    let t = sync(makeBattleLogTracker(), ['a', 'b'])
    expect(visibleBattleLogTail(t, 4)).toEqual([''])
    t = tickBattleLog(t, MS, MS)
    expect(visibleBattleLogTail(t, 4)).toEqual(['a', ''])
    expect(isBattleLogTyping(t)).toBe(true)
  })

  it('ログが流れても（先頭切り捨て）タイプ中の行が別の行に化けない', () => {
    let t = sync(makeBattleLogTracker(), ['a', 'b', 'c'])
    t = skipBattleLog(t)
    t = sync(t, ['a', 'b', 'c', 'xyz'])
    t = tickBattleLog(t, MS, MS)
    t = sync(t, ['b', 'c', 'xyz', 'w'], 1) // 先頭 a が捨てられ w が追加
    expect(visibleBattleLogTail(t, 4)).toEqual(['b', 'c', 'x'])
    t = tickBattleLog(t, MS * 2, MS)
    expect(visibleBattleLogTail(t, 4)).toEqual(['b', 'c', 'xyz', ''])
  })

  it('skip で待ち行も含め全文表示し、以後 typing は終わる', () => {
    let t = sync(makeBattleLogTracker(), ['abc', 'def'])
    t = skipBattleLog(t)
    expect(visibleBattleLogTail(t, 4)).toEqual(['abc', 'def'])
    expect(isBattleLogTyping(t)).toBe(false)
  })
})

describe('syncBattleLog: logTotal 差分による新規行数 (#755)', () => {
  const lines = (n: number, from = 0) => Array.from({ length: n }, (_, i) => `l${from + i}`)

  it('prev が空・log が空・差分 0', () => {
    expect(isBattleLogTyping(sync(makeBattleLogTracker(), []))).toBe(false)
    const t = sync(makeBattleLogTracker(), ['a', 'b'])
    expect(t.hidden).toBe(1) // 1 行目はタイプ開始済み、2 行目が待ち
    expect(sync(t, ['a', 'b'], 0).hidden).toBe(1) // 変化なしなら待ち行を増やさない
  })

  it('先頭が 1 件捨てられ 1 件追記（30 件上限の定常状態）で新規 1 行', () => {
    let t = skipBattleLog(sync(makeBattleLogTracker(), lines(30)))
    t = sync(t, [...lines(30).slice(1), 'new'], 1)
    expect(t.hidden).toBe(0)
    expect(t.typing).not.toBeNull()
    expect(visibleBattleLogTail(t, 1)).toEqual([''])
  })

  it('先頭が 3 件捨てられ 3 件追記で新規 3 行', () => {
    let t = skipBattleLog(sync(makeBattleLogTracker(), lines(30)))
    t = sync(t, [...lines(30).slice(3), 'n1', 'n2', 'n3'], 3)
    // 1 行目がタイプ開始済みで、残り 2 行が待ち
    expect(t.typing).not.toBeNull()
    expect(t.hidden).toBe(2)
  })

  it('同一文面が続いても数え違えない: 全行同一で 1 件捨て 1 件追記でもタイプされる', () => {
    let t = skipBattleLog(sync(makeBattleLogTracker(), ['a', 'a', 'a']))
    t = sync(t, ['a', 'a', 'a'], 1)
    expect(isBattleLogTyping(t)).toBe(true)
    expect(visibleBattleLogTail(t, 4)).toEqual(['a', 'a', ''])
  })

  it('同じ 4 行のターンが上限到達後に何度続いても毎ターンタイプされ続ける', () => {
    const turn = [
      'A の こうげき！',
      'B に 1 の ダメージ！',
      'B の こうげき！',
      'A は 1 の ダメージを うけた！',
    ]
    let log: string[] = ['あらわれた！']
    let total = 1
    let t = syncBattleLog(makeBattleLogTracker(), log, total)
    for (let n = 0; n < 40; n++) {
      t = skipBattleLog(t)
      log = [...log, ...turn].slice(-30)
      total += turn.length
      t = syncBattleLog(t, log, total)
      expect(isBattleLogTyping(t)).toBe(true) // 上限到達後（n >= 7 付近）も止まらない
      expect(t.hidden).toBe(turn.length - 1)
    }
  })

  it('新規行数がログ長を超えても見える範囲（ログ全行）に丸める', () => {
    let t = skipBattleLog(sync(makeBattleLogTracker(), lines(3)))
    t = syncBattleLog(t, lines(5, 100), t.total + 500)
    expect(t.hidden + (t.typing === null ? 0 : 1)).toBe(5)
    expect(t.hidden).toBeLessThanOrEqual(5)
  })

  it('logTotal が前回より小さい（別の戦闘に差し替わった）なら全行を新規とみなす', () => {
    let t = skipBattleLog(syncBattleLog(makeBattleLogTracker(), lines(30), 100))
    t = syncBattleLog(t, ['x', 'y'], 2)
    expect(t.hidden + (t.typing === null ? 0 : 1)).toBe(2)
  })

  it('入力配列を破壊せず、保持する seen は別配列', () => {
    const log = ['a', 'b']
    const t = sync(makeBattleLogTracker(), log)
    expect(log).toEqual(['a', 'b'])
    expect(t.seen).not.toBe(log)
    log.push('c')
    expect(t.seen).toEqual(['a', 'b'])
  })
})

describe('BattleLogTracker: 追加観点 (#755 QA)', () => {
  it('空ログを取り込んでも何も出ず、typing でもない', () => {
    const t = sync(makeBattleLogTracker(), [])
    expect(visibleBattleLogTail(t, 4)).toEqual([])
    expect(isBattleLogTyping(t)).toBe(false)
  })

  it('同じログを再 sync してもタイプ状態が巻き戻らない（redraw 相当）', () => {
    let t = sync(makeBattleLogTracker(), ['abc'])
    t = tickBattleLog(t, MS, MS)
    t = sync(t, ['abc'])
    t = sync(t, ['abc'])
    expect(visibleBattleLogTail(t, 4)).toEqual(['a'])
    expect(isBattleLogTyping(t)).toBe(true)
  })

  it('空文字の行は即完了で、後続のタイプを塞がない', () => {
    let t = sync(makeBattleLogTracker(), ['', 'ab'])
    expect(visibleBattleLogTail(t, 4)).toEqual(['', ''])
    expect(isBattleLogTyping(t)).toBe(true)
    t = tickBattleLog(t, MS, MS)
    expect(visibleBattleLogTail(t, 4)).toEqual(['', 'a'])
  })

  it('複数行を上から順に: 前の行が終わるまで次の行は 0 文字のまま', () => {
    let t = sync(makeBattleLogTracker(), ['ab', 'cd'])
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
    let t = sync(makeBattleLogTracker(), base)
    t = skipBattleLog(t)
    let log = [...base.slice(1), 'hello']
    t = sync(t, log, 1)
    t = tickBattleLog(t, MS * 2, MS)
    expect(visibleBattleLogTail(t, 1)).toEqual(['he'])
    // タイプ中にさらに 2 件積まれて先頭が 2 件捨てられる
    log = [...log.slice(2), 'x', 'y']
    t = sync(t, log, 2)
    expect(visibleBattleLogTail(t, 3)).toEqual(['l28', 'l29', 'he'])
    t = tickBattleLog(t, MS * 3, MS)
    expect(visibleBattleLogTail(t, 3)).toEqual(['l29', 'hello', ''])
  })

  it('タイプ中の行自体が一括置換で流れ去っても例外なく次へ進む', () => {
    let t = sync(makeBattleLogTracker(), ['aaa', 'bbb', 'ccc'])
    t = sync(t, ['ddd', 'eee', 'fff'], 3)
    expect(visibleBattleLogTail(t, 4)).toEqual([''])
    t = tickBattleLog(t, MS, MS)
    expect(visibleBattleLogTail(t, 4)).toEqual(['d'])
    expect(isBattleLogTyping(t)).toBe(true)
  })

  it('skip は typing でも待ちでもなければ同一参照を返す・二重 skip も安全', () => {
    const t0 = makeBattleLogTracker()
    expect(skipBattleLog(t0)).toBe(t0)
    const t1 = skipBattleLog(sync(t0, ['abc']))
    expect(skipBattleLog(t1)).toBe(t1)
  })

  it('skip 後に tick しても何も変わらない', () => {
    const t = skipBattleLog(sync(makeBattleLogTracker(), ['abc']))
    expect(tickBattleLog(t, MS, MS)).toBe(t)
  })

  it('skip 後に新しい行が積まれればまたタイプされる', () => {
    let t = skipBattleLog(sync(makeBattleLogTracker(), ['abc']))
    t = sync(t, ['abc', 'de'])
    expect(visibleBattleLogTail(t, 4)).toEqual(['abc', ''])
    expect(isBattleLogTyping(t)).toBe(true)
  })
})

describe('tickBattleLog: deltaMS / msPerChar 境界 (#755 QA)', () => {
  const typing = () => sync(makeBattleLogTracker(), ['abcd'])

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
    let t = sync(makeBattleLogTracker(), ['ab', 'cd'])
    t = tickBattleLog(t, 1, 0)
    expect(visibleBattleLogTail(t, 4)).toEqual(['ab', ''])
    t = tickBattleLog(t, 1, 0)
    expect(visibleBattleLogTail(t, 4)).toEqual(['ab', 'cd'])
  })

  it('巨大 deltaMS でも行末で止まり、次行は繰り越しなしで 0 文字から', () => {
    let t = sync(makeBattleLogTracker(), ['ab', 'cd'])
    t = tickBattleLog(t, MS * 1000, MS)
    expect(visibleBattleLogTail(t, 4)).toEqual(['ab', ''])
  })

  it('typing でないときの tick は同一参照', () => {
    const t = makeBattleLogTracker()
    expect(tickBattleLog(t, MS, MS)).toBe(t)
  })
})

describe('visibleBattleLogTail: 行数境界 (#755 QA)', () => {
  const done = () => skipBattleLog(sync(makeBattleLogTracker(), ['a', 'b', 'c']))

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
    let t = sync(makeBattleLogTracker(), ['aa', 'bb', 'cc'])
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
