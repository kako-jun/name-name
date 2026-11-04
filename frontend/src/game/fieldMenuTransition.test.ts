/** 全画面メニューの画面遷移 (#880 / fieldMenuTransition.ts) のテスト */
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_MENU_TRANSITION,
  MENU_TRANSITION_MAX_MS,
  easeInOut,
  lerpRect,
  normalizeTransitionTiming,
  sampleMenuTransition,
  transitionDurationMs,
  type MenuTransitionTiming,
} from './fieldMenuTransition'

const from = { x: 0, y: 0, w: 100, h: 100 }
const to = { x: 100, y: 50, w: 300, h: 200 }
const T: MenuTransitionTiming = { textOutMs: 100, slideMs: 200, textInMs: 100 }

describe('normalizeTransitionTiming', () => {
  it('未指定・true は既定（複製）', () => {
    for (const raw of [undefined, true]) {
      const r = normalizeTransitionTiming(raw)
      expect(r.timing).toEqual(DEFAULT_MENU_TRANSITION)
      expect(r.timing).not.toBe(DEFAULT_MENU_TRANSITION)
      expect(r.warnings).toEqual([])
    }
  })
  it('false / "none" は全段階 0', () => {
    for (const raw of [false, 'none'])
      expect(normalizeTransitionTiming(raw).timing).toEqual({
        textOutMs: 0,
        slideMs: 0,
        textInMs: 0,
      })
  })
  it.each([['fast'], [5], [null], [[1]]])('不正な型（%j）は警告して既定', (raw) => {
    const r = normalizeTransitionTiming(raw)
    expect(r.timing).toEqual(DEFAULT_MENU_TRANSITION)
    expect(r.warnings).toHaveLength(1)
  })
  it('一部だけ指定すると残りは既定。0 と上限ちょうどは受理', () => {
    const r = normalizeTransitionTiming({ textOutMs: 0, slideMs: MENU_TRANSITION_MAX_MS })
    expect(r.timing).toEqual({ textOutMs: 0, slideMs: MENU_TRANSITION_MAX_MS, textInMs: 80 })
    expect(r.warnings).toEqual([])
  })
  it.each([[-1], [MENU_TRANSITION_MAX_MS + 1], [NaN], [Infinity], ['10'], [null]])(
    '不正な値（%j）は警告して既定のまま',
    (v) => {
      const r = normalizeTransitionTiming({ slideMs: v })
      expect(r.timing.slideMs).toBe(DEFAULT_MENU_TRANSITION.slideMs)
      expect(r.warnings).toHaveLength(1)
    }
  )
  it('未知のキーは無視（警告なし）', () => {
    expect(normalizeTransitionTiming({ foo: 1 }).warnings).toEqual([])
  })
})

describe('easeInOut / lerpRect / duration', () => {
  it('端点と中点、クランプと NaN', () => {
    expect(easeInOut(0)).toBe(0)
    expect(easeInOut(1)).toBe(1)
    expect(easeInOut(0.5)).toBe(0.5)
    expect(easeInOut(-3)).toBe(0)
    expect(easeInOut(9)).toBe(1)
    expect(easeInOut(NaN)).toBe(0)
  })
  it('lerpRect', () => {
    expect(lerpRect(from, to, 0)).toEqual(from)
    expect(lerpRect(from, to, 1)).toEqual(to)
    expect(lerpRect(from, to, 0.5)).toEqual({ x: 50, y: 25, w: 200, h: 150 })
  })
  it('全長は3段階の和', () => {
    expect(transitionDurationMs(T)).toBe(400)
    expect(transitionDurationMs({ textOutMs: 0, slideMs: 0, textInMs: 0 })).toBe(0)
  })
})

describe('sampleMenuTransition（順再生）', () => {
  it('開始: 枠は from・手前の文字が全表示・まだ終わっていない', () => {
    expect(sampleMenuTransition(0, T, from, to)).toEqual({
      frame: from,
      fromAlpha: 1,
      toAlpha: 0,
      done: false,
    })
  })
  it('文字が消える段階: fromAlpha が 1→0、枠は動かない', () => {
    const s = sampleMenuTransition(50, T, from, to)
    expect(s.frame).toEqual(from)
    expect(s.fromAlpha).toBeCloseTo(0.5, 5)
    expect(s.toAlpha).toBe(0)
  })
  it('境界 textOutMs ちょうど: スライド開始（文字は両方消えている）', () => {
    const s = sampleMenuTransition(100, T, from, to)
    expect(s).toEqual({ frame: from, fromAlpha: 0, toAlpha: 0, done: false })
  })
  it('スライド中: 枠が補間され、文字は両方出ない', () => {
    const s = sampleMenuTransition(200, T, from, to) // スライドの半分
    expect(s.frame).toEqual({ x: 50, y: 25, w: 200, h: 150 })
    expect(s.fromAlpha).toBe(0)
    expect(s.toAlpha).toBe(0)
  })
  it('境界 textOutMs+slideMs: 枠は to・新しい文字はこれから', () => {
    const s = sampleMenuTransition(300, T, from, to)
    expect(s).toEqual({ frame: to, fromAlpha: 0, toAlpha: 0, done: false })
  })
  it('文字が現れる段階', () => {
    const s = sampleMenuTransition(350, T, from, to)
    expect(s.frame).toEqual(to)
    expect(s.toAlpha).toBeCloseTo(0.5, 5)
  })
  it('終了: 全長ちょうどで done・to が全表示', () => {
    expect(sampleMenuTransition(400, T, from, to)).toEqual({
      frame: to,
      fromAlpha: 0,
      toAlpha: 1,
      done: true,
    })
  })
  it('全長超過・負・NaN・Infinity はクランプ', () => {
    expect(sampleMenuTransition(9999, T, from, to).done).toBe(true)
    expect(sampleMenuTransition(-5, T, from, to)).toEqual(sampleMenuTransition(0, T, from, to))
    expect(sampleMenuTransition(NaN, T, from, to)).toEqual(sampleMenuTransition(0, T, from, to))
    // Infinity は非有限として 0 扱い（開始に戻る）。呼び出し側が渡さない前提の防御
    expect(sampleMenuTransition(Infinity, T, from, to).done).toBe(false)
  })
  it('単調性: 枠の x は時間とともに減らない', () => {
    let prev = -Infinity
    for (let t = 0; t <= 400; t += 10) {
      const x = sampleMenuTransition(t, T, from, to).frame.x
      expect(x).toBeGreaterThanOrEqual(prev - 1e-9)
      prev = x
    }
  })
})

describe('sampleMenuTransition（reverse = 順再生の時間反転）', () => {
  it('任意の t で reverse(t) は forward(total - t) と枠・表示度が一致する', () => {
    const total = transitionDurationMs(T)
    for (let t = 0; t <= total; t += 7) {
      const r = sampleMenuTransition(t, T, from, to, true)
      const f = sampleMenuTransition(total - t, T, from, to, false)
      expect(r.frame.x).toBeCloseTo(f.frame.x, 9)
      expect(r.frame.w).toBeCloseTo(f.frame.w, 9)
      expect(r.fromAlpha).toBeCloseTo(f.fromAlpha, 9)
      expect(r.toAlpha).toBeCloseTo(f.toAlpha, 9)
    }
  })
  it('開始は to の文字が全表示・枠は to、終了で from の文字が全表示・done', () => {
    expect(sampleMenuTransition(0, T, from, to, true)).toEqual({
      frame: to,
      fromAlpha: 0,
      toAlpha: 1,
      done: false,
    })
    expect(sampleMenuTransition(400, T, from, to, true)).toEqual({
      frame: from,
      fromAlpha: 1,
      toAlpha: 0,
      done: true,
    })
  })
  it('順再生の終了(done)と逆再生の終了は同じ時刻', () => {
    expect(sampleMenuTransition(399, T, from, to, true).done).toBe(false)
    expect(sampleMenuTransition(400, T, from, to, true).done).toBe(true)
  })
})

describe('0ms 段階・ゼロ全長', () => {
  const zero: MenuTransitionTiming = { textOutMs: 0, slideMs: 0, textInMs: 0 }
  it('全部 0 は即座に終わり、順は to、逆は from が全表示（NaN なし）', () => {
    const f = sampleMenuTransition(0, zero, from, to)
    expect(f).toEqual({ frame: to, fromAlpha: 0, toAlpha: 1, done: true })
    const r = sampleMenuTransition(0, zero, from, to, true)
    expect(r.done).toBe(true)
    expect(r.frame).toEqual(to) // 0 長では逆再生でも終点の見た目（呼び出し側は done で即切替する）
    for (const v of [r.fromAlpha, r.toAlpha, r.frame.x]) expect(Number.isNaN(v)).toBe(false)
  })
  it('文字消去だけ 0: 開始直後からスライド', () => {
    const t = { textOutMs: 0, slideMs: 100, textInMs: 100 }
    const s = sampleMenuTransition(50, t, from, to)
    expect(s.fromAlpha).toBe(0)
    expect(s.frame.x).toBeCloseTo(50, 5)
  })
  it('スライドだけ 0: 文字が消えてすぐ現れる（枠はジャンプ）', () => {
    const t = { textOutMs: 100, slideMs: 0, textInMs: 100 }
    expect(sampleMenuTransition(100, t, from, to)).toMatchObject({
      frame: to,
      fromAlpha: 0,
      toAlpha: 0,
    })
    expect(sampleMenuTransition(150, t, from, to).toAlpha).toBeCloseTo(0.5, 5)
  })
  it('文字出現だけ 0: スライド終了で to が全表示（done）', () => {
    const t = { textOutMs: 100, slideMs: 100, textInMs: 0 }
    expect(sampleMenuTransition(200, t, from, to)).toEqual({
      frame: to,
      fromAlpha: 0,
      toAlpha: 1,
      done: true,
    })
  })
})
