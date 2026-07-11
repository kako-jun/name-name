import { afterEach, describe, expect, it, vi } from 'vitest'
import { Assets, Texture } from 'pixi.js'
import { NovelRenderer } from './NovelRenderer'
import type { Event, EventScene } from '../types'

interface CharacterLayerForTest {
  hasPendingVisualTransition: () => boolean
  show: (...args: unknown[]) => void
}

interface RendererInternals {
  eventIndex: number
  waitingForWait: boolean
  waitDisplayCompleteTimer: number | null
  initialized: boolean
  characterLayer: CharacterLayerForTest
  render(): void
}

function internals(r: NovelRenderer): RendererInternals {
  return r as unknown as RendererInternals
}

function flushPromises(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

function narration(text: string): Event {
  return { Narration: { text: [text], voice_path: null, font_family: null } }
}

function enter(character: string): Event {
  return { Enter: { character, expression: `${character}-normal`, position: '中央' } }
}

function scene(events: Event[]): EventScene {
  return { id: 's', title: 's', view: 'TopDown', events }
}

function makeRenderer(events: Event[]): NovelRenderer {
  const r = new NovelRenderer()
  r.setAssetBaseUrl('/assets')
  r.setCharacterFadeMs(0)
  r.getTimeController().setMode('virtual')
  internals(r).initialized = true
  vi.spyOn(internals(r).characterLayer, 'show')
  vi.spyOn(internals(r), 'render').mockImplementation(() => {})
  r.setScenes([scene(events)])
  return r
}

describe('NovelRenderer WaitDisplayComplete (#411)', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('pending が無い場合も同期では進まず、timer tick 後に一度だけ進む', () => {
    const r = makeRenderer(['WaitDisplayComplete', narration('after')])
    const h = internals(r)

    expect(h.eventIndex).toBe(0)
    expect(h.waitingForWait).toBe(true)
    expect(h.waitDisplayCompleteTimer).not.toBeNull()

    r.getTimeController().tick(15)
    expect(h.eventIndex).toBe(0)
    expect(h.waitingForWait).toBe(true)

    r.getTimeController().tick(1)
    expect(h.eventIndex).toBe(1)
    expect(h.waitingForWait).toBe(false)
    expect(h.waitDisplayCompleteTimer).toBeNull()

    r.getTimeController().tick(64)
    expect(h.eventIndex).toBe(1)
  })

  it('立ち絵 load 中は停止し、resolve 後の tick で進む', async () => {
    let resolveLoad!: (texture: Texture) => void
    vi.spyOn(Assets, 'load').mockReturnValue(
      new Promise<Texture>((resolve) => {
        resolveLoad = resolve
      }) as never
    )
    vi.spyOn(Assets, 'unload').mockResolvedValue(undefined as never)

    const r = makeRenderer([enter('A'), 'WaitDisplayComplete', narration('after')])
    const h = internals(r)

    expect(h.eventIndex).toBe(1)
    r.getTimeController().tick(48)
    expect(h.eventIndex).toBe(1)
    expect(h.waitingForWait).toBe(true)

    resolveLoad(Texture.WHITE)
    await flushPromises()

    r.getTimeController().tick(16)
    expect(h.eventIndex).toBe(2)
    expect(h.waitingForWait).toBe(false)
  })

  it('立ち絵 load reject 後も永久待機しない', async () => {
    vi.spyOn(Assets, 'load').mockRejectedValue(new Error('missing') as never)
    vi.spyOn(Assets, 'unload').mockResolvedValue(undefined as never)
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    const r = makeRenderer([enter('A'), 'WaitDisplayComplete', narration('after')])
    const h = internals(r)

    expect(h.eventIndex).toBe(1)
    await flushPromises()
    r.getTimeController().tick(48)
    expect(h.eventIndex).toBe(1)

    r.getTimeController().tick(300)
    await flushPromises()
    await flushPromises()

    r.getTimeController().tick(16)
    expect(h.eventIndex).toBe(2)
    expect(h.waitingForWait).toBe(false)
  })

  it('立ち絵 fade 中は停止し、fade 完了後に進む', () => {
    vi.spyOn(Assets, 'load').mockResolvedValue(Texture.WHITE as never)
    vi.spyOn(Assets, 'unload').mockResolvedValue(undefined as never)

    const r = makeRenderer([enter('A'), 'WaitDisplayComplete', narration('after')])
    const h = internals(r)
    let pending = true
    vi.spyOn(h.characterLayer, 'hasPendingVisualTransition').mockImplementation(() => pending)

    expect(h.eventIndex).toBe(1)
    r.getTimeController().tick(64)
    expect(h.eventIndex).toBe(1)
    expect(h.waitingForWait).toBe(true)

    pending = false
    r.getTimeController().tick(16)
    expect(h.eventIndex).toBe(2)
    expect(h.waitingForWait).toBe(false)
  })

  it('[登場:] 複数連続は同期的に処理され、WaitDisplayComplete で初めて待つ', () => {
    vi.spyOn(Assets, 'load').mockResolvedValue(Texture.WHITE as never)
    vi.spyOn(Assets, 'unload').mockResolvedValue(undefined as never)

    const r = makeRenderer([enter('A'), enter('B'), 'WaitDisplayComplete', narration('after')])
    const h = internals(r)
    let pending = true
    vi.spyOn(h.characterLayer, 'hasPendingVisualTransition').mockImplementation(() => pending)

    expect(h.characterLayer.show).toHaveBeenCalledTimes(2)
    expect(h.eventIndex).toBe(2)
    expect(h.waitingForWait).toBe(true)

    r.getTimeController().tick(32)
    expect(h.eventIndex).toBe(2)

    pending = false
    r.getTimeController().tick(16)
    expect(h.eventIndex).toBe(3)
  })

  it('wait 中に startFrom しても旧 interval は新しい位置を進めない', () => {
    const r = makeRenderer(['WaitDisplayComplete', narration('after')])
    const h = internals(r)

    expect(h.waitingForWait).toBe(true)
    r.startFrom({ sceneId: 's', eventIndex: 1 })
    const afterStart = r.getSnapshot()

    r.getTimeController().tick(64)
    expect(r.getSnapshot()).toEqual(afterStart)
    expect(h.waitingForWait).toBe(false)
    expect(h.waitDisplayCompleteTimer).toBeNull()
  })
})
