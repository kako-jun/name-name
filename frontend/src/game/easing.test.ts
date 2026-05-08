import { describe, it, expect } from 'vitest'
import { applyEasing, easeIn, easeInOut, easeLinear, easeOut, resolveDelta } from './easing'

describe('easing functions', () => {
  it('easeLinear は恒等関数', () => {
    expect(easeLinear(0)).toBe(0)
    expect(easeLinear(0.5)).toBe(0.5)
    expect(easeLinear(1)).toBe(1)
  })

  it('easeIn は最初遅く、後半速い', () => {
    expect(easeIn(0)).toBe(0)
    expect(easeIn(1)).toBe(1)
    expect(easeIn(0.5)).toBe(0.25)
    expect(easeIn(0.25)).toBeLessThan(0.25)
  })

  it('easeOut は最初速く、後半遅い', () => {
    expect(easeOut(0)).toBe(0)
    expect(easeOut(1)).toBe(1)
    expect(easeOut(0.5)).toBe(0.75)
    expect(easeOut(0.25)).toBeGreaterThan(0.25)
  })

  it('easeInOut は両端で滑らか', () => {
    expect(easeInOut(0)).toBe(0)
    expect(easeInOut(0.5)).toBe(0.5)
    expect(easeInOut(1)).toBe(1)
  })
})

describe('applyEasing', () => {
  it('未指定 / Linear は恒等', () => {
    expect(applyEasing(undefined, 0.3)).toBe(0.3)
    expect(applyEasing('Linear', 0.7)).toBe(0.7)
  })

  it('EaseIn / EaseOut / EaseInOut を分岐', () => {
    expect(applyEasing('EaseIn', 0.5)).toBe(0.25)
    expect(applyEasing('EaseOut', 0.5)).toBe(0.75)
    expect(applyEasing('EaseInOut', 0.5)).toBe(0.5)
  })

  it('範囲外の t は 0..1 にクランプ', () => {
    expect(applyEasing('Linear', -0.5)).toBe(0)
    expect(applyEasing('Linear', 1.5)).toBe(1)
    expect(applyEasing('EaseIn', -1)).toBe(0)
    expect(applyEasing('EaseOut', 2)).toBe(1)
  })
})

describe('resolveDelta', () => {
  it('絶対値はそのまま返す', () => {
    expect(resolveDelta('400', 100)).toBe(400)
    expect(resolveDelta('0', 50)).toBe(0)
  })

  it('+ 接頭辞は相対加算', () => {
    expect(resolveDelta('+500', 100)).toBe(600)
    expect(resolveDelta('+0', 100)).toBe(100)
  })

  it('- 接頭辞は相対減算', () => {
    expect(resolveDelta('-200', 100)).toBe(-100)
    expect(resolveDelta('-50', 0)).toBe(-50)
  })

  it('undefined / 空文字 は current を返す', () => {
    expect(resolveDelta(undefined, 42)).toBe(42)
    expect(resolveDelta('', 42)).toBe(42)
    expect(resolveDelta('   ', 42)).toBe(42)
  })

  it('不正な文字列は current を返す', () => {
    expect(resolveDelta('abc', 100)).toBe(100)
    expect(resolveDelta('+xyz', 100)).toBe(100)
  })

  it('小数値も受理', () => {
    expect(resolveDelta('1.5', 0)).toBe(1.5)
    expect(resolveDelta('+0.5', 1)).toBe(1.5)
  })
})
