import { describe, it, expect } from 'vitest'
import {
  isTypingActive,
  makeInitialTypewriterState,
  skipTypewriter,
  startTypewriter,
  tickTypewriter,
  visibleText,
} from './typewriter'

describe('typewriter pure helpers', () => {
  describe('makeInitialTypewriterState / startTypewriter', () => {
    it('initial state は空文字 + count 0', () => {
      const s = makeInitialTypewriterState()
      expect(s.fullText).toBe('')
      expect(s.displayedCharCount).toBe(0)
      expect(isTypingActive(s)).toBe(false)
    })

    it('startTypewriter で count を 0 に戻す', () => {
      const s = startTypewriter('こんにちは')
      expect(s.fullText).toBe('こんにちは')
      expect(s.displayedCharCount).toBe(0)
      expect(s.acc).toBe(0)
      expect(isTypingActive(s)).toBe(true)
    })
  })

  describe('tickTypewriter', () => {
    it('msPerChar=30 で deltaMS=15 なら進まない (acc に貯まる)', () => {
      const s0 = startTypewriter('ABCDE')
      const s1 = tickTypewriter(s0, 15, 30)
      expect(s1.displayedCharCount).toBe(0)
      expect(s1.acc).toBe(15)
    })

    it('acc が msPerChar を超えたら 1 文字進む', () => {
      const s0 = { fullText: 'ABCDE', displayedCharCount: 0, acc: 15 }
      const s1 = tickTypewriter(s0, 20, 30)
      expect(s1.displayedCharCount).toBe(1)
      expect(s1.acc).toBe(5) // 35 - 30 = 5 繰り越し
    })

    it('1 フレームで複数文字進む（重い tick）', () => {
      const s0 = startTypewriter('ABCDE')
      const s1 = tickTypewriter(s0, 100, 30) // 100/30 = 3 文字
      expect(s1.displayedCharCount).toBe(3)
      expect(s1.acc).toBe(10)
    })

    it('fullText.length を超えない', () => {
      const s0 = startTypewriter('ABC')
      const s1 = tickTypewriter(s0, 10000, 30)
      expect(s1.displayedCharCount).toBe(3)
      expect(isTypingActive(s1)).toBe(false)
    })

    it('msPerChar=0 で即座に最後まで進む', () => {
      const s0 = startTypewriter('こんにちは')
      const s1 = tickTypewriter(s0, 1, 0)
      expect(s1.displayedCharCount).toBe(5)
      expect(s1.acc).toBe(0)
    })

    it('msPerChar=負 でも即時完了', () => {
      const s0 = startTypewriter('ABCDE')
      const s1 = tickTypewriter(s0, 1, -10)
      expect(s1.displayedCharCount).toBe(5)
    })

    it('既に完了済みなら state を変えない', () => {
      const s0 = { fullText: 'ABC', displayedCharCount: 3, acc: 7 }
      const s1 = tickTypewriter(s0, 100, 30)
      expect(s1).toBe(s0) // 同一参照（早期 return）
    })

    it('deltaMS が負でも壊れない (acc を維持)', () => {
      const s0 = { fullText: 'ABCDE', displayedCharCount: 1, acc: 12 }
      const s1 = tickTypewriter(s0, -100, 30)
      expect(s1.displayedCharCount).toBe(1)
      expect(s1.acc).toBe(12) // 元の acc を捨てない
    })

    it('deltaMS が NaN でも壊れない', () => {
      const s0 = startTypewriter('ABC')
      const s1 = tickTypewriter(s0, NaN, 30)
      expect(s1.displayedCharCount).toBe(0)
      expect(s1.acc).toBe(0)
    })

    it('msPerChar が NaN なら即時完了 (>0 でない値は完了扱い)', () => {
      const s0 = startTypewriter('ABCDE')
      const s1 = tickTypewriter(s0, 1, NaN)
      expect(s1.displayedCharCount).toBe(5)
    })

    it('msPerChar 超大値 + 通常 deltaMS なら 1 文字も進まない', () => {
      const s0 = startTypewriter('ABC')
      const s1 = tickTypewriter(s0, 16, 1_000_000)
      expect(s1.displayedCharCount).toBe(0)
      expect(s1.acc).toBe(16)
    })
  })

  describe('skipTypewriter', () => {
    it('表示中なら最後まで飛ばす', () => {
      const s0 = startTypewriter('こんにちは')
      const s1 = skipTypewriter(s0)
      expect(s1.displayedCharCount).toBe(5)
      expect(isTypingActive(s1)).toBe(false)
    })

    it('完了済みなら何もしない (同一参照)', () => {
      const s0 = { fullText: 'ABC', displayedCharCount: 3, acc: 0 }
      const s1 = skipTypewriter(s0)
      expect(s1).toBe(s0)
    })

    it('skip 連打しても state は安定 (2 回目以降は同一参照)', () => {
      const s0 = startTypewriter('ABCDE')
      const s1 = skipTypewriter(s0)
      const s2 = skipTypewriter(s1)
      const s3 = skipTypewriter(s2)
      expect(s2).toBe(s1)
      expect(s3).toBe(s1)
    })

    it('空文字でも壊れない', () => {
      const s0 = startTypewriter('')
      const s1 = skipTypewriter(s0)
      expect(s1.displayedCharCount).toBe(0)
    })
  })

  describe('visibleText', () => {
    it('displayedCharCount までの substring を返す', () => {
      const s = { fullText: 'こんにちは', displayedCharCount: 3, acc: 0 }
      expect(visibleText(s)).toBe('こんに')
    })

    it('改行 (\\n) も 1 文字としてカウント', () => {
      const s = { fullText: 'AB\nCD', displayedCharCount: 3, acc: 0 }
      expect(visibleText(s)).toBe('AB\n')
    })
  })

  describe('regression #137 「カノソ方式 = 一瞬表示」廃止', () => {
    it('30ms/char で 5 文字なら累計 150ms で完了', () => {
      let s = startTypewriter('ABCDE')
      // 5 frames of 30ms each
      for (let i = 0; i < 5; i++) {
        s = tickTypewriter(s, 30, 30)
      }
      expect(s.displayedCharCount).toBe(5)
      expect(visibleText(s)).toBe('ABCDE')
    })
  })
})
