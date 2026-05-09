import { describe, it, expect } from 'vitest'
import { computeMinimapLayout } from './MinimapOverlay'

describe('computeMinimapLayout (Issue #149)', () => {
  it('top-right に既定 size 120, margin 12 で配置する', () => {
    const r = computeMinimapLayout({
      screenWidth: 800,
      screenHeight: 450,
      mapWidth: 20,
      mapHeight: 15,
    })
    // tilePx = floor(120 / max(20,15)) = floor(120/20) = 6
    expect(r.tilePx).toBe(6)
    // actualW = 6*20 = 120, actualH = 6*15 = 90
    expect(r.originX).toBe(800 - 120 - 12) // 668
    expect(r.originY).toBe(12)
  })

  it('縦長マップでは tilePx が小さくなる', () => {
    const r = computeMinimapLayout({
      screenWidth: 800,
      screenHeight: 450,
      mapWidth: 8,
      mapHeight: 30,
    })
    // tilePx = floor(120/30) = 4
    expect(r.tilePx).toBe(4)
    // actualH = 4*30 = 120 → originY は margin 12 のまま
    expect(r.originY).toBe(12)
  })

  it('top-left を指定すると originX = margin', () => {
    const r = computeMinimapLayout({
      screenWidth: 800,
      screenHeight: 450,
      mapWidth: 10,
      mapHeight: 10,
      corner: 'top-left',
    })
    expect(r.originX).toBe(12)
    expect(r.originY).toBe(12)
  })

  it('bottom-right は画面右下から逆算', () => {
    const r = computeMinimapLayout({
      screenWidth: 800,
      screenHeight: 450,
      mapWidth: 10,
      mapHeight: 10,
      corner: 'bottom-right',
    })
    // tilePx = floor(120/10) = 12, actualW = actualH = 120
    expect(r.originX).toBe(800 - 120 - 12)
    expect(r.originY).toBe(450 - 120 - 12)
  })

  it('size を狭くしても tilePx が 1 を下回らない', () => {
    const r = computeMinimapLayout({
      screenWidth: 800,
      screenHeight: 450,
      mapWidth: 200,
      mapHeight: 200,
      size: 10, // 10/200 = 0.05 → floor 0 → 1 にクランプ
    })
    expect(r.tilePx).toBe(1)
  })

  it('mapWidth 0 のときは 0 を返して描画スキップさせる', () => {
    const r = computeMinimapLayout({
      screenWidth: 800,
      screenHeight: 450,
      mapWidth: 0,
      mapHeight: 0,
    })
    expect(r.tilePx).toBe(0)
  })
})
