import { describe, expect, it } from 'vitest'
import { companionZ, layerIndex, orderedLayers, WORLD_LAYER_ORDER, WORLD_Z } from './layers'

describe('world の描画順', () => {
  it('景色 → 背景 → オーバーレイ → 同行者 → 主人公 → 前面 → マーカーの順', () => {
    expect([...WORLD_LAYER_ORDER]).toEqual([
      'scroll',
      'background',
      'overlay',
      'companion',
      'player',
      'foreground',
      'marker',
    ])
  })

  it('前面は主人公の手前、マーカーは前面の手前', () => {
    expect(layerIndex('foreground')).toBeGreaterThan(layerIndex('player'))
    expect(layerIndex('marker')).toBeGreaterThan(layerIndex('foreground'))
  })

  it('景色は背景より奥', () => {
    expect(layerIndex('scroll')).toBeLessThan(layerIndex('background'))
  })

  it('orderedLayers は描画順に並べ直す', () => {
    const r = orderedLayers({
      scroll: 's',
      marker: 'm',
      player: 'p',
      foreground: 'f',
      overlay: 'o',
      companion: 'c',
      background: 'b',
    })
    expect(r).toEqual(['s', 'b', 'o', 'c', 'p', 'f', 'm'])
  })

  it('zIndex の大小も描画順と一致する（前面は同行者・主人公のどちらの手前でもある）', () => {
    const byOrder = WORLD_LAYER_ORDER.map((n) => WORLD_Z[n])
    expect(byOrder).toEqual([...byOrder].sort((a, b) => a - b))
    expect(WORLD_Z.foreground).toBeGreaterThan(WORLD_Z.player + 1)
    expect(WORLD_Z.marker).toBeGreaterThan(WORLD_Z.foreground)
  })

  it('同行者は足元が主人公より下なら主人公の手前、そうでなければ奥。どちらも前面の奥', () => {
    expect(companionZ(100, 80)).toBeGreaterThan(WORLD_Z.player)
    expect(companionZ(60, 80)).toBeLessThan(WORLD_Z.player)
    expect(companionZ(80, 80)).toBeLessThan(WORLD_Z.player)
    expect(companionZ(100, 80)).toBeLessThan(WORLD_Z.foreground)
  })
})
