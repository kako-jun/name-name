import { describe, it, expect } from 'vitest'
import {
  parseRubyText,
  stripRubyMarkup,
  mapSentencesToRubyPreservedText,
  type RubyRun,
} from './ruby'

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

// ===== #448 バグ1: adv + sentence_per_page: true でルビ記法が消える修正の要 =====
//
// getAdvSentencePages は文境界判定を stripRubyMarkup 済みの plain text で行うが（`》` が
// SENTENCE_TRAILERS の一員のため生ルビ記法混在だと誤って文末トレーラに吸収されうる）、
// DialogBox.setDialog に渡す表示テキストにはルビ記法を保持したい。この橋渡しをする
// mapSentencesToRubyPreservedText 自体を純粋関数として直接縛る。
describe('mapSentencesToRubyPreservedText (#448)', () => {
  it('空配列の plainSentences は空配列を返す', () => {
    expect(mapSentencesToRubyPreservedText('猫が鳴く。', [])).toEqual([])
  })

  it('ルビ記法を含まない rawText はそのまま返す（高速パス）', () => {
    expect(
      mapSentencesToRubyPreservedText('猫が鳴く。犬も鳴く。', ['猫が鳴く。', '犬も鳴く。'])
    ).toEqual(['猫が鳴く。', '犬も鳴く。'])
  })

  it('1 文内のルビが保持される', () => {
    const raw = '漢字《かんじ》を読む。'
    const plainSentences = ['漢字を読む。']
    expect(mapSentencesToRubyPreservedText(raw, plainSentences)).toEqual(['漢字《かんじ》を読む。'])
  })

  it('複数文にまたがるルビがそれぞれの文へ正しく振り分けられる', () => {
    const raw = '今日《きょう》は晴天《せいてん》。明日《あした》は曇天《どんてん》。'
    const plainSentences = ['今日は晴天。', '明日は曇天。']
    expect(mapSentencesToRubyPreservedText(raw, plainSentences)).toEqual([
      '今日《きょう》は晴天《せいてん》。',
      '明日《あした》は曇天《どんてん》。',
    ])
  })

  it('implicit な CJK 自動連結ルビ（｜なし）は原文と同一のまま再構成される（base が全て CJK のため）', () => {
    const raw = '東京都庁《とうきょうとちょう》です。'
    const plainSentences = ['東京都庁です。']
    expect(mapSentencesToRubyPreservedText(raw, plainSentences)).toEqual([raw])
  })

  it('base が全て CJK なら｜による冗長な明示グルーピングは正規化で落ちる（意味は同一・stripRubyMarkup結果で確認）', () => {
    // 東京都庁（全て CJK）は implicit のままでも一意に base が決まるため、著者が念のため付けた
    // ｜ は再構成時に落ちる。バイト同一ではなくなるが、再パース結果（RubyRun）は同一で表示は変わらない。
    const raw = '｜東京都庁《とうきょうとちょう》です。'
    const plainSentences = ['東京都庁です。']
    const mapped = mapSentencesToRubyPreservedText(raw, plainSentences)
    expect(mapped).toEqual(['東京都庁《とうきょうとちょう》です。'])
    expect(stripRubyMarkup(mapped[0])).toBe(plainSentences[0])
  })

  it('｜ で明示グルーピングされた非 CJK base（英字等）も原文と同一のまま再構成される', () => {
    const raw = '｜go to《ごーとぅー》の意味です。'
    const plainSentences = ['go toの意味です。']
    expect(mapSentencesToRubyPreservedText(raw, plainSentences)).toEqual([raw])
  })

  it('マッピング崩れ（plainSentences が rawText と対応しない）は該当文をそのままフォールバックする（壊さない方針）', () => {
    // 意図的に不整合な plainSentences を渡す。安全確認（stripRubyMarkup(mapped)===sentence）に
    // 失敗するので、ルビなしの与えられた文字列そのものへ落ちる（クラッシュ・文字化けしない）。
    const mapped = mapSentencesToRubyPreservedText('猫《ねこ》。', ['まったく違う文'])
    expect(mapped).toEqual(['まったく違う文'])
  })
})
