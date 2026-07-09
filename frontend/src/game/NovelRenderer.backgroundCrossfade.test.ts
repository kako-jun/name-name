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
import type { Event, EventScene } from '../types'

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
  /** #407: setBackgroundFadeMs が clamp/フォールバックして保持する背景フェード時間（ms）。 */
  backgroundFadeMs: number
  /** #407: 終劇時に stopBgm(backgroundFadeMs) を検証するための AudioManager 参照。 */
  audioManager: { stopBgm: (ms?: number) => void }
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

function background(path: string): Event {
  return {
    Background: {
      path,
      fade_top: null,
      fade_bottom: null,
      fade_left: null,
      fade_right: null,
      brightness: null,
    },
  }
}

function narration(text: string): Event {
  return { Narration: { text: [text], voice_path: null, font_family: null } }
}

function scene(id: string, events: Event[]): EventScene {
  return { id, title: id, view: 'TopDown', events }
}

describe('NovelRenderer 背景クロスフェード', () => {
  afterEach(() => {
    defaultTimeController.setMode('live')
    vi.restoreAllMocks()
  })

  it('新背景がロード済みになるまで旧背景を消さない', async () => {
    const r = makeRenderer()
    cacheTexture(r, 'old.png')
    // #409 で最初の背景（コールドスタート）も alpha 0→1 でフェードインするようになったため、
    // 「2 枚目へのクロスフェード」を検証する本テストでは 1 枚目を instant で settle（alpha=1）させ、
    // 「既に前景がある」状態を precondition として作る（このテストは初回背景の fade 自体は検証しない）。
    internals(r).setBackground('old.png', undefined, undefined, { instant: true })

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
    // #409: 1 枚目は instant で settle（alpha=1）。これで 2 枚目の crossfade は old(1→0)/new(0→1) の
    // クリーンな対称フェードになる（コールドスタート fade 中の中途 alpha が混ざらない）。
    internals(r).setBackground('old.png', undefined, undefined, { instant: true })
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
    // #409: ロード解決後、コールドスタート初回背景も alpha 0→1 でフェードインするようになったため、
    // 本文描画（renderOnce/afterShow）は「ロード完了」に加えて「そのフェード完了」まで待つ。
    // ロード完了ゲート自体は resolveLoad 前の afterShow/render 未呼び出しアサートで担保済み。
    // ここではフェード分も進めて解禁を観測する（tick を fade 時間ぶんに伸ばすだけ・アサートは不変）。
    r.getTimeController().tick(BACKGROUND_CROSSFADE_MS + 16)

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

  it('通常の scene jump は前シーン背景を残し、次シーン先頭の背景へクロスフェードする', () => {
    const r = makeRenderer()
    r.setDialogStyle('novel')
    const inner = internals(r)
    inner.render = vi.fn()
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
      cb(0)
      return 0
    })

    r.setScenes([
      scene('old-scene', [narration('old')]),
      scene('new-scene', [background('new.png'), narration('new')]),
    ])
    cacheTexture(r, 'old.png')
    cacheTexture(r, 'new.png')
    // #409: 前シーンの背景は既に settle 済み（instant で alpha=1）とし、scene jump で走る
    // 「次シーン先頭背景への crossfade」を検証する。1 枚目は初回背景の fade 対象ではない。
    inner.setBackground('old.png', undefined, undefined, { instant: true })
    expect(inner.bgEntries).toHaveLength(1)
    expect(inner.bgEntries[0].sprite.alpha).toBe(1)

    r.jumpToScene('new-scene')

    expect(inner.bgEntries).toHaveLength(2)
    expect(inner.bgEntries[0].fadeAnimation).toMatchObject({
      fromAlpha: 1,
      toAlpha: 0,
      destroyOnComplete: true,
    })
    expect(inner.bgEntries[1].fadeAnimation).toMatchObject({
      fromAlpha: 0,
      toAlpha: 1,
      destroyOnComplete: false,
    })
  })
})

// =====================================================================================
// #407: background_fade_ms — 背景フェード時間の per-game 可変化。
//   frontmatter `background_fade_ms:` → NovelPlayer → renderer.setBackgroundFadeMs(ms)。
//   背景クロスフェード（表示イン・切替）・終劇フェードアウト（退場）・BGM 停止フェードの
//   3 経路すべてがこの時間で動く。未指定は既定 BACKGROUND_CROSSFADE_MS(=700ms) で非回帰。
//   setter は [0, 5000] にクランプ、null/undefined/非有限は既定へフォールバックする
//   （CharacterLayer.setCharacterFadeMs と対称）。
// =====================================================================================
describe('NovelRenderer 背景フェード時間 background_fade_ms (#407)', () => {
  afterEach(() => {
    defaultTimeController.setMode('live')
    vi.restoreAllMocks()
  })

  it('setBackgroundFadeMs(2000) 後の背景クロスフェードは durationMs=2000 で走る', () => {
    const r = makeRenderer()
    cacheTexture(r, 'old.png')
    cacheTexture(r, 'new.png')
    r.setBackgroundFadeMs(2000)
    // #409 以降、初回背景は放置すると alpha 0→1 でフェードインするため、2 枚目の crossfade 時間を
    // 測る本テストでは 1 枚目を明示的に instant で settle させる（前景 alpha=1 を precondition に）。
    internals(r).setBackground('old.png', undefined, undefined, { instant: true })
    internals(r).setBackground('new.png') // クロスフェード（durationMs = backgroundFadeMs）

    const entries = internals(r).bgEntries
    expect(entries).toHaveLength(2)
    // old(退場) / new(登場) 両方が 2000ms のフェードになる。
    expect(entries[0].fadeAnimation?.durationMs).toBe(2000)
    expect(entries[1].fadeAnimation?.durationMs).toBe(2000)
  })

  it('未指定（setter 未呼び出し）の背景クロスフェードは既定 BACKGROUND_CROSSFADE_MS のまま（非回帰）', () => {
    const r = makeRenderer()
    cacheTexture(r, 'old.png')
    cacheTexture(r, 'new.png')
    // setBackgroundFadeMs を呼ばない ＝ frontmatter 未指定の作品。
    // #409: 1 枚目は instant で settle し、2 枚目の crossfade duration（既定 700）だけを見る。
    internals(r).setBackground('old.png', undefined, undefined, { instant: true })
    internals(r).setBackground('new.png')

    const entries = internals(r).bgEntries
    expect(entries).toHaveLength(2)
    // 定数を参照して将来の既定変更に追随する（直書き 700 にしない）。
    expect(entries[0].fadeAnimation?.durationMs).toBe(BACKGROUND_CROSSFADE_MS)
    expect(entries[1].fadeAnimation?.durationMs).toBe(BACKGROUND_CROSSFADE_MS)
  })

  it('setBackgroundFadeMs は [0,5000] にクランプし null/undefined/非有限は既定へフォールバックする', () => {
    const r = makeRenderer()
    const inner = internals(r)

    r.setBackgroundFadeMs(2000)
    expect(inner.backgroundFadeMs).toBe(2000)
    r.setBackgroundFadeMs(2000.9) // Math.floor
    expect(inner.backgroundFadeMs).toBe(2000)

    // 上限クランプ: 99999 → 5000。
    r.setBackgroundFadeMs(99999)
    expect(inner.backgroundFadeMs).toBe(5000)
    // 下限クランプ: -1 → 0（実装 clamp [0,5000]。下限は 0 であって既定 700 ではない）。
    r.setBackgroundFadeMs(-1)
    expect(inner.backgroundFadeMs).toBe(0)
    // 境界値そのものは保持される。
    r.setBackgroundFadeMs(0)
    expect(inner.backgroundFadeMs).toBe(0)
    r.setBackgroundFadeMs(5000)
    expect(inner.backgroundFadeMs).toBe(5000)

    // null/undefined/NaN/±Infinity は既定 BACKGROUND_CROSSFADE_MS にフォールバック。
    for (const bad of [null, undefined, NaN, Infinity, -Infinity]) {
      r.setBackgroundFadeMs(2000) // 一度別値にしてからフォールバックを観測
      r.setBackgroundFadeMs(bad as number | null | undefined)
      expect(inner.backgroundFadeMs).toBe(BACKGROUND_CROSSFADE_MS)
    }
  })

  it('上限クランプは実クロスフェードの durationMs にも効く（99999 → 5000）', () => {
    const r = makeRenderer()
    cacheTexture(r, 'old.png')
    cacheTexture(r, 'new.png')
    r.setBackgroundFadeMs(99999)
    // #409: 1 枚目は instant で settle。2 枚目の crossfade duration に上限クランプ（5000）が効くのを見る。
    internals(r).setBackground('old.png', undefined, undefined, { instant: true })
    internals(r).setBackground('new.png')

    const entries = internals(r).bgEntries
    expect(entries).toHaveLength(2)
    expect(entries[1].fadeAnimation?.durationMs).toBe(5000)
  })

  it('終劇（圏外ジャンプ）の背景フェードアウトと BGM 停止フェードも background_fade_ms を使う', () => {
    const r = makeRenderer()
    r.setScenes([scene('entry', [narration('start')]), scene('out', [narration('outside')])])
    r.setConfinedSceneIds(['entry'])
    cacheTexture(r, 'bg.png')
    // #409: 1 枚目を instant で settle（alpha=1）させ、終劇の背景フェードアウトが「表示中の 1 枚」を
    // 1→0 で退場させるのを見る（初回背景の cold-start fade とは別経路）。
    internals(r).setBackground('bg.png', undefined, undefined, { instant: true })
    expect(internals(r).bgEntries).toHaveLength(1)

    const stopBgmSpy = vi.spyOn(internals(r).audioManager, 'stopBgm')
    r.setBackgroundFadeMs(2000)
    r.jumpToScene('out') // 圏外 → 終劇（endStory）

    expect(r.getSnapshot().storyEnded).toBe(true)
    // 背景フェードアウト（退場）が 2000ms・destroyOnComplete で走る。
    const entries = internals(r).bgEntries
    expect(entries).toHaveLength(1)
    expect(entries[0].fadeAnimation?.durationMs).toBe(2000)
    expect(entries[0].fadeAnimation?.toAlpha).toBe(0)
    expect(entries[0].fadeAnimation?.destroyOnComplete).toBe(true)
    // BGM 停止フェードも同じ時間（#407）。
    expect(stopBgmSpy).toHaveBeenCalledWith(2000)
  })
})
