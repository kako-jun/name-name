import { describe, it, expect } from 'vitest'
import {
  isTypingActive,
  makeInitialTypewriterState,
  skipTypewriter,
  startTypewriter,
  startTypewriterFrom,
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

  // ===== startTypewriterFrom 境界値 (#292 文単位送り・既出プレフィックス即時表示) =====
  // 先頭 fromCount 文字を「既表示」扱いにし、その分だけ displayedCharCount を進めて開始する。
  // fromCount は [0, fullText.length] にクランプ（負→0・超過→length＝即完了）し、
  // 非有限（NaN/Infinity）は NaN→0 に倒す。小数は floor。acc は常に 0。
  describe('startTypewriterFrom (#292)', () => {
    const TEXT = 'ABCDE' // length 5

    it('fromCount=0 は startTypewriter と等価（先頭から全部タイプ）', () => {
      const s = startTypewriterFrom(TEXT, 0)
      expect(s.displayedCharCount).toBe(0)
      expect(s.acc).toBe(0)
      expect(visibleText(s)).toBe('')
      expect(isTypingActive(s)).toBe(true)
    })

    it('fromCount が中間: その分は即時表示、残りだけタイプ対象に残る', () => {
      const s = startTypewriterFrom(TEXT, 2)
      expect(s.displayedCharCount).toBe(2)
      expect(s.acc).toBe(0)
      expect(visibleText(s)).toBe('AB') // 既出分は即時表示
      expect(isTypingActive(s)).toBe(true) // 残り 'CDE' をタイプ
    })

    it('fromCount == length: 全文が既出（即完了・タイプするものは無い）', () => {
      const s = startTypewriterFrom(TEXT, TEXT.length)
      expect(s.displayedCharCount).toBe(TEXT.length)
      expect(visibleText(s)).toBe(TEXT)
      expect(isTypingActive(s)).toBe(false)
    })

    it('fromCount > length: length にクランプ（即完了）', () => {
      const s = startTypewriterFrom(TEXT, 999)
      expect(s.displayedCharCount).toBe(TEXT.length)
      expect(isTypingActive(s)).toBe(false)
    })

    it('fromCount 負値: 0 にクランプ（先頭から全部タイプ）', () => {
      const s = startTypewriterFrom(TEXT, -3)
      expect(s.displayedCharCount).toBe(0)
      expect(visibleText(s)).toBe('')
      expect(isTypingActive(s)).toBe(true)
    })

    it('fromCount NaN: 0 に倒す（Math.min/max を素通りするので isFinite で防御）', () => {
      const s = startTypewriterFrom(TEXT, NaN)
      expect(s.displayedCharCount).toBe(0)
      expect(s.acc).toBe(0)
    })

    it('fromCount Infinity: 非有限なので 0 に倒す（length にせず先頭から）', () => {
      const s = startTypewriterFrom(TEXT, Infinity)
      expect(s.displayedCharCount).toBe(0)
    })

    it('fromCount 小数: floor して扱う（2.9 → 2）', () => {
      const s = startTypewriterFrom(TEXT, 2.9)
      expect(s.displayedCharCount).toBe(2)
      expect(visibleText(s)).toBe('AB')
    })

    it('acc は常に 0 で開始（端数を持ち込まない）', () => {
      expect(startTypewriterFrom(TEXT, 3).acc).toBe(0)
      expect(startTypewriterFrom(TEXT, 0).acc).toBe(0)
      expect(startTypewriterFrom('', 0).acc).toBe(0)
    })

    it('不変条件: 0 <= displayedCharCount <= fullText.length（多入力で縛る）', () => {
      const inputs = [-100, -1, 0, 1, 2, 5, 6, 100, 2.5, NaN, Infinity, -Infinity]
      for (const from of inputs) {
        const s = startTypewriterFrom(TEXT, from)
        expect(s.displayedCharCount).toBeGreaterThanOrEqual(0)
        expect(s.displayedCharCount).toBeLessThanOrEqual(TEXT.length)
        // visibleText は fullText の真のプレフィックス（クランプ後の長さ）
        expect(visibleText(s)).toBe(TEXT.substring(0, s.displayedCharCount))
      }
    })

    it('空文字 fullText では fromCount に関わらず displayedCharCount=0', () => {
      expect(startTypewriterFrom('', 5).displayedCharCount).toBe(0)
      expect(startTypewriterFrom('', 0).displayedCharCount).toBe(0)
      expect(isTypingActive(startTypewriterFrom('', 3))).toBe(false)
    })

    it('続きを tick すると既出分を超えてタイプが進む', () => {
      // 'AB' 既出から開始 → 即時完了する msPerChar=0 で残り 'CDE' まで進む。
      const s0 = startTypewriterFrom(TEXT, 2)
      const s1 = tickTypewriter(s0, 1, 0)
      expect(s1.displayedCharCount).toBe(TEXT.length)
      expect(visibleText(s1)).toBe(TEXT)
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
