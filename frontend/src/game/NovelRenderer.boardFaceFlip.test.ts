/**
 * NovelRenderer と大道具・背景板の面の切り替え (#704) の配線。
 *  - character_fade_ms（setCharacterFadeMs）が回転の既定時間になる
 *  - 動画書き出しの開始が両レイヤーへ伝わる
 */
import { describe, expect, it, vi } from 'vitest'
import { NovelRenderer } from './NovelRenderer'
import type { PropLayer } from './PropLayer'
import type { BackgroundBoardLayer } from './BackgroundBoardLayer'

interface Layers {
  propLayer: PropLayer
  backgroundBoardLayer: BackgroundBoardLayer
}
const layersOf = (r: NovelRenderer): Layers => r as unknown as Layers

describe('NovelRenderer: 面の切り替え (#704)', () => {
  it('setCharacterFadeMs が大道具・背景板の回転の既定時間に伝わる（null で既定へ戻る）', () => {
    const r = new NovelRenderer()
    const p = vi.spyOn(layersOf(r).propLayer, 'setFlipDefaultMs')
    const b = vi.spyOn(layersOf(r).backgroundBoardLayer, 'setFlipDefaultMs')
    r.setCharacterFadeMs(1400)
    expect(p).toHaveBeenLastCalledWith(1400)
    expect(b).toHaveBeenLastCalledWith(1400)
    r.setCharacterFadeMs(undefined)
    expect(p).toHaveBeenLastCalledWith(null)
    expect(b).toHaveBeenLastCalledWith(null)
  })

  it('setExporting が大道具・背景板へ伝わる', () => {
    const r = new NovelRenderer()
    const p = vi.spyOn(layersOf(r).propLayer, 'setExporting')
    const b = vi.spyOn(layersOf(r).backgroundBoardLayer, 'setExporting')
    r.setExporting(true)
    expect(p).toHaveBeenLastCalledWith(true)
    expect(b).toHaveBeenLastCalledWith(true)
    r.setExporting(false)
    expect(p).toHaveBeenLastCalledWith(false)
    expect(b).toHaveBeenLastCalledWith(false)
  })
})
