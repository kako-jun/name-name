import { describe, it, expect } from 'vitest'
import { computeMainPanelLayout } from './TouchMenuOverlay'

describe('computeMainPanelLayout (Issue #171)', () => {
  it('grid-4x2 で 8 項目を 4 列 2 行に並べる', () => {
    const r = computeMainPanelLayout({
      screenWidth: 800,
      screenHeight: 450,
      itemCount: 8,
      maxTextWidth: 80,
      position: 'top-left',
      layout: 'grid-4x2',
    })
    expect(r.columns).toBe(4)
    // panelWidth = 4 * (80 + 16) + 16 = 400
    expect(r.panelWidth).toBe(4 * (80 + 16) + 16)
    // panelHeight = 2 * 36 + 12*2 = 96
    expect(r.panelHeight).toBe(2 * 36 + 12 * 2)
    // top-left は SCREEN_MARGIN(24) 起点
    expect(r.panelX).toBe(24)
    expect(r.panelY).toBe(24)
  })

  it('list は 1 列、N 行', () => {
    const r = computeMainPanelLayout({
      screenWidth: 800,
      screenHeight: 450,
      itemCount: 2,
      maxTextWidth: 60,
      position: 'bottom-right',
      layout: 'list',
    })
    expect(r.columns).toBe(1)
    // panelWidth = 1 * (60 + 16) + 16 = 92
    expect(r.panelWidth).toBe(60 + 16 + 16)
    // panelHeight = 2 * 36 + 12*2 = 96
    expect(r.panelHeight).toBe(2 * 36 + 12 * 2)
    // bottom-right: 画面の右下から逆算
    expect(r.panelX).toBe(800 - r.panelWidth - 24)
    expect(r.panelY).toBe(450 - r.panelHeight - 24)
  })

  it('grid-4x2 で項目 8 でない場合（5 項目）も行数が切り上げられる', () => {
    const r = computeMainPanelLayout({
      screenWidth: 800,
      screenHeight: 450,
      itemCount: 5,
      maxTextWidth: 80,
      position: 'top-left',
      layout: 'grid-4x2',
    })
    // 5 項目 ÷ 4 列 = 2 行
    expect(r.columns).toBe(4)
    expect(r.panelHeight).toBe(2 * 36 + 12 * 2)
  })

  it('項目 0 でも panel が縮退せず最低 1 行分の高さを確保する', () => {
    const r = computeMainPanelLayout({
      screenWidth: 800,
      screenHeight: 450,
      itemCount: 0,
      maxTextWidth: 0,
      position: 'top-left',
      layout: 'list',
    })
    // 0 項目だと max(1, ceil(0/1)) = 1 行
    expect(r.panelHeight).toBe(36 + 12 * 2)
  })

  it('top-left は画面サイズが変わっても panelX/Y 固定（SCREEN_MARGIN）', () => {
    const a = computeMainPanelLayout({
      screenWidth: 360,
      screenHeight: 800,
      itemCount: 8,
      maxTextWidth: 80,
      position: 'top-left',
      layout: 'grid-4x2',
    })
    const b = computeMainPanelLayout({
      screenWidth: 1920,
      screenHeight: 1080,
      itemCount: 8,
      maxTextWidth: 80,
      position: 'top-left',
      layout: 'grid-4x2',
    })
    expect(a.panelX).toBe(b.panelX)
    expect(a.panelY).toBe(b.panelY)
  })
})
