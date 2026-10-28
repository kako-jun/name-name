import { describe, expect, it } from 'vitest'
import { companionZ, layerIndex, npcZ, orderedLayers, WORLD_LAYER_ORDER, WORLD_Z } from './layers'

describe('world の描画順', () => {
  it('景色 → 背景 → オーバーレイ → 同行者 → 主人公 → 前面 → 感情吹き出し → マーカーの順', () => {
    expect([...WORLD_LAYER_ORDER]).toEqual([
      'scroll',
      'background',
      'overlay',
      'companion',
      'player',
      'foreground',
      'emotion',
      'marker',
    ])
  })

  it('前面は主人公の手前、マーカーは前面の手前', () => {
    expect(layerIndex('foreground')).toBeGreaterThan(layerIndex('player'))
    expect(layerIndex('marker')).toBeGreaterThan(layerIndex('foreground'))
  })

  it('感情吹き出し (#937) は前面の手前（隠れない）、マーカーの奥', () => {
    expect(layerIndex('emotion')).toBeGreaterThan(layerIndex('foreground'))
    expect(layerIndex('marker')).toBeGreaterThan(layerIndex('emotion'))
    expect(WORLD_Z.emotion).toBeGreaterThan(WORLD_Z.foreground)
    expect(WORLD_Z.marker).toBeGreaterThan(WORLD_Z.emotion)
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
      emotion: 'e',
      overlay: 'o',
      companion: 'c',
      background: 'b',
    })
    expect(r).toEqual(['s', 'b', 'o', 'c', 'p', 'f', 'e', 'm'])
  })

  it('zIndex の大小も描画順と一致する（前面は同行者・主人公のどちらの手前でもある）', () => {
    const byOrder = WORLD_LAYER_ORDER.map((n) => WORLD_Z[n])
    expect(byOrder).toEqual([...byOrder].sort((a, b) => a - b))
    expect(WORLD_Z.foreground).toBeGreaterThan(WORLD_Z.player + 1)
    expect(WORLD_Z.marker).toBeGreaterThan(WORLD_Z.foreground)
  })

  it('同行者は足元が主人公より下なら主人公の手前、そうでなければ奥。どちらも前面の奥', () => {
    expect(companionZ(100, 80, 600)).toBeGreaterThan(WORLD_Z.player)
    expect(companionZ(60, 80, 600)).toBeLessThan(WORLD_Z.player)
    expect(companionZ(80, 80, 600)).toBeLessThan(WORLD_Z.player)
    expect(companionZ(100, 80, 600)).toBeLessThan(WORLD_Z.foreground)
  })

  it('NPC: 主人公より足元が下なら手前・上なら奥。同 y は奥（>= ではなく > で手前）', () => {
    expect(npcZ(300, 200, 600)).toBeGreaterThan(WORLD_Z.player)
    expect(npcZ(100, 200, 600)).toBeLessThan(WORLD_Z.player)
    expect(npcZ(200, 200, 600)).toBeLessThan(WORLD_Z.player)
    expect(npcZ(201, 200, 600)).toBeGreaterThan(WORLD_Z.player)
  })

  it('同じ側では足元 y が大きいほど手前・範囲は前面(20)の奥で背景(2)の手前', () => {
    expect(npcZ(400, 100, 600)).toBeGreaterThan(npcZ(300, 100, 600))
    expect(npcZ(100000, 0, 600)).toBeLessThan(WORLD_Z.foreground)
    expect(npcZ(-5, 0, 600)).toBeGreaterThan(WORLD_Z.overlay)
  })

  it('主人公・同行者・NPC は同じ式: 同じ足元・同じ主人公なら同じ z、NPC が同行者より下なら NPC が手前', () => {
    expect(npcZ(300, 200, 600)).toBe(companionZ(300, 200, 600))
    expect(npcZ(350, 200, 600)).toBeGreaterThan(companionZ(300, 200, 600))
    expect(npcZ(150, 200, 600)).toBeGreaterThan(companionZ(100, 200, 600))
    // 手前側の同行者(下)と奥側の NPC(上)
    expect(companionZ(300, 200, 600)).toBeGreaterThan(npcZ(250, 300, 600))
  })
})
