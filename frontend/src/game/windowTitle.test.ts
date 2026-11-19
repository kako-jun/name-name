import { describe, it, expect } from 'vitest'
import {
  PANEL_CORNER_RADIUS,
  WINDOW_TITLE_LEFT,
  WINDOW_TITLE_PAD,
  placeWindowTitle,
} from './windowTitle'

describe('placeWindowTitle (#1226)', () => {
  const rect = { x: 20, y: 100, w: 200 }

  it('文字は窓の上辺の線の高さに縦中央でのり、左寄りに置く', () => {
    const p = placeWindowTitle(rect, 'まほう', PANEL_CORNER_RADIUS, 36)!
    expect(p.textX).toBe(rect.x + WINDOW_TITLE_LEFT)
    expect(p.centerY).toBe(rect.y)
  })

  it('切れ目は文字の幅 + 左右の余白で、文字を必ず含む', () => {
    const p = placeWindowTitle(rect, 'まほう', PANEL_CORNER_RADIUS, 36)!
    expect(p.gap!.x0).toBe(p.textX - WINDOW_TITLE_PAD)
    expect(p.gap!.x1).toBe(p.textX + 36 + WINDOW_TITLE_PAD)
    expect(p.gap!.x0).toBeLessThan(p.textX)
    expect(p.gap!.x1).toBeGreaterThan(p.textX + 36)
  })

  it('切れ目は角丸の内側に収まる', () => {
    const p = placeWindowTitle(rect, 'まほう', PANEL_CORNER_RADIUS, 36)!
    expect(p.gap!.x0).toBeGreaterThanOrEqual(rect.x + PANEL_CORNER_RADIUS)
    expect(p.gap!.x1).toBeLessThanOrEqual(rect.x + rect.w - PANEL_CORNER_RADIUS)
  })

  it('空文字・幅が取れない・窓に入り切らないときは出さない（null）', () => {
    expect(placeWindowTitle(rect, '', PANEL_CORNER_RADIUS, 36)).toBeNull()
    expect(placeWindowTitle(rect, 'a', PANEL_CORNER_RADIUS, NaN)).toBeNull()
    expect(placeWindowTitle(rect, 'ながいなまえ', PANEL_CORNER_RADIUS, 400)).toBeNull()
  })

  it('幅を省くと概算の幅を使う', () => {
    const p = placeWindowTitle(rect, 'まほう')!
    expect(p.textW).toBeGreaterThan(0)
  })

  it('窓の rect は読むだけで変えない', () => {
    const r = { ...rect }
    placeWindowTitle(r, 'まほう', PANEL_CORNER_RADIUS, 36)
    expect(r).toEqual(rect)
  })
})
