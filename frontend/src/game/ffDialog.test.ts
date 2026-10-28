import { describe, it, expect } from 'vitest'
import {
  FF_DIALOG_HEIGHT_RATIO,
  FF_DIALOG_MS_PER_CHAR,
  FF_DIALOG_TOP_RATIO,
  computeFfDialogRect,
  normalizeDialogStyle,
  normalizeMsPerChar,
} from './ffDialog'
import { BATTLE_LOG_MS_PER_CHAR } from './battleLogTypewriter'
import {
  skipTypewriter,
  startTypewriter,
  tickTypewriter,
  isTypingActive,
  visibleText,
} from './typewriter'

describe('computeFfDialogRect (#840)', () => {
  const sizes: Array<[number, number]> = [
    [640, 360],
    [1280, 720],
    [1920, 1080],
    [800, 600],
    [360, 640],
    [2000, 500],
    [100, 100],
  ]
  it('どの画面サイズでも画面内に収まり、下端は画面の上半分以内', () => {
    for (const [w, h] of sizes) {
      const r = computeFfDialogRect(w, h)
      expect(r.x).toBeGreaterThanOrEqual(0)
      expect(r.y).toBeGreaterThanOrEqual(0)
      expect(r.x + r.width).toBeLessThanOrEqual(w)
      expect(r.y + r.height).toBeLessThanOrEqual(h / 2)
      expect(r.width).toBeGreaterThan(0)
      expect(r.height).toBeGreaterThan(0)
    }
  })
  it('左右対称（中央寄せ）で、上端は画面の上部にある', () => {
    for (const [w, h] of sizes) {
      const r = computeFfDialogRect(w, h)
      expect(r.x).toBe(w - (r.x + r.width))
      expect(r.y).toBeLessThan(h / 4)
    }
  })
  it('画面サイズに比例する（大きい画面は窓も大きい）', () => {
    const a = computeFfDialogRect(640, 360)
    const b = computeFfDialogRect(1280, 720)
    expect(b.height).toBeGreaterThan(a.height)
    expect(b.width).toBeGreaterThan(a.width)
    expect(b.y).toBeGreaterThan(a.y)
  })
  it('比率定数が上半分に収まる設計になっている', () => {
    expect(FF_DIALOG_TOP_RATIO + FF_DIALOG_HEIGHT_RATIO).toBeLessThanOrEqual(0.5)
  })
  it('非有限・負は 0 扱いで窓が潰れる（NaN を返さない）', () => {
    for (const bad of [NaN, -5, Infinity]) {
      const r = computeFfDialogRect(bad, bad)
      for (const v of [r.x, r.y, r.width, r.height, r.padding]) expect(Number.isFinite(v)).toBe(true)
    }
  })
})

describe('normalizeDialogStyle / normalizeMsPerChar (#840)', () => {
  it("'ff' だけを受け付ける（大文字・空白は許容）", () => {
    expect(normalizeDialogStyle('ff')).toBe('ff')
    expect(normalizeDialogStyle(' FF ')).toBe('ff')
  })
  it('未指定・未知値・非文字列は undefined（従来の窓）', () => {
    for (const bad of [undefined, null, '', 'dark', 'ff-blue', 1, true, {}])
      expect(normalizeDialogStyle(bad)).toBeUndefined()
  })
  it('msPerChar は 0 以上の有限数だけ。それ以外は undefined', () => {
    expect(normalizeMsPerChar(0)).toBe(0)
    expect(normalizeMsPerChar(45)).toBe(45)
    for (const bad of [-1, NaN, Infinity, '30', null, undefined])
      expect(normalizeMsPerChar(bad)).toBeUndefined()
  })
  it('既定の速さは戦闘ログ (#755) と同じ', () => {
    expect(FF_DIALOG_MS_PER_CHAR).toBe(BATTLE_LOG_MS_PER_CHAR)
  })
})

describe('1 文字ずつの進行と全文表示（typewriter 流用）(#840)', () => {
  const MS = FF_DIALOG_MS_PER_CHAR
  it('経過時間に応じて 1 文字ずつ増え、全文に達したら止まる', () => {
    let t = startTypewriter('あいうえお')
    expect(visibleText(t)).toBe('')
    t = tickTypewriter(t, MS, MS)
    expect(visibleText(t)).toBe('あ')
    t = tickTypewriter(t, MS * 2, MS)
    expect(visibleText(t)).toBe('あいう')
    t = tickTypewriter(t, MS * 10, MS)
    expect(visibleText(t)).toBe('あいうえお')
    expect(isTypingActive(t)).toBe(false)
  })
  it('決定操作: 表示中なら全文、全文表示済みなら次へ進める状態', () => {
    let t = startTypewriter('あいうえお')
    t = tickTypewriter(t, MS, MS)
    expect(isTypingActive(t)).toBe(true) // この状態の決定 = 全文表示
    t = skipTypewriter(t)
    expect(visibleText(t)).toBe('あいうえお')
    expect(isTypingActive(t)).toBe(false) // この状態の決定 = 次へ
  })
})
