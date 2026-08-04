/**
 * NovelRenderer の `pixel_art: true`（#466 テクスチャ拡大縮小フィルタ nearest-neighbor）単体テスト。
 *
 * `NovelRenderer.setPixelArt()` はそれ自体の状態を持たず、`characterLayer.setPixelArt()` /
 * `eventImageLayer.setPixelArt()` へ素通しするだけの薄い委譲層（`setCharacterScale` と同じ流儀）。
 * 実際の scaleMode 反映は CharacterLayer.test.ts / EventImageLayer.test.ts 側の責務。
 * ここでは NovelRenderer が両レイヤーへ正しい値（null/undefined/false → false 化）で
 * broadcast することだけを検証する。
 *
 * 駆動方式: `new NovelRenderer()` → private characterLayer/eventImageLayer を internals キャストで
 * 取り出し、それぞれの `setPixelArt` を spy して呼び出し引数を観測する（NovelRenderer.splitLayoutScrim.test.ts
 * と同じ「private フィールドを internals キャストで読む」流儀）。init() 不要。
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { NovelRenderer } from './NovelRenderer'
import type { CharacterLayer } from './CharacterLayer'
import type { EventImageLayer } from './EventImageLayer'

interface RendererLayerInternals {
  characterLayer: CharacterLayer
  eventImageLayer: EventImageLayer
}
function layerInternals(r: NovelRenderer): RendererLayerInternals {
  return r as unknown as RendererLayerInternals
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('NovelRenderer setPixelArt の両レイヤーへの broadcast (#466)', () => {
  it('N1: setPixelArt(true) は characterLayer.setPixelArt(true) と eventImageLayer.setPixelArt(true) の両方を呼ぶ', () => {
    const r = new NovelRenderer()
    const i = layerInternals(r)
    const charSpy = vi.spyOn(i.characterLayer, 'setPixelArt')
    const eventSpy = vi.spyOn(i.eventImageLayer, 'setPixelArt')

    r.setPixelArt(true)

    expect(charSpy).toHaveBeenCalledWith(true)
    expect(eventSpy).toHaveBeenCalledWith(true)
  })

  it('N2: setPixelArt(null)/setPixelArt(undefined)/setPixelArt(false) はいずれも両レイヤーに false を渡す', () => {
    const r = new NovelRenderer()
    const i = layerInternals(r)
    const charSpy = vi.spyOn(i.characterLayer, 'setPixelArt')
    const eventSpy = vi.spyOn(i.eventImageLayer, 'setPixelArt')

    r.setPixelArt(null)
    expect(charSpy).toHaveBeenLastCalledWith(false)
    expect(eventSpy).toHaveBeenLastCalledWith(false)

    r.setPixelArt(undefined)
    expect(charSpy).toHaveBeenLastCalledWith(false)
    expect(eventSpy).toHaveBeenLastCalledWith(false)

    r.setPixelArt(false)
    expect(charSpy).toHaveBeenLastCalledWith(false)
    expect(eventSpy).toHaveBeenLastCalledWith(false)

    // 3 回とも false（true は一度も渡っていない）。
    expect(charSpy).not.toHaveBeenCalledWith(true)
    expect(eventSpy).not.toHaveBeenCalledWith(true)
    expect(charSpy).toHaveBeenCalledTimes(3)
    expect(eventSpy).toHaveBeenCalledTimes(3)
  })
})
