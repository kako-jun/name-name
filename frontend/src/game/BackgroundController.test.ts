import { afterEach, describe, expect, it, vi } from 'vitest'
import { Assets, Container, Sprite, Texture } from 'pixi.js'
import {
  BackgroundController,
  brightnessToTint,
  normalizeBackgroundBrightness,
  type BackgroundHost,
} from './BackgroundController'
import { TimeController } from './TimeController'

interface Entry {
  sprite: Sprite
  fadeAnimation: {
    startMs: number
    durationMs: number
    fromAlpha: number
    toAlpha: number
    destroyOnComplete: boolean
  } | null
}
interface Internals {
  textureCache: Map<string, Texture>
  bgEntries: Entry[]
}

function setup(duration = 100) {
  const state = { base: '/assets', skip: false, initialized: true }
  const host: BackgroundHost = {
    getAssetBaseUrl: () => state.base,
    isSkipMode: () => state.skip,
    isInitialized: () => state.initialized,
    getScreenSize: () => ({ width: 1280, height: 720 }),
    getCrossfadeMs: () => duration,
  }
  const time = new TimeController()
  time.setMode('virtual')
  const controller = new BackgroundController(host, time)
  const inner = controller as unknown as Internals
  controller.attachTo(new Container())
  const cache = (path: string) => inner.textureCache.set(`/assets/images/${path}`, Texture.WHITE)
  return { controller, inner, state, time, cache }
}

function loads() {
  const requests: Array<{ resolve: (t: Texture) => void; reject: (e: Error) => void }> = []
  vi.spyOn(Assets, 'load').mockImplementation(
    () => new Promise((resolve, reject) => requests.push({ resolve, reject })) as never
  )
  return requests
}

// Reference oracle copied from NovelRenderer.updateBackgroundFadeFrame before extraction
// (origin/main 563d8cd). It deliberately does not call the new controller or shared helpers.
function oldFrame(entry: NonNullable<Entry['fadeAnimation']>, now: number) {
  const t =
    entry.durationMs <= 0 ? 1 : Math.min(1, Math.max(0, (now - entry.startMs) / entry.durationMs))
  return {
    alpha: t >= 1 ? entry.toAlpha : entry.fromAlpha + (entry.toAlpha - entry.fromAlpha) * t,
    removed: t >= 1 && entry.destroyOnComplete,
    active: t < 1,
  }
}

afterEach(() => vi.restoreAllMocks())

describe('BackgroundController extraction contract (#828 7a)', () => {
  it('attaches base before images and releases cached URLs after cleanup without owning image sources', async () => {
    const { controller, inner, cache } = setup()
    const stage = new Container()
    controller.attachTo(stage)
    expect(stage.children).toEqual([controller.graphics, controller.container])
    cache('a.png')
    cache('b.png')
    controller.setBackground('a.png', null, null, { instant: true })
    const sourceDestroy = vi.spyOn(Texture.WHITE.source, 'destroy')
    const unload = vi.spyOn(Assets, 'unload').mockResolvedValue(undefined as never)
    controller.clearBackground()
    controller.releaseTextures()
    expect(unload.mock.calls.map(([url]) => url)).toEqual([
      '/assets/images/a.png',
      '/assets/images/b.png',
    ])
    expect(inner.textureCache.size).toBe(0)
    expect(sourceDestroy).not.toHaveBeenCalled()
    await controller.waitForLoad()
  })

  it('accepts old saves without backgroundColor and repaints the default', () => {
    const { controller } = setup()
    controller.setDefaultBackgroundColor('#123456')
    controller.setBackgroundColor('#abcdef')
    const fill = vi.spyOn(controller.graphics, 'fill')
    controller.restore({
      backgroundPath: null,
      backgroundFade: null,
      backgroundBrightness: null,
    } as Parameters<BackgroundController['restore']>[0])
    expect(controller.capture()).toEqual({
      backgroundPath: null,
      backgroundColor: null,
      backgroundFade: null,
      backgroundBrightness: null,
    })
    expect(fill).toHaveBeenLastCalledWith(0x123456)
  })
  it.each([
    -Number.EPSILON,
    0,
    Number.EPSILON,
    1 - Number.EPSILON,
    1,
    1 + Number.EPSILON,
    NaN,
    Infinity,
    -Infinity,
    null,
    undefined,
  ])('preserves the old brightness normalization/tint for %s', (raw) => {
    const normalized = raw == null || !Number.isFinite(raw) || raw >= 1 ? null : Math.max(0, raw)
    const channel = normalized == null ? 255 : Math.round(normalized * 255)
    expect(normalizeBackgroundBrightness(raw)).toBe(normalized)
    expect(brightnessToTint(raw)).toBe((channel << 16) | (channel << 8) | channel)
  })

  it.each([0, 1, 100, 350])(
    'matches the old frame oracle at duration %s and its boundaries',
    (duration) => {
      for (const elapsed of [...new Set([0, Math.max(0, duration - 1), duration, duration + 1])]) {
        const { controller, inner, cache, time } = setup(duration)
        cache('a.png')
        cache('b.png')
        controller.setBackground('a.png', null, null, { instant: true })
        controller.setBackground('b.png')
        const reference = [
          { startMs: 0, durationMs: duration, fromAlpha: 1, toAlpha: 0, destroyOnComplete: true },
          { startMs: 0, durationMs: duration, fromAlpha: 0, toAlpha: 1, destroyOnComplete: false },
        ]
          .map((entry) => oldFrame(entry, elapsed))
          .filter((entry) => !entry.removed)
        time.tick(elapsed)
        controller.updateBackgroundFadeFrame()
        expect(inner.bgEntries.map((entry) => entry.sprite.alpha)).toEqual(
          reference.map((entry) => entry.alpha)
        )
        expect(controller.hasActiveBackgroundFade()).toBe(reference.some((entry) => entry.active))
        controller.clearBackground()
      }
    }
  )

  it.each([false, true])(
    'honors cache × same-path × skip × explicit instant (cached=%s)',
    async (cached) => {
      for (const same of [false, true])
        for (const skip of [false, true])
          for (const instant of [false, true]) {
            const { controller, inner, state, cache } = setup()
            const requests = loads()
            cache('previous.png')
            controller.setBackground('previous.png', null, null, { instant: true })
            const path = same ? 'previous.png' : 'next.png'
            if (cached) cache(path)
            // Evict the initial path too, so same-path without a cache really tests async.
            else inner.textureCache.delete(`/assets/images/${path}`)
            state.skip = skip
            controller.setBackground(path, null, 0.5, { instant })
            if (!cached) requests[0].resolve(Texture.WHITE)
            await controller.waitForLoad()
            expect(controller.hasActiveBackgroundFade()).toBe(!(same || skip || instant))
            expect(inner.bgEntries[inner.bgEntries.length - 1]?.sprite.tint).toBe(0x808080)
            expect(controller.capture().backgroundPath).toBe(path)
            controller.clearBackground()
            vi.restoreAllMocks()
          }
    }
  )

  it('captures only declared fields, restores immediately, and keeps default color independent', () => {
    const { controller, cache, inner } = setup()
    cache('a.png')
    controller.setDefaultBackgroundColor('#123456')
    controller.restore({
      backgroundPath: 'a.png',
      backgroundColor: '#abcdef',
      backgroundFade: null,
      backgroundBrightness: 0.4,
    })
    expect(controller.capture()).toEqual({
      backgroundPath: 'a.png',
      backgroundColor: '#abcdef',
      backgroundFade: null,
      backgroundBrightness: 0.4,
    })
    expect(inner.bgEntries[0].sprite.alpha).toBe(1)
    expect(controller.hasActiveBackgroundFade()).toBe(false)
    const fill = vi.spyOn(controller.graphics, 'fill')
    controller.setDefaultBackgroundColor('#654321')
    expect(fill).not.toHaveBeenCalled()
    controller.clearBackgroundColor()
    expect(fill).toHaveBeenLastCalledWith(0x654321)
    controller.setVisible(false)
    expect(controller.graphics.visible).toBe(false)
    expect(controller.container.visible).toBe(false)
    controller.clearBackground()
  })

  it('old resolution/finally cannot draw or clear the newer pending request', async () => {
    const { controller, inner } = setup()
    const requests = loads()
    controller.setBackground('a.png')
    const old = controller.waitForLoad()
    controller.setBackground('b.png')
    requests[0].resolve(Texture.WHITE)
    await old
    expect(controller.hasPendingBackgroundLoad()).toBe(true)
    expect(inner.bgEntries).toHaveLength(0)
    requests[1].resolve(Texture.WHITE)
    await controller.waitForLoad()
    expect(controller.hasPendingBackgroundLoad()).toBe(false)
    expect(inner.bgEntries).toHaveLength(1)
    expect(controller.capture().backgroundPath).toBe('b.png')
    controller.clearBackground()
  })

  it.each(['clear', 'carry', 'restore', 'destroy', 'cache'] as const)(
    'invalidates stale completion after %s',
    async (action) => {
      const { controller, inner, state, cache } = setup()
      const requests = loads()
      controller.setBackground('old.png')
      const old = controller.waitForLoad()
      if (action === 'clear') controller.clearBackground()
      if (action === 'carry') controller.cancelPendingLoad()
      if (action === 'destroy') {
        controller.releaseTextures()
        controller.clearBackgroundEntries()
        state.initialized = false
      }
      if (action === 'restore')
        controller.restore({
          backgroundPath: null,
          backgroundColor: null,
          backgroundFade: null,
          backgroundBrightness: null,
        })
      if (action === 'cache') {
        cache('new.png')
        controller.setBackground('new.png', null, null, { instant: true })
      }
      requests[0].resolve(Texture.WHITE)
      await old
      expect(controller.hasPendingBackgroundLoad()).toBe(false)
      expect(inner.bgEntries).toHaveLength(action === 'cache' ? 1 : 0)
      expect(inner.textureCache.has('/assets/images/old.png')).toBe(false)
      controller.clearBackground()
    }
  )

  it('reject resolves the wait and releases pending, while skip enabled during loading makes it instant', async () => {
    const { controller, state, inner } = setup()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const requests = loads()
    controller.setBackground('bad.png')
    const wait = controller.waitForLoad()
    requests[0].reject(new Error('404'))
    await expect(wait).resolves.toBeUndefined()
    expect(warn).toHaveBeenCalledTimes(1)
    expect(controller.hasPendingBackgroundLoad()).toBe(false)
    controller.setBackground('good.png')
    state.skip = true
    requests[1].resolve(Texture.WHITE)
    await controller.waitForLoad()
    expect(inner.bgEntries[0].sprite.alpha).toBe(1)
    expect(controller.hasActiveBackgroundFade()).toBe(false)
    controller.clearBackground()
  })

  it('finishes carry/skip, then forgets state while fading the final image out', () => {
    const { controller, cache, inner, time } = setup()
    cache('a.png')
    controller.setBackground('a.png')
    time.tick(32)
    controller.finishBackgroundCrossfadeInstant()
    expect(inner.bgEntries[0].sprite.alpha).toBe(1)
    controller.forgetBackground()
    expect(controller.capture().backgroundPath).toBe(null)
    expect(inner.bgEntries).toHaveLength(1)
    controller.fadeOutBackgroundEntries(100)
    time.tick(100)
    controller.updateBackgroundFadeFrame()
    expect(inner.bgEntries).toHaveLength(0)
    expect(controller.hasActiveBackgroundFade()).toBe(false)
  })
})
