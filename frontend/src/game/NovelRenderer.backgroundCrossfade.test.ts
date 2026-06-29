/**
 * NovelRenderer 背景クロスフェード (#319) の内部状態テスト。
 *
 * CharacterLayer の fadeAnimation と同じ考え方で、背景も old/new を同時保持し、
 * 同一 startMs/durationMs の fromAlpha→toAlpha 補間で old 1→0 / new 0→1 を進める。
 * GameState には中間状態を持たないため、観測点は bgEntries / alpha / fadeAnimation のみ。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Assets, Texture } from 'pixi.js'
import { BACKGROUND_CROSSFADE_MS, NovelRenderer } from './NovelRenderer'
import type { NovelGameState } from './GameState'
import { defaultTimeController } from './TimeController'

interface BackgroundEntryForTest {
  sprite: {
    alpha: number
    tint?: number
    removeFromParent: () => void
    destroy: () => void
  }
  mask: null | {
    removeFromParent: () => void
    destroy: (opts?: unknown) => void
  }
  fadeAnimation: null | {
    startMs: number
    durationMs: number
    fromAlpha: number
    toAlpha: number
    destroyOnComplete: boolean
  }
}

interface RendererInternals {
  setBackground(
    path: string,
    fade?: unknown,
    brightness?: number | null,
    opts?: { instant?: boolean }
  ): void
  applyState(state: NovelGameState): void
  showCharacterThenRender(afterShow?: () => void): void
  render(): void
  updateBackgroundFadeFrame(): void
  resolvedEvents: unknown[]
  eventIndex: number
  textIndex: number
  sentenceIndex: number
  bgEntries: BackgroundEntryForTest[]
  bgCrossfadeTimer: number | null
  textureCache: Map<string, Texture>
  initialized: boolean
}

function internals(r: NovelRenderer): RendererInternals {
  return r as unknown as RendererInternals
}

function makeRenderer(): NovelRenderer {
  const r = new NovelRenderer()
  r.setAssetBaseUrl('/assets')
  r.getTimeController().setMode('virtual')
  internals(r).initialized = true
  return r
}

function cacheTexture(r: NovelRenderer, path: string): void {
  internals(r).textureCache.set(`/assets/images/${path}`, Texture.WHITE)
}

function baseState(r: NovelRenderer): NovelGameState {
  return {
    ...r.getSnapshot(),
    sceneId: 'a',
    eventIndex: 0,
    textIndex: 0,
    flags: {},
    isBlackout: false,
    characters: [],
    currentBgmPath: null,
  }
}

describe('NovelRenderer 背景クロスフェード', () => {
  afterEach(() => {
    defaultTimeController.setMode('live')
    vi.restoreAllMocks()
  })

  it('新背景がロード済みになるまで旧背景を消さない', async () => {
    const r = makeRenderer()
    cacheTexture(r, 'old.png')
    internals(r).setBackground('old.png')

    let resolveLoad!: (texture: Texture) => void
    vi.spyOn(Assets, 'load').mockReturnValue(
      new Promise<Texture>((resolve) => {
        resolveLoad = resolve
      }) as never
    )

    internals(r).setBackground('new.png')
    expect(internals(r).bgEntries).toHaveLength(1)
    expect(internals(r).bgEntries[0].sprite.alpha).toBe(1)

    resolveLoad(Texture.WHITE)
    await Promise.resolve()

    const entries = internals(r).bgEntries
    expect(entries).toHaveLength(2)
    expect(entries[0].fadeAnimation).toMatchObject({
      startMs: 0,
      durationMs: BACKGROUND_CROSSFADE_MS,
      fromAlpha: 1,
      toAlpha: 0,
      destroyOnComplete: true,
    })
    expect(entries[1].fadeAnimation).toMatchObject({
      startMs: 0,
      durationMs: BACKGROUND_CROSSFADE_MS,
      fromAlpha: 0,
      toAlpha: 1,
      destroyOnComplete: false,
    })
  })

  it('old 1→0 / new 0→1 を同じ時刻で進め、完了時に old だけ破棄する', () => {
    const r = makeRenderer()
    cacheTexture(r, 'old.png')
    cacheTexture(r, 'new.png')
    internals(r).setBackground('old.png')
    internals(r).setBackground('new.png')

    const halfDuration = BACKGROUND_CROSSFADE_MS / 2
    r.getTimeController().tick(halfDuration)
    internals(r).updateBackgroundFadeFrame()
    const mid = internals(r).bgEntries
    expect(mid).toHaveLength(2)
    expect(mid[0].sprite.alpha).toBeCloseTo(0.5, 2)
    expect(mid[1].sprite.alpha).toBeCloseTo(0.5, 2)

    r.getTimeController().tick(halfDuration)
    internals(r).updateBackgroundFadeFrame()
    const done = internals(r).bgEntries
    expect(done).toHaveLength(1)
    expect(done[0].sprite.alpha).toBe(1)
    expect(done[0].fadeAnimation).toBeNull()
    expect(internals(r).bgCrossfadeTimer).toBeNull()
    expect(r.getTimeController().getPendingTimerCount()).toBe(0)
  })

  it('fade-out 完了時に旧背景 entry の mask も一緒に破棄する', () => {
    const r = makeRenderer()
    const mask = {
      removeFromParent: vi.fn(),
      destroy: vi.fn(),
    }
    const oldEntry = {
      sprite: { alpha: 0.01, removeFromParent: vi.fn(), destroy: vi.fn() },
      mask,
      fadeAnimation: {
        startMs: 0,
        durationMs: BACKGROUND_CROSSFADE_MS,
        fromAlpha: 1,
        toAlpha: 0,
        destroyOnComplete: true,
      },
    }
    const newEntry = {
      sprite: { alpha: 0.99, removeFromParent: vi.fn(), destroy: vi.fn() },
      mask: null,
      fadeAnimation: {
        startMs: 0,
        durationMs: BACKGROUND_CROSSFADE_MS,
        fromAlpha: 0,
        toAlpha: 1,
        destroyOnComplete: false,
      },
    }
    internals(r).bgEntries = [oldEntry, newEntry]

    r.getTimeController().tick(BACKGROUND_CROSSFADE_MS + 16)
    internals(r).updateBackgroundFadeFrame()

    expect(oldEntry.sprite.removeFromParent).toHaveBeenCalledTimes(1)
    expect(oldEntry.sprite.destroy).toHaveBeenCalledTimes(1)
    expect(mask.removeFromParent).toHaveBeenCalledTimes(1)
    expect(mask.destroy).toHaveBeenCalledWith({ texture: true, textureSource: true })
    expect(internals(r).bgEntries).toEqual([newEntry])
  })

  it('applyState 復元は instant で不要なフェードを走らせない', () => {
    const r = makeRenderer()
    cacheTexture(r, 'old.png')
    cacheTexture(r, 'restored.png')
    internals(r).setBackground('old.png')

    internals(r).applyState({
      ...baseState(r),
      backgroundPath: 'restored.png',
      backgroundFade: null,
      backgroundBrightness: null,
    })

    expect(internals(r).bgEntries).toHaveLength(1)
    expect(internals(r).bgEntries[0].sprite.alpha).toBe(1)
    expect(internals(r).bgEntries[0].fadeAnimation).toBeNull()
    expect(internals(r).bgCrossfadeTimer).toBeNull()
  })

  it('skipMode と同一背景は instant でクロスフェードしない', () => {
    const r = makeRenderer()
    cacheTexture(r, 'same.png')
    cacheTexture(r, 'next.png')
    internals(r).setBackground('same.png')

    internals(r).setBackground('same.png')
    expect(internals(r).bgEntries).toHaveLength(1)
    expect(internals(r).bgEntries[0].fadeAnimation).toBeNull()

    r.setSkipMode(true)
    internals(r).setBackground('next.png')
    expect(internals(r).bgEntries).toHaveLength(1)
    expect(internals(r).bgEntries[0].sprite.alpha).toBe(1)
    expect(internals(r).bgEntries[0].fadeAnimation).toBeNull()
  })

  it('skipMode ON は進行中のクロスフェードも最新背景へ即時収束させる', () => {
    const r = makeRenderer()
    cacheTexture(r, 'old.png')
    cacheTexture(r, 'new.png')
    internals(r).setBackground('old.png')
    const oldEntry = internals(r).bgEntries[0]
    internals(r).setBackground('new.png')
    const newEntry = internals(r).bgEntries[1]
    expect(internals(r).bgEntries).toHaveLength(2)
    expect(internals(r).bgCrossfadeTimer).not.toBeNull()

    r.setSkipMode(true)

    expect(internals(r).bgEntries).toEqual([newEntry])
    expect(internals(r).bgEntries).not.toContain(oldEntry)
    expect(newEntry.sprite.alpha).toBe(1)
    expect(newEntry.fadeAnimation).toBeNull()
    expect(internals(r).bgCrossfadeTimer).toBeNull()
    expect(r.getTimeController().getPendingTimerCount()).toBe(0)
  })

  it('novel forward は背景クロスフェード完了後にスナップショットと本文描画へ進む', () => {
    const r = makeRenderer()
    r.setDialogStyle('novel')
    const inner = internals(r)
    inner.resolvedEvents = [{ Narration: { text: ['本文'] } }]
    inner.eventIndex = 0
    inner.textIndex = 0
    inner.sentenceIndex = 0
    const afterShow = vi.fn()
    inner.render = vi.fn()
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
      cb(0)
      return 0
    })
    inner.bgEntries = [
      {
        sprite: { alpha: 1, removeFromParent: vi.fn(), destroy: vi.fn() },
        mask: null,
        fadeAnimation: {
          startMs: 0,
          durationMs: BACKGROUND_CROSSFADE_MS,
          fromAlpha: 1,
          toAlpha: 0,
          destroyOnComplete: true,
        },
      },
      {
        sprite: { alpha: 0, removeFromParent: vi.fn(), destroy: vi.fn() },
        mask: null,
        fadeAnimation: {
          startMs: 0,
          durationMs: BACKGROUND_CROSSFADE_MS,
          fromAlpha: 0,
          toAlpha: 1,
          destroyOnComplete: false,
        },
      },
    ]

    inner.showCharacterThenRender(afterShow)
    expect(afterShow).not.toHaveBeenCalled()
    expect(inner.render).not.toHaveBeenCalled()

    r.getTimeController().tick(BACKGROUND_CROSSFADE_MS + 16)

    expect(afterShow).toHaveBeenCalledTimes(1)
    expect(inner.render).toHaveBeenCalledTimes(1)
    expect(inner.bgEntries).toHaveLength(1)
    expect(inner.bgEntries[0].sprite.alpha).toBe(1)
  })

  it('novel forward は非キャッシュ背景のロード完了まで本文描画へ進まない', async () => {
    const r = makeRenderer()
    r.setDialogStyle('novel')
    const inner = internals(r)
    inner.resolvedEvents = [{ Narration: { text: ['本文'] } }]
    inner.eventIndex = 0
    inner.textIndex = 0
    inner.sentenceIndex = 0
    const afterShow = vi.fn()
    inner.render = vi.fn()
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
      cb(0)
      return 0
    })
    let resolveLoad!: (texture: Texture) => void
    vi.spyOn(Assets, 'load').mockReturnValue(
      new Promise<Texture>((resolve) => {
        resolveLoad = resolve
      }) as never
    )

    inner.setBackground('loading.png')
    inner.showCharacterThenRender(afterShow)
    expect(afterShow).not.toHaveBeenCalled()
    expect(inner.render).not.toHaveBeenCalled()

    resolveLoad(Texture.WHITE)
    await Promise.resolve()
    r.getTimeController().tick(16)

    expect(afterShow).toHaveBeenCalledTimes(1)
    expect(inner.render).toHaveBeenCalledTimes(1)
    expect(inner.bgEntries).toHaveLength(1)
    expect(inner.bgEntries[0].sprite.alpha).toBe(1)
  })

  it('背景ロード待ち中に skipMode ON になった場合、解決後はクロスフェードせず即時置換する', async () => {
    const r = makeRenderer()
    const inner = internals(r)
    cacheTexture(r, 'old.png')
    inner.setBackground('old.png')
    const oldEntry = inner.bgEntries[0]
    let resolveLoad!: (texture: Texture) => void
    vi.spyOn(Assets, 'load').mockReturnValue(
      new Promise<Texture>((resolve) => {
        resolveLoad = resolve
      }) as never
    )

    inner.setBackground('new.png')
    r.setSkipMode(true)
    resolveLoad(Texture.WHITE)
    await Promise.resolve()

    expect(inner.bgEntries).toHaveLength(1)
    expect(inner.bgEntries).not.toContain(oldEntry)
    expect(inner.bgEntries[0].sprite.alpha).toBe(1)
    expect(inner.bgEntries[0].fadeAnimation).toBeNull()
    expect(inner.bgCrossfadeTimer).toBeNull()
  })
})
