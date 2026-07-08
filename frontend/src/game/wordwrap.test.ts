import { describe, it, expect, beforeAll, vi } from 'vitest'
import { wordwrap, wrapTextWithMeasure } from './wordwrap'

// Canvas measureText に依存する公開 API は mock / fallback で接続を確認し、
// 禁則ロジック本体は wrapTextWithMeasure に幅計測関数を注入して境界値を固定する。

const FONT = '22px sans-serif'
const len = (s: string) => s.length

describe('wordwrap', () => {
  // jsdom に CanvasRenderingContext2D がない場合のフォールバック確認
  let hasCanvas: boolean
  beforeAll(() => {
    const c = document.createElement('canvas')
    hasCanvas = c.getContext('2d') !== null
  })

  it('wordwrap は Canvas measureText 経由で pure 中核と同じ通常折り返しを通る', async () => {
    const mockCtx = {
      font: '',
      measureText: (s: string) => ({ width: s.length }),
    } as unknown as CanvasRenderingContext2D
    const getContext = vi
      .spyOn(HTMLCanvasElement.prototype, 'getContext')
      .mockImplementation(((contextId: string) =>
        contextId === '2d' ? mockCtx : null) as HTMLCanvasElement['getContext'])

    vi.resetModules()
    const { wordwrap: isolatedWordwrap } = await import('./wordwrap')

    expect(isolatedWordwrap('ABCDE', 4, FONT)).toEqual(['ABCD', 'E'])

    getContext.mockRestore()
    vi.resetModules()
  })

  it('空文字列は [""] を返す', () => {
    expect(wordwrap('', 300, FONT)).toEqual([''])
  })

  it('maxWidth <= 0 のときは元テキストをそのまま返す', () => {
    expect(wordwrap('こんにちは', 0, FONT)).toEqual(['こんにちは'])
    expect(wordwrap('こんにちは', -100, FONT)).toEqual(['こんにちは'])
  })

  it('Canvas がない環境ではテキストをそのまま返す', () => {
    if (hasCanvas) return // Canvas がある環境ではスキップ
    expect(wordwrap('テスト文字列', 100, FONT)).toEqual(['テスト文字列'])
  })

  it('十分な幅があれば1行のまま', () => {
    // maxWidth が非常に大きければ折り返しなし
    const result = wordwrap('短い', 10000, FONT)
    expect(result).toHaveLength(1)
    expect(result[0]).toBe('短い')
  })

  it('行頭禁止文字が行頭に来ないこと（禁則処理）', () => {
    // Canvas がない環境ではフォールバックになるのでスキップ
    if (!hasCanvas) return
    // 「。」が行頭に来ないことを確認
    const result = wordwrap('あいうえお。かきくけこ', 100, FONT)
    for (let i = 1; i < result.length; i++) {
      const firstChar = result[i][0]
      expect('、。，．・：；？！').not.toContain(firstChar)
    }
  })

  it('wrapTextWithMeasure は通常文字列を幅で折り返す', () => {
    expect(wrapTextWithMeasure('ABCDE', 4, len)).toEqual(['ABCD', 'E'])
  })

  it('wrapTextWithMeasure は境界-1の文字列を1行に保つ', () => {
    expect(wrapTextWithMeasure('AAA', 4, len)).toEqual(['AAA'])
  })

  it('wrapTextWithMeasure は境界ちょうどの文字列を1行に保つ', () => {
    expect(wrapTextWithMeasure('AAAA', 4, len)).toEqual(['AAAA'])
  })

  it('wrapTextWithMeasure は境界+1の文字列を折り返す', () => {
    expect(wrapTextWithMeasure('AAAAA', 4, len)).toEqual(['AAAA', 'A'])
  })

  it('wrapTextWithMeasure は空文字列で空行1つを返す', () => {
    expect(wrapTextWithMeasure('', 4, len)).toEqual([''])
  })

  it('wrapTextWithMeasure は maxWidth が 0 のとき元テキストを返す', () => {
    expect(wrapTextWithMeasure('abc', 0, len)).toEqual(['abc'])
  })

  it('wrapTextWithMeasure は maxWidth が負値のとき元テキストを返す', () => {
    expect(wrapTextWithMeasure('abc', -1, len)).toEqual(['abc'])
  })

  it('wrapTextWithMeasure は maxWidth=1 で空行を出さず1文字ずつ折り返す', () => {
    const result = wrapTextWithMeasure('ABC', 1, len)

    expect(result).toEqual(['A', 'B', 'C'])
    expect(result).not.toContain('')
  })

  it('wrapTextWithMeasure は maxWidth=2 で空行を出さず折り返す', () => {
    const result = wrapTextWithMeasure('ABCDE', 2, len)

    expect(result).toEqual(['AB', 'CD', 'E'])
    expect(result).not.toContain('')
  })

  it('行頭禁止文字を押し込んだ後、後続の通常文字まで幅超過行に連鎖させない', () => {
    const result = wrapTextWithMeasure('AAAA」ってBBBB', 4, len)

    expect(result).toEqual(['AAAA」', 'ってBB', 'BB'])
    expect(result[0].length).toBe(5)
    expect(result[0].endsWith('」')).toBe(true)
    expect(result[0]).not.toContain('っ')
    expect(result[0]).not.toContain('て')
  })

  it('閉じ括弧が幅内ちょうどでも、促音の押し込み後に通常文字を連鎖させない', () => {
    const result = wrapTextWithMeasure('AAAA」ってB', 5, len)

    expect(result).toEqual(['AAAA」っ', 'てB'])
    expect(result[0].length).toBe(6)
    expect(result[0].endsWith('っ')).toBe(true)
    expect(result[0]).not.toContain('て')
  })

  it('閉じ括弧の直前で通常折り返し済みなら、閉じ括弧+促音+通常文字を同じ行に収める', () => {
    const result = wrapTextWithMeasure('AAAAAA」ってB', 5, len)

    expect(result).toEqual(['AAAAA', 'A」ってB'])
  })

  it('行末禁止文字は次行へ送る', () => {
    const result = wrapTextWithMeasure('AAA「BC', 4, len)

    expect(result).toEqual(['AAA', '「BC'])
  })
})
