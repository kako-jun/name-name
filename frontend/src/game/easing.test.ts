import { describe, it, expect } from 'vitest'
import {
  applyEasing,
  easeIn,
  easeInOut,
  easeLinear,
  easeOut,
  easeOutBack,
  resolveDelta,
} from './easing'

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

describe('easeOutBack (#268 爆発のポップ)', () => {
  it('p=0 は実質 0（多項式形のため厳密 0 ではなく微小誤差に収まる）', () => {
    // 1 + c3*u^3 + c1*u^2 形式は u=-1 で数値誤差が出る。厳密 0 を要求すると壊れるため
    // 「整列開始点が原点とみなせる」ことだけを保証する（toBe(0) は使わない）。
    expect(easeOutBack(0)).toBeCloseTo(0, 10)
  })

  it('p=1 はちょうど 1.0 を返す（爆発が必ず整列で着地する保証）', () => {
    // 着地点がきっかり 1 でないと最終フレームで (1-eased)!=0 が残り、グリフが整列しない。
    expect(easeOutBack(1)).toBe(1)
  })

  it('途中で 1.0 を超える区間が存在する（行き過ぎ＝オーバーシュート）', () => {
    // 0..1 を細かく走査し、一度でも 1 を超えれば "ポップ" が成立している。
    let maxValue = -Infinity
    for (let t = 0; t <= 1; t += 0.01) {
      maxValue = Math.max(maxValue, easeOutBack(t))
    }
    expect(maxValue).toBeGreaterThan(1)
  })

  it('オーバーシュート後に 1.0 へ戻る（終端付近では 1 以下に収束）', () => {
    // ピーク (t≈0.58) より後の値はピークより小さく、t=1 へ向けて 1 に収束する。
    const peakRegion = easeOutBack(0.58)
    const nearEnd = easeOutBack(0.95)
    expect(peakRegion).toBeGreaterThan(1)
    expect(nearEnd).toBeLessThan(peakRegion)
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

  it('EaseOutBack を分岐し easeOutBack と同値を返す', () => {
    // dispatcher が EaseOutBack を素通しせず正しい関数へ繋いでいることを守る。
    expect(applyEasing('EaseOutBack', 0.58)).toBe(easeOutBack(0.58))
    expect(applyEasing('EaseOutBack', 1)).toBe(1)
  })

  it('EaseOutBack も範囲外 t を 0..1 にクランプしてから適用する', () => {
    // クランプを通すので t=1.5→1（=1）、t=-0.5→0（=easeOutBack(0)）になる。
    expect(applyEasing('EaseOutBack', 1.5)).toBe(1)
    expect(applyEasing('EaseOutBack', -0.5)).toBe(easeOutBack(0))
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
