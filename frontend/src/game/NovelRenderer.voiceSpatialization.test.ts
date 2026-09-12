import { describe, expect, it, vi } from 'vitest'
import { NovelRenderer } from './NovelRenderer'
import type { Event, EventScene } from '../types'

function enableRenderWithoutCanvas(renderer: NovelRenderer): void {
  ;(renderer as unknown as { initialized: boolean }).initialized = true
}

async function startThroughVoicePath(renderer: NovelRenderer): Promise<void> {
  // jsdom には Pixi の CanvasTextMetrics 用 2D context が無い。voice 呼び出しは
  // DialogBox のテキスト計測より前なので、そこで止まる既存の headless 制約は握り潰す。
  try {
    await renderer.startFrom({ sceneId: 'stage' })
  } catch {
    // DialogBox の実描画は別の実 WebGL 検証対象。
  }
}

function scene(events: Event[]): EventScene {
  return { id: 'stage', title: 'stage', view: 'TopDown', events }
}

function dialog(position: string | null, depth: number): Event {
  return {
    Dialog: {
      // 立ち絵そのものは本件の対象外。jsdom の Pixi CanvasTextMetrics を避けつつ、
      // Dialog の既存 position/depth からの音響配線だけを観測する。
      character: null,
      expression: 'normal',
      position,
      text: ['なんでやねん！'],
      voice_path: 'boke.ogg',
      depth,
    },
  }
}

describe('NovelRenderer voice spatialization (#696)', () => {
  it('シアターモードの Dialog voice だけに既存 position/depth の空間パラメータを渡す', async () => {
    const renderer = new NovelRenderer()
    const playVoice = vi.spyOn(renderer.getAudioManager(), 'playVoice').mockResolvedValue(undefined)
    enableRenderWithoutCanvas(renderer)
    renderer.setScenes([scene([{ CameraMode: { mode: 'Theater' } }, dialog('右', 10)])])
    await startThroughVoicePath(renderer)

    expect(playVoice).toHaveBeenCalledWith(
      expect.stringContaining('/sounds/boke.ogg'),
      undefined,
      expect.objectContaining({ pan: 0.625, gain: 0.5, lowpassHz: 10000 })
    )
  })

  it('Novel モードの Dialog voice は従来どおり空間パラメータなしで再生する', async () => {
    const renderer = new NovelRenderer()
    const playVoice = vi.spyOn(renderer.getAudioManager(), 'playVoice').mockResolvedValue(undefined)
    enableRenderWithoutCanvas(renderer)
    renderer.setScenes([scene([dialog('右', 10)])])
    await startThroughVoicePath(renderer)

    expect(playVoice).toHaveBeenCalledWith(expect.any(String), undefined, null)
  })

  it('シアターモードでも Narration voice は空間パラメータなしで再生する', async () => {
    const renderer = new NovelRenderer()
    const playVoice = vi.spyOn(renderer.getAudioManager(), 'playVoice').mockResolvedValue(undefined)
    enableRenderWithoutCanvas(renderer)
    renderer.setScenes([
      scene([
        { CameraMode: { mode: 'Theater' } },
        { Narration: { text: ['地の文'], voice_path: 'narration.ogg' } },
      ]),
    ])
    await startThroughVoicePath(renderer)

    expect(playVoice).toHaveBeenCalledWith(expect.any(String), undefined, null)
  })
})
