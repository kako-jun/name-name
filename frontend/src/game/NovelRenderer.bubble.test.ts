import { describe, expect, it, vi } from 'vitest'

/**
 * NovelRenderer の配線を Node 環境で検証する。BubbleLayer の Pixi Text 実測と
 * DialogBox の Canvas/typewriter 実装は各単体テストで実体検証済みのため、ここでは
 * その公開契約だけを最小のテストダブルで再現する。
 */
vi.mock('./BubbleLayer', () => {
  class BubbleLayerForRendererTest {
    visible = false
    x = 0
    y = 0
    private text = ''
    private fullText = ''
    show(options: {
      style: string
      text: string
      visibleCharacterCount: number
      xRatio: number
      screenWidth?: number
    }): void {
      this.fullText = options.text
      this.text = options.text.slice(0, options.visibleCharacterCount)
      this.x = options.style === 'ナレーション' ? 640 : 1280 * options.xRatio
      this.visible = true
    }
    hide(): void {
      this.visible = false
    }
    setVisibleCharacterCount(count: number): void {
      this.text = this.fullText.slice(0, count)
    }
    getVisibleText(): string {
      return this.text
    }
  }
  return { BubbleLayer: BubbleLayerForRendererTest }
})

vi.mock('./DialogBox', () => {
  class DialogBoxForRendererTest {
    visible = false
    private text = ''
    private onVisibleCharacterCount: ((count: number) => void) | null = null
    onVisibleCharacterCountChange(listener: (count: number) => void): void {
      this.onVisibleCharacterCount = listener
    }
    setDialog(_name: string | null, text: string): void {
      this.text = text
      this.visible = true
      this.onVisibleCharacterCount?.(0)
    }
    setNovelDialogProgressive(_name: string | null, text: string): void {
      this.setDialog(_name, text)
    }
    getVisibleCharacterCount(): number {
      return 0
    }
    skipTypewriter(): void {
      this.onVisibleCharacterCount?.(this.text.length)
    }
    clearText(): void {
      this.text = ''
      this.visible = false
      this.onVisibleCharacterCount?.(0)
    }
    hide(): void {
      this.visible = false
    }
    setFontFamily(): void {}
    setFontSize(): void {}
    setBorderless(): void {}
    setNovelMode(): void {}
    setBodyTextColor(): void {}
    setDualWindowActiveRole(): void {}
    setIndicatorKind(): void {}
    setIndicatorVisible(): void {}
    setNovelStyle(): void {}
    setNovelBottomReserve(): void {}
    getMsPerChar(): number {
      return 30
    }
    setMsPerChar(): void {}
    measureLineCount(): number {
      return 1
    }
    novelMaxLinesPerPage(): number {
      return 1
    }
  }
  return { DialogBox: DialogBoxForRendererTest }
})

vi.mock('./EventImageLayer', () => {
  class EventImageLayerForRendererTest {
    visible = false
    remove(): void {}
    disposeTextures(): void {}
    setAssetBaseUrl(): void {}
    setFullscreenMode(): void {}
    setPixelArt(): void {}
    setSplitLayoutRegion(): void {}
    getState(): null {
      return null
    }
    restore(): void {}
    shouldHideBackLayer(): boolean {
      return false
    }
    hasPendingVisualTransition(): boolean {
      return false
    }
    handleWheel(): boolean {
      return false
    }
  }
  return { EventImageLayer: EventImageLayerForRendererTest }
})

import { NovelRenderer } from './NovelRenderer'
import type { Event, EventScene } from '../types'

vi.mock('./FontLoader', () => ({ ensureFontLoaded: vi.fn(() => Promise.resolve()) }))

function dialog(text: string, bubble_style?: string | null): Event {
  return {
    Dialog: { character: 'A', expression: null, position: 'right', text: [text], bubble_style },
  }
}

function narration(text: string, bubble_style?: string | null): Event {
  return { Narration: { text: [text], bubble_style } }
}

function scene(id: string, events: Event[]): EventScene {
  return { id, title: id, view: 'TopDown', events }
}

interface RendererInternals {
  initialized: boolean
  dialogBox: {
    visible: boolean
    setDialog: (name: string, text: string) => void
    skipTypewriter: () => void
  }
  bubbleLayer: { visible: boolean; x: number; getVisibleText: () => string }
}

function internals(renderer: NovelRenderer): RendererInternals {
  return renderer as unknown as RendererInternals
}

function makeRenderer(): {
  renderer: NovelRenderer
} {
  const renderer = new NovelRenderer()
  const inner = internals(renderer)
  inner.initialized = true
  // BubbleLayer は実体を使い、可視化・typewriter 同期・スタイル入力を回帰させる。
  return { renderer }
}

describe('NovelRenderer bubble display wiring (#698)', () => {
  it('吹き出し指定は DialogBox を置換し、同じ typewriter の可視本文を表示して通常本文で戻る', async () => {
    const { renderer } = makeRenderer()
    renderer.setScenes([scene('a', [dialog('吹き出し', '叫び'), narration('従来本文')])])
    await Promise.resolve()

    expect(internals(renderer).dialogBox.visible).toBe(false)
    expect(internals(renderer).bubbleLayer.visible).toBe(true)
    // DialogBox が唯一の typewriter 所有者。skip により同じ全文が BubbleLayer に反映される。
    internals(renderer).dialogBox.skipTypewriter()
    expect(internals(renderer).bubbleLayer.getVisibleText()).toBe('吹き出し')

    await renderer.playScript([{ type: 'advance' }])
    expect(internals(renderer).dialogBox.visible).toBe(true)
    expect(internals(renderer).bubbleLayer.visible).toBe(false)
  })

  it('Dialog は話者位置、ナレーション指定は上方中央に描画する', async () => {
    const { renderer } = makeRenderer()
    renderer.setScenes([
      scene('a', [dialog('右の台詞', '通常'), narration('上方中央', 'ナレーション')]),
    ])
    // 既存 CHARACTER_X_RATIO の right（0.8125）をそのまま使い、吹き出し専用の座標表は持たない。
    await Promise.resolve()
    expect(internals(renderer).bubbleLayer.x).toBeGreaterThan(700)

    await renderer.playScript([{ type: 'advance' }])
    await Promise.resolve()
    expect(internals(renderer).bubbleLayer.x).toBe(640)
  })

  it('scene/reset/restore は古い吹き出しを残さず、復元先イベントから再導出する', () => {
    const { renderer } = makeRenderer()
    vi.spyOn(renderer.getAudioManager(), 'ensureContext').mockImplementation(() => {})
    renderer.setScenes([
      scene('a', [dialog('古い吹き出し', '静か')]),
      scene('b', [narration('通常本文')]),
    ])
    renderer.setEvents([], { skipAutoAdvance: true })
    expect(internals(renderer).bubbleLayer.visible).toBe(false)

    renderer.setScenes([
      scene('a', [dialog('古い吹き出し', '静か')]),
      scene('b', [narration('通常本文')]),
    ])
    renderer.restoreSnapshot({
      ...renderer.getSnapshot(),
      sceneId: 'b',
      eventIndex: 0,
      textIndex: 0,
    })
    expect(internals(renderer).bubbleLayer.visible).toBe(false)
    expect(internals(renderer).dialogBox.visible).toBe(true)
  })
})
