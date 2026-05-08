import { describe, it, expect } from 'vitest'
import { parseRubyText, stripRubyMarkup, type RubyRun } from './ruby'

const plain = (s: string): RubyRun => ({ base: s, ruby: null })
const ruby = (base: string, r: string): RubyRun => ({ base, ruby: r })

describe('parseRubyText', () => {
  it('空文字列は空配列', () => {
    expect(parseRubyText('')).toEqual([])
  })

  it('ルビ記号を含まない plain な行は単一 run', () => {
    expect(parseRubyText('こんにちは、世界。')).toEqual([plain('こんにちは、世界。')])
  })

  it('単純な漢字《かんじ》', () => {
    expect(parseRubyText('漢字《かんじ》')).toEqual([ruby('漢字', 'かんじ')])
  })

  it('｜ によるグルーピング（複数文字 base）', () => {
    expect(parseRubyText('｜美少女《びしょうじょ》')).toEqual([ruby('美少女', 'びしょうじょ')])
  })

  it('｜ で漢字以外の文字も base に含められる', () => {
    expect(parseRubyText('｜go to《ごーとぅー》')).toEqual([ruby('go to', 'ごーとぅー')])
  })

  it('複数のルビと plain が混在', () => {
    expect(parseRubyText('田中《たなか》さんは漢字《かんじ》を読む')).toEqual([
      ruby('田中', 'たなか'),
      plain('さんは'),
      ruby('漢字', 'かんじ'),
      plain('を読む'),
    ])
  })

  it('CJK 拡張 A の文字も base に含まれる', () => {
    // 拡張 A 例: 㐀 (U+3400)
    expect(parseRubyText('㐀《あ》')).toEqual([ruby('㐀', 'あ')])
  })

  it('行頭・行末のルビ', () => {
    expect(parseRubyText('漢字《かんじ》ですね')).toEqual([ruby('漢字', 'かんじ'), plain('ですね')])
    expect(parseRubyText('それは漢字《かんじ》')).toEqual([plain('それは'), ruby('漢字', 'かんじ')])
  })

  it('閉じ忘れ `漢字《かんじ` は plain として透過', () => {
    expect(parseRubyText('漢字《かんじ')).toEqual([plain('漢字《かんじ')])
  })

  it('開きなし `かんじ》` は plain として透過', () => {
    expect(parseRubyText('かんじ》')).toEqual([plain('かんじ》')])
  })

  it('空ルビ `漢字《》` は base のみ plain として残す', () => {
    expect(parseRubyText('漢字《》')).toEqual([plain('漢字')])
  })

  it('｜直後に《で base 空 → plain 透過（壊さない）', () => {
    // ｜《...》 は base が空なので不正記法として透過する
    const result = parseRubyText('｜《よみ》')
    // ｜《よみ》がそのまま plain として残る
    expect(result).toEqual([plain('｜《よみ》')])
  })

  it('《》 直前に漢字も ｜ も無いと plain 透過', () => {
    expect(parseRubyText('abc《xyz》')).toEqual([plain('abc《xyz》')])
  })

  it('｜ より後に漢字以外が混じっても OK', () => {
    expect(parseRubyText('｜A1漢《えーいちかん》')).toEqual([ruby('A1漢', 'えーいちかん')])
  })

  it('複数の ｜ が混在しても直近の ｜ が優先される', () => {
    // 1 つ目の ｜ は plain として残る
    expect(parseRubyText('｜abc｜def《よみ》')).toEqual([plain('｜abc'), ruby('def', 'よみ')])
  })

  it('連続する漢字の途中までしか base にしない（｜なし時）', () => {
    // 「これは漢字《かんじ》」→ 直前の連続漢字「漢字」のみが base、それ以前の「これは」は plain
    expect(parseRubyText('これは漢字《かんじ》だ')).toEqual([
      plain('これは'),
      ruby('漢字', 'かんじ'),
      plain('だ'),
    ])
  })

  it('ひらがなを挟むと base は《》直前の漢字塊のみ', () => {
    expect(parseRubyText('東京の漢字《かんじ》表記')).toEqual([
      plain('東京の'),
      ruby('漢字', 'かんじ'),
      plain('表記'),
    ])
  })
})

describe('stripRubyMarkup', () => {
  it('plain 行はそのまま返す', () => {
    expect(stripRubyMarkup('こんにちは')).toBe('こんにちは')
  })

  it('《...》 を取り除く', () => {
    expect(stripRubyMarkup('漢字《かんじ》です')).toBe('漢字です')
  })

  it('｜ も取り除く', () => {
    expect(stripRubyMarkup('｜美少女《びしょうじょ》')).toBe('美少女')
  })

  it('複数ルビ', () => {
    expect(stripRubyMarkup('田中《たなか》と山田《やまだ》')).toBe('田中と山田')
  })

  it('閉じ忘れは plain として透過するため記号も残る', () => {
    expect(stripRubyMarkup('漢字《かんじ')).toBe('漢字《かんじ')
  })
})

describe('parseRubyText 追加カバレッジ (#148 R1 N8)', () => {
  it('連続するルビ (間に plain がない) も正しく分解される', () => {
    const runs = parseRubyText('漢字《かんじ》漢字《かんじ》')
    expect(runs).toEqual([
      { base: '漢字', ruby: 'かんじ' },
      { base: '漢字', ruby: 'かんじ' },
    ])
  })

  it('《》 直前がひらがな単独だと base 候補にならず plain 透過する', () => {
    // U+3042 'あ' は漢字レンジ外のため自動連結しない。`｜` が無いので base 不在で plain 化
    const runs = parseRubyText('あ《ア》')
    expect(runs.map((r) => r.base).join('')).toBe('あ《ア》')
    expect(runs.every((r) => r.ruby === null)).toBe(true)
  })

  it('｜ で明示すればひらがなも base にできる', () => {
    const runs = parseRubyText('｜あいうえお《アイウエオ》')
    expect(runs).toEqual([{ base: 'あいうえお', ruby: 'アイウエオ' }])
  })
})
