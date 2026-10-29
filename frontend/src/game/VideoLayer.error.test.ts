/**
 * VideoLayer の黒画面対策 (#980) のテスト。
 * - Texture を dynamic: true で作る（false だとメタデータ到着前に描画された Sprite が再描画されず黒いまま止まる）
 * - video の error イベントで警告する（黙って黒くならない）。hasError() と整合する
 * - remove() で error リスナーを外す（リーク防止）
 * pixi.js は最小スタブ。video 要素は jsdom のものを使う。
 */
import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest'

const textureOptions: Array<{ dynamic?: boolean }> = []

vi.mock('pixi.js', () => {
  class Container {
    children: unknown[] = []
    addChild(c: unknown) {
      this.children.push(c)
      return c
    }
  }
  class Sprite {
    texture: unknown
    anchor = { set: vi.fn() }
    scale = { set: vi.fn() }
    x = 0
    y = 0
    mask: unknown = null
    removeFromParent = vi.fn()
    destroy = vi.fn()
    constructor(texture?: unknown) {
      this.texture = texture
    }
  }
  class Texture {
    constructor(opts: { dynamic?: boolean }) {
      textureOptions.push(opts)
    }
  }
  return { Container, Sprite, Texture, VideoSource: class {} }
})

import { VideoLayer } from './VideoLayer'

let videoEl: HTMLVideoElement
let addSpy: MockInstance<HTMLVideoElement['addEventListener']>
let removeSpy: MockInstance<HTMLVideoElement['removeEventListener']>

beforeEach(() => {
  textureOptions.length = 0
  const realCreate = document.createElement.bind(document)
  vi.spyOn(document, 'createElement').mockImplementation(((tag: string) => {
    const el = realCreate(tag)
    if (tag === 'video') {
      videoEl = el as HTMLVideoElement
      addSpy = vi.spyOn(videoEl, 'addEventListener')
      removeSpy = vi.spyOn(videoEl, 'removeEventListener')
      vi.spyOn(videoEl, 'pause').mockImplementation(() => {})
      vi.spyOn(videoEl, 'load').mockImplementation(() => {})
    }
    return el
  }) as typeof document.createElement)
})

afterEach(() => {
  vi.restoreAllMocks()
})

function makeLayer(): VideoLayer {
  const layer = new VideoLayer(800, 450)
  layer.setAssetBaseUrl('/assets')
  return layer
}

describe('VideoLayer 黒画面対策 (#980)', () => {
  it('Texture を dynamic: true で作る', () => {
    makeLayer().show('a.webm')
    expect(textureOptions).toHaveLength(1)
    expect(textureOptions[0].dynamic).toBe(true)
  })

  it('error イベントで動画パスとエラーコード付きの警告を出す', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    makeLayer().show('a.webm')
    Object.defineProperty(videoEl, 'error', { value: { code: 4 }, configurable: true })
    videoEl.dispatchEvent(new Event('error'))
    expect(warn).toHaveBeenCalledTimes(1)
    const msg = String(warn.mock.calls[0][0])
    expect(msg).toContain('/assets/videos/a.webm')
    expect(msg).toContain('error code: 4')
  })

  it('error 時は hasError() が true（警告と同じ video.error を見る）', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const layer = makeLayer()
    layer.show('a.webm')
    expect(layer.hasError()).toBe(false)
    Object.defineProperty(videoEl, 'error', { value: { code: 3 }, configurable: true })
    videoEl.dispatchEvent(new Event('error'))
    expect(layer.hasError()).toBe(true)
  })

  it('remove() で error リスナーを外し、以後の error では警告しない', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const layer = makeLayer()
    layer.show('a.webm')
    const added = addSpy.mock.calls.find((c) => c[0] === 'error')
    expect(added).toBeDefined()
    layer.remove()
    expect(removeSpy).toHaveBeenCalledWith('error', added![1])
    videoEl.dispatchEvent(new Event('error'))
    expect(warn).not.toHaveBeenCalled()
  })

  it('show() の置換でも前の動画の error リスナーが残らない', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const layer = makeLayer()
    layer.show('a.webm')
    const first = videoEl
    layer.show('b.webm')
    first.dispatchEvent(new Event('error'))
    expect(warn).not.toHaveBeenCalled()
  })
})
