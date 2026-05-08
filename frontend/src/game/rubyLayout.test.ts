import { describe, it, expect } from 'vitest'
import { computeRubyPlacements } from './rubyLayout'
import type { RubyRun } from './ruby'

describe('computeRubyPlacements', () => {
  it('plain only runs はルビなし', () => {
    const runs: RubyRun[] = [{ base: 'こんにちは', ruby: null }]
    expect(computeRubyPlacements(runs, ['こんにちは'])).toEqual([])
  })

  it('単一行内の単一ルビ', () => {
    const runs: RubyRun[] = [
      { base: '田中', ruby: 'たなか' },
      { base: 'さん', ruby: null },
    ]
    const placements = computeRubyPlacements(runs, ['田中さん'])
    expect(placements).toHaveLength(1)
    expect(placements[0]).toMatchObject({
      ruby: 'たなか',
      base: '田中',
      lineIndex: 0,
      charStartInLine: 0,
      charEndInLine: 2,
      // base end = plain offset 2、行頭までの改行数 0 → typewriter offset 2
      revealAt: 2,
    })
  })

  it('行頭以外のルビ', () => {
    const runs: RubyRun[] = [
      { base: 'これは', ruby: null },
      { base: '漢字', ruby: 'かんじ' },
      { base: 'です', ruby: null },
    ]
    const placements = computeRubyPlacements(runs, ['これは漢字です'])
    expect(placements).toHaveLength(1)
    expect(placements[0]).toMatchObject({
      ruby: 'かんじ',
      base: '漢字',
      lineIndex: 0,
      charStartInLine: 3,
      charEndInLine: 5,
      revealAt: 5,
    })
  })

  it('複数ルビ', () => {
    const runs: RubyRun[] = [
      { base: '田中', ruby: 'たなか' },
      { base: 'と', ruby: null },
      { base: '山田', ruby: 'やまだ' },
    ]
    const placements = computeRubyPlacements(runs, ['田中と山田'])
    expect(placements).toHaveLength(2)
    expect(placements[0]).toMatchObject({
      ruby: 'たなか',
      lineIndex: 0,
      charStartInLine: 0,
      charEndInLine: 2,
      revealAt: 2,
    })
    expect(placements[1]).toMatchObject({
      ruby: 'やまだ',
      lineIndex: 0,
      charStartInLine: 3,
      charEndInLine: 5,
      revealAt: 5,
    })
  })

  it('複数行、2 行目のルビ（typewriter offset に改行を加算）', () => {
    const runs: RubyRun[] = [
      { base: '前文', ruby: null },
      { base: '改行後', ruby: null },
      { base: '漢字', ruby: 'かんじ' },
    ]
    // wordwrap が ['前文', '改行後漢字'] に分割した想定
    const lines = ['前文', '改行後漢字']
    const placements = computeRubyPlacements(runs, lines)
    expect(placements).toHaveLength(1)
    expect(placements[0]).toMatchObject({
      ruby: 'かんじ',
      base: '漢字',
      lineIndex: 1,
      charStartInLine: 3, // '改行後' の後ろ
      charEndInLine: 5,
      // plain offset: 2(前文) + 3(改行後) + 2(漢字) = 7
      // typewriter offset: 7 + 1(改行) = 8
      revealAt: 8,
    })
  })

  it('base が行末ぴったりに収まる場合', () => {
    const runs: RubyRun[] = [
      { base: '漢字', ruby: 'かんじ' },
      { base: '次行', ruby: null },
    ]
    // lines = ['漢字', '次行'] と仮定
    const placements = computeRubyPlacements(runs, ['漢字', '次行'])
    expect(placements).toHaveLength(1)
    expect(placements[0]).toMatchObject({
      lineIndex: 0,
      charStartInLine: 0,
      charEndInLine: 2,
      revealAt: 2,
    })
  })

  it('空の runs は空配列', () => {
    expect(computeRubyPlacements([], [''])).toEqual([])
  })
})
