import { describe, it, expect, beforeAll } from 'vitest'
import { wordwrap } from './wordwrap'

// jsdom 環境では canvas.getContext('2d') が null を返すため、
// measureText に依存するテストは制約がある。
// ここでは getContext が null の場合のフォールバック（テキストそのまま返却）と、
// 空文字列・基本的な境界値をテストする。

const FONT = '22px sans-serif'

describe('wordwrap', () => {
  // jsdom に CanvasRenderingContext2D がない場合のフォールバック確認
  let hasCanvas: boolean
  beforeAll(() => {
    const c = document.createElement('canvas')
    hasCanvas = c.getContext('2d') !== null
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
})
