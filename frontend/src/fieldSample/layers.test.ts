import { describe, expect, it } from 'vitest'
import { Container } from 'pixi.js'
import {
  companionZ,
  emotionHostOf,
  emotionLayerHost,
  layerIndex,
  npcZ,
  orderedLayers,
  syncEmotionLayerHost,
  WORLD_LAYER_ORDER,
  WORLD_Z,
} from './layers'

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

describe('感情吹き出しの層の置き先 (#840)', () => {
  it('ff の窓で会話中だけ stage（窓の手前）。それ以外は world のまま', () => {
    expect(emotionLayerHost(true, true)).toBe('stage')
    expect(emotionLayerHost(true, false)).toBe('world')
    expect(emotionLayerHost(false, true)).toBe('world')
    expect(emotionLayerHost(false, false)).toBe('world')
  })
})

describe('感情吹き出しの層の付け替え配線 (#840)', () => {
  const setup = () => {
    const world = new Container()
    const top = new Container()
    const layer = new Container()
    world.addChild(layer)
    return { world, top, layer }
  }
  it('ff の窓の会話中は stage へ、終わったら world へ戻る（state の emotionHost と一致）', () => {
    const { world, top, layer } = setup()
    expect(emotionHostOf(layer, top)).toBe('world')
    expect(syncEmotionLayerHost({ ffWindow: true, talking: true, layer, world, top })).toBe('stage')
    expect(layer.parent).toBe(top)
    expect(emotionHostOf(layer, top)).toBe('stage')
    expect(syncEmotionLayerHost({ ffWindow: true, talking: false, layer, world, top })).toBe(
      'world'
    )
    expect(layer.parent).toBe(world)
    expect(emotionHostOf(layer, top)).toBe('world')
  })
  it('従来の窓は会話中でも world のまま', () => {
    const { world, top, layer } = setup()
    expect(syncEmotionLayerHost({ ffWindow: false, talking: true, layer, world, top })).toBe(
      'world'
    )
    expect(layer.parent).toBe(world)
  })
  it('stage 側の y は world の揺れに毎回合わせる', () => {
    const { world, top, layer } = setup()
    world.y = 7
    syncEmotionLayerHost({ ffWindow: true, talking: true, layer, world, top })
    expect(top.y).toBe(7)
    world.y = -3
    syncEmotionLayerHost({ ffWindow: true, talking: true, layer, world, top })
    expect(top.y).toBe(-3)
  })
})
