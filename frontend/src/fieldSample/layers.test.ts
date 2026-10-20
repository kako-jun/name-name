import { describe, expect, it } from 'vitest'
import { layerIndex, orderedLayers, WORLD_LAYER_ORDER } from './layers'

describe('world の描画順', () => {
  it('景色 → 背景 → オーバーレイ → 主人公 → 前面 → マーカーの順', () => {
    expect([...WORLD_LAYER_ORDER]).toEqual([
      'scroll',
      'background',
      'overlay',
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
      background: 'b',
    })
    expect(r).toEqual(['s', 'b', 'o', 'p', 'f', 'm'])
  })
})
