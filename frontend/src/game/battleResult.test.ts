import { describe, expect, it } from 'vitest'
import {
  RESULT_HOLD_DQ_MS,
  RESULT_HOLD_FF_MS,
  RESULT_GOLD_UNIT,
  RESULT_MESSAGE_STEP_MS,
  RESULT_SKIP_GUARD_MS,
  RESULT_TEXT,
  RESULT_VICTORY_FLIP_MS,
  advanceResultElapsed,
  buildResultMessages,
  canSkipResultHold,
  isResultHoldDone,
  isVictoryFlipOn,
  resultHoldMs,
  resultMessageIndex,
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
    expect(windowWord('ファイア', '1ギル てにいれた')).toBe('ファイア')
    expect(windowWord(null, '1ギル てにいれた')).toBe('1ギル てにいれた')
    expect(resultMessageText('victory')).toBeNull()
    expect(windowWord(null, resultMessageText('defeat'))).toBe('ぜんめつ…')
    expect(windowWord(null, null)).toBeNull()
  })
})

describe('勝利リザルトのメッセージ (#1039)', () => {
  const base = { gold: 0, exp: 0, learnedSpellNames: [], lootNames: [] }

  it('順: お金 → 経験値 → 覚えた呪文 → 戦利品（最後）', () => {
    const m = buildResultMessages({
      gold: 12,
      exp: 34,
      learnedSpellNames: ['ファイア', 'ブリザド'],
      lootNames: ['ポーション', 'エリクサー'],
    })
    expect(m).toEqual([
      RESULT_TEXT.gold(12),
      RESULT_TEXT.exp(34),
      RESULT_TEXT.learned('ファイア'),
      RESULT_TEXT.learned('ブリザド'),
      RESULT_TEXT.loot('ポーション'),
      RESULT_TEXT.loot('エリクサー'),
    ])
    expect(m[m.length - 1]).toBe(RESULT_TEXT.loot('エリクサー'))
  })

  it('0 の行は出さない。全部 0 なら空配列', () => {
    expect(buildResultMessages(base)).toEqual([])
    expect(buildResultMessages({ ...base, gold: 5 })).toEqual([RESULT_TEXT.gold(5)])
    expect(buildResultMessages({ ...base, exp: 5, lootNames: ['x'] })).toEqual([
      RESULT_TEXT.exp(5),
      RESULT_TEXT.loot('x'),
    ])
  })

  it('語の区切りは半角スペースのみ（全角スペース U+3000 を含まない）', () => {
    const all = buildResultMessages({
      gold: 1,
      exp: 1,
      learnedSpellNames: ['ファイア'],
      lootNames: ['ポーション'],
    })
    for (const line of [...all, RESULT_TEXT.defeat]) expect(line).not.toContain('　')
    expect(RESULT_TEXT.gold(1)).toBe(`1${RESULT_GOLD_UNIT} てにいれた`)
    expect(RESULT_TEXT.exp(7)).toBe('7 けいけんち かくとく')
    expect(RESULT_TEXT.loot('ポーション')).toBe('ポーションを てにいれた')
    expect(RESULT_TEXT.learned('ファイア')).toBe('ファイアをおぼえた！')
  })

  it('勝利に固定の「しょうり！」は無い。全滅の「ぜんめつ…」は残る', () => {
    expect(resultMessageText('victory')).toBeNull()
    expect(resultMessageText('defeat')).toBe('ぜんめつ…')
    expect(windowWord(null, resultMessageText('victory'))).toBeNull()
    expect(windowWord(null, resultMessageText('defeat'))).toBe('ぜんめつ…')
  })

  it('resultHoldMs: dq は件数に関わらず不変。ff は最低 1500ms で、件数 × 1 件の時間まで伸びる', () => {
    expect(resultHoldMs('dq', 0)).toBe(RESULT_HOLD_DQ_MS)
    expect(resultHoldMs('dq', 99)).toBe(RESULT_HOLD_DQ_MS)
    expect(resultHoldMs('ff', 0)).toBe(RESULT_HOLD_FF_MS)
    expect(resultHoldMs('ff', 1)).toBe(RESULT_HOLD_FF_MS)
    const n = Math.ceil(RESULT_HOLD_FF_MS / RESULT_MESSAGE_STEP_MS)
    expect(resultHoldMs('ff', n)).toBe(Math.max(RESULT_HOLD_FF_MS, n * RESULT_MESSAGE_STEP_MS))
    expect(resultHoldMs('ff', 10)).toBe(10 * RESULT_MESSAGE_STEP_MS)
    expect(resultHoldMs('ff', 11)).toBeGreaterThan(resultHoldMs('ff', 10))
  })

  it('resultMessageIndex: 0 件は -1、境界で次へ、最後の件で止まり、負の経過は 0', () => {
    expect(resultMessageIndex(0, 0)).toBe(-1)
    expect(resultMessageIndex(99999, 0)).toBe(-1)
    expect(resultMessageIndex(0, 3)).toBe(0)
    expect(resultMessageIndex(RESULT_MESSAGE_STEP_MS - 1, 3)).toBe(0)
    expect(resultMessageIndex(RESULT_MESSAGE_STEP_MS, 3)).toBe(1)
    expect(resultMessageIndex(RESULT_MESSAGE_STEP_MS * 2, 3)).toBe(2)
    expect(resultMessageIndex(RESULT_MESSAGE_STEP_MS * 50, 3)).toBe(2)
    expect(resultMessageIndex(-100, 3)).toBe(0)
  })

  it('isVictoryFlipOn: 最初は victory、間隔ごとに交互', () => {
    expect(isVictoryFlipOn(0)).toBe(true)
    expect(isVictoryFlipOn(RESULT_VICTORY_FLIP_MS - 1)).toBe(true)
    expect(isVictoryFlipOn(RESULT_VICTORY_FLIP_MS)).toBe(false)
    expect(isVictoryFlipOn(RESULT_VICTORY_FLIP_MS * 2 - 1)).toBe(false)
    expect(isVictoryFlipOn(RESULT_VICTORY_FLIP_MS * 2)).toBe(true)
    expect(isVictoryFlipOn(-5)).toBe(true)
  })
})
