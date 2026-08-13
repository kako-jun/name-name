/**
 * EventImageLayer（イベント絵レイヤー #351）の単体テスト。
 *
 * 検証方針（CLAUDE.md ルール7 / SeekBar.test.ts と同じ流儀）:
 *  - VideoLayer と違い、HTMLVideoElement・WebAudio・canvas マスクには依存しない
 *    （PixiJS Sprite/Texture + `Assets.load()` のみ）。CharacterLayer.test.ts と同じく
 *    `Assets.load` をモックすれば jsdom で本体の非同期経路まで検証できる。
 *  - フェード進行は `TimeController` を **virtual モードで注入**し、`tick()` で決定論的に進める
 *    （実 setTimeout/rAF に乗らない）。リークは `getPendingTimerCount()` で検証する。
 *  - sprite/fadeAnimation/current は private のため、internals キャストで読む
 *    （公開 API 経由で駆動した結果の観測に限定する）。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Assets, Texture } from 'pixi.js'
import { EventImageLayer } from './EventImageLayer'
import { TimeController } from './TimeController'
import { computeCoverFit, type LayoutRect } from './novelLayout'
import { PIXELATE_TRANSITION_MAX_SIZE } from './pixelateTransition'
import type { EventImageState } from './GameState'

const SCREEN_W = 800
const SCREEN_H = 450

/** virtual モードの TimeController を 1 つ作る（実時計に乗らず tick() で進める）。 */
function virtualTime(): TimeController {
  const t = new TimeController()
  t.setMode('virtual')
  return t
}

/** private sprite/fadeAnimation/current/loadToken を読むための internals ビュー。 */
interface EventImageLayerInternals {
  sprite: {
    alpha: number
    x: number
    y: number
    width: number
    height: number
    destroyed?: boolean
    // texture.source.scaleMode 観測用（#466 pixel_art）。
    texture?: { source?: { scaleMode?: string } }
    // ろうそく揺れ観測用（#582）。
    tint?: number
  } | null
  fadeAnimation: {
    startMs: number
    durationMs: number
    fromAlpha: number
    toAlpha: number
    destroyOnComplete: boolean
    onComplete?: () => void
  } | null
  current: { path: string; back: 'Hide' | 'Keep' } | null
  loadToken: number
  pendingLoadToken: number | null
  // アンビエント演出 (#582) 観測用。
  imageGroup: { filters: unknown[] | null }
  glowSprite: { alpha: number; blendMode?: string; destroyed?: boolean } | null
  ambientTimer: number | null
  vignetteFilter: unknown
  // ピクセレート遷移 (#583) 観測用。
  pixelateFilter: { sizeX: number } | null
  pixelateTimer: number | null
  pixelateState: {
    path: string
    durationMs: number
    swapAtMs: number
    phase: 'coarsen' | 'holding' | 'refine'
    refineStartMs: number
  } | null
}
function internals(layer: EventImageLayer): EventImageLayerInternals {
  return layer as unknown as EventImageLayerInternals
}

// flushPromises: show() の `Assets.load(url).then(...)` を解決させる
// （CharacterLayer.test.ts と同じ流儀。実 setTimeout(0) でマクロタスクを 1 回まわす）。
const flushPromises = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

function mockTexture(): Texture {
  // source.scaleMode 代入先（#466 pixel_art）。実 PixiJS Texture の `.source.scaleMode` 形状を模す。
  return { width: 100, height: 50, source: { scaleMode: 'linear' } } as unknown as Texture
}

/** 任意の幅・高さを持つテクスチャのモック（split_layout region の cover-fit 検証用）。 */
function mockTextureSized(width: number, height: number): Texture {
  return { width, height, source: { scaleMode: 'linear' } } as unknown as Texture
}

/**
 * `Assets.load` を常に成功するモックに差し替える（CharacterLayer.test.ts と同じ `as never` 流儀。
 * `Assets.load` はオーバーロードを持ち `mockResolvedValue` の引数型がオーバーロード解決で
 * 意図しない狭い型に絞られるため、キャストで逃がす）。
 */
function mockAssetsLoadResolved(): void {
  vi.spyOn(Assets, 'load').mockResolvedValue(mockTexture() as never)
}

function makeLayer(time: TimeController): EventImageLayer {
  const layer = new EventImageLayer(SCREEN_W, SCREEN_H, time)
  layer.setAssetBaseUrl('/assets')
  return layer
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('EventImageLayer show/remove の基本', () => {
  it('assetBaseUrl 未設定時は current だけ同期的に更新し、Assets.load を呼ばない', () => {
    const loadSpy = vi.spyOn(Assets, 'load')
    const layer = new EventImageLayer(SCREEN_W, SCREEN_H, virtualTime())
    // setAssetBaseUrl を呼ばない。
    layer.show('story/x.webp')
    expect(loadSpy).not.toHaveBeenCalled()
    expect(layer.hasEventImage()).toBe(true)
    expect(layer.getState()).toEqual({ path: 'story/x.webp', back: 'Hide' })
    expect(layer.hasPendingVisualTransition()).toBe(false)
    expect(internals(layer).sprite).toBeNull()
  })

  it('show() は current（settled state）を同期的に確定させ、sprite 生成はロード完了後まで遅延する（#427/#428対策）', async () => {
    mockAssetsLoadResolved()
    const layer = makeLayer(virtualTime())

    layer.show('story/x.webp')
    // 同期的には current は確定済みだが sprite はまだ無い。
    expect(layer.getState()).toEqual({ path: 'story/x.webp', back: 'Hide' })
    expect(internals(layer).sprite).toBeNull()
    expect(layer.hasPendingVisualTransition()).toBe(true)

    await flushPromises()
    expect(internals(layer).sprite).not.toBeNull()
    expect(layer.hasPendingVisualTransition()).toBe(false)
  })

  it('フェード未指定は即時表示（alpha=1・fadeAnimation なし）', async () => {
    mockAssetsLoadResolved()
    const layer = makeLayer(virtualTime())

    layer.show('story/x.webp')
    await flushPromises()

    expect(internals(layer).sprite!.alpha).toBe(1)
    expect(internals(layer).fadeAnimation).toBeNull()
    expect(layer.hasPendingVisualTransition()).toBe(false)
  })

  it('フェード=0 以下も即時表示（fadeMs<=0 は即時扱い）', async () => {
    mockAssetsLoadResolved()
    const layer = makeLayer(virtualTime())

    layer.show('story/x.webp', { fadeMs: 0 })
    await flushPromises()
    expect(internals(layer).sprite!.alpha).toBe(1)
    expect(internals(layer).fadeAnimation).toBeNull()

    layer.show('story/y.webp', { fadeMs: -100 })
    await flushPromises()
    expect(internals(layer).sprite!.alpha).toBe(1)
    expect(internals(layer).fadeAnimation).toBeNull()
  })

  it('フェード指定時はロード完了後に alpha=0→1 のフェードインを予約し、tick で進行・完了する', async () => {
    mockAssetsLoadResolved()
    const time = virtualTime()
    const layer = makeLayer(time)

    layer.show('story/x.webp', { fadeMs: 800 })
    await flushPromises()

    // ロード完了直後: alpha=0 からフェード開始。
    expect(internals(layer).sprite!.alpha).toBe(0)
    expect(internals(layer).fadeAnimation).toMatchObject({
      durationMs: 800,
      fromAlpha: 0,
      toAlpha: 1,
      destroyOnComplete: false,
    })
    expect(layer.hasPendingVisualTransition()).toBe(true)

    time.tick(400)
    expect(internals(layer).sprite!.alpha).toBeCloseTo(0.5, 1)
    expect(layer.hasPendingVisualTransition()).toBe(true)

    time.tick(400 + 16)
    expect(internals(layer).sprite!.alpha).toBe(1)
    expect(internals(layer).fadeAnimation).toBeNull()
    expect(layer.hasPendingVisualTransition()).toBe(false)
    // フェードタイマーがリークしていない。
    expect(time.getPendingTimerCount()).toBe(0)
  })

  it('remove() はフェード指定なしで即座に sprite を破棄し current を null にする', async () => {
    mockAssetsLoadResolved()
    const layer = makeLayer(virtualTime())
    layer.show('story/x.webp')
    await flushPromises()
    expect(internals(layer).sprite).not.toBeNull()

    layer.remove()
    expect(internals(layer).sprite).toBeNull()
    expect(layer.hasEventImage()).toBe(false)
    expect(layer.getState()).toBeNull()
    expect(layer.hasPendingVisualTransition()).toBe(false)
  })

  it('remove() はフェード指定時、現在の alpha から 0 へ補間してから sprite を破棄する（destroyOnComplete）', async () => {
    mockAssetsLoadResolved()
    const time = virtualTime()
    const layer = makeLayer(time)
    layer.show('story/x.webp')
    await flushPromises()
    expect(internals(layer).sprite!.alpha).toBe(1)

    // remove() 呼び出し時点で current（settled state）は即座に null になる（ADR-0002）。
    layer.remove({ fadeMs: 600 })
    expect(layer.getState()).toBeNull()
    expect(layer.hasEventImage()).toBe(false)
    // 見た目の sprite はフェードアウト中なのでまだ残っている（余韻）。
    expect(internals(layer).sprite).not.toBeNull()
    expect(internals(layer).fadeAnimation).toMatchObject({
      fromAlpha: 1,
      toAlpha: 0,
      destroyOnComplete: true,
    })
    expect(layer.hasPendingVisualTransition()).toBe(true)

    time.tick(300)
    expect(internals(layer).sprite!.alpha).toBeCloseTo(0.5, 1)

    time.tick(300 + 16)
    expect(internals(layer).sprite).toBeNull()
    expect(layer.hasPendingVisualTransition()).toBe(false)
    expect(time.getPendingTimerCount()).toBe(0)
  })

  it('show() は既存イベント絵を即座に破棄してから新しいロードを開始する（単一スロット置換）', async () => {
    mockAssetsLoadResolved()
    const layer = makeLayer(virtualTime())
    layer.show('story/a.webp')
    await flushPromises()
    expect(internals(layer).sprite).not.toBeNull()

    // 2 回目の show() は同期的に旧 sprite を破棄し、current を新しい path に差し替える。
    layer.show('story/b.webp')
    expect(internals(layer).sprite).toBeNull()
    expect(layer.getState()).toEqual({ path: 'story/b.webp', back: 'Hide' })

    await flushPromises()
    expect(internals(layer).sprite).not.toBeNull()
  })

  it('ロード中の古い show() が後から解決しても無視される（loadToken による race guard）', async () => {
    const resolvers: Record<string, (t: Texture) => void> = {}
    vi.spyOn(Assets, 'load').mockImplementation(
      (url: unknown) =>
        new Promise((resolve) => {
          resolvers[String(url)] = resolve
        }) as never
    )
    const layer = makeLayer(virtualTime())

    layer.show('a.webp')
    const urlA = '/assets/images/a.webp'
    layer.show('b.webp')
    const urlB = '/assets/images/b.webp'

    // 古い(a)のロードが後から解決しても、現在の current(b)には影響しない。
    resolvers[urlA](mockTexture())
    await flushPromises()
    expect(internals(layer).sprite).toBeNull()
    expect(layer.getState()).toEqual({ path: 'b.webp', back: 'Hide' })

    resolvers[urlB](mockTexture())
    await flushPromises()
    expect(internals(layer).sprite).not.toBeNull()
    expect(layer.getState()).toEqual({ path: 'b.webp', back: 'Hide' })
  })

  it('画像ロード失敗時は console.warn を 1 回出し、例外を投げず pending も解除される', async () => {
    const err = new Error('load failed')
    vi.spyOn(Assets, 'load').mockRejectedValue(err)
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const layer = makeLayer(virtualTime())

    layer.show('story/broken.webp')
    expect(layer.hasPendingVisualTransition()).toBe(true)

    await flushPromises()
    expect(warnSpy).toHaveBeenCalledTimes(1)
    expect(internals(layer).sprite).toBeNull()
    expect(layer.hasPendingVisualTransition()).toBe(false)
    // settled state（current）自体は失敗しても path/back を保持する（ADR-0002: ロード成否は
    // 演出の中間状態であって、ゲーム状態としては指定済みのまま）。
    expect(layer.getState()).toEqual({ path: 'story/broken.webp', back: 'Hide' })
  })

  it('show() 直後の即 remove() はロード完了時に sprite を作らない（pendingLoadToken 無効化）', async () => {
    mockAssetsLoadResolved()
    const layer = makeLayer(virtualTime())

    layer.show('story/x.webp')
    layer.remove()
    await flushPromises()

    expect(internals(layer).sprite).toBeNull()
    expect(layer.getState()).toBeNull()
    expect(layer.hasPendingVisualTransition()).toBe(false)
  })
})

describe('EventImageLayer pixel_art スケールモード (#466)', () => {
  // setPixelArt() で受け取った値を show() の Assets.load().then() 内で
  // texture.source.scaleMode に反映する（nearest = ドット絵向け / linear = 従来の滑らか）。
  //
  // 観測方法の注意: 実 pixi.js の `new Sprite(texture)` はテクスチャの妥当性検証を行い、
  // このテストが渡す偽 texture（実 GPU リソースを持たないプレーンオブジェクト）は
  // Texture.EMPTY に差し替えられてしまう（`sprite.texture = texture` という代入だけの
  // CharacterLayer とは異なる経路）。そのため sprite.texture 経由では scaleMode 代入の
  // 有無を観測できない。`Assets.load` が解決するテクスチャ「オブジェクト自身」への
  // 代入（プロダクションコードが実際に書き換える対象）を直接検証する。

  it('E1: setPixelArt(true) 後の show() は texture.source.scaleMode が nearest になる', async () => {
    const texture = mockTexture()
    vi.spyOn(Assets, 'load').mockResolvedValue(texture as never)
    const layer = makeLayer(virtualTime())
    layer.setPixelArt(true)

    layer.show('story/x.webp')
    await flushPromises()

    expect((texture as unknown as { source: { scaleMode: string } }).source.scaleMode).toBe(
      'nearest'
    )
  })

  it('E2: setPixelArt(false)/未設定の show() は texture.source.scaleMode が linear のまま', async () => {
    const texture = mockTexture()
    vi.spyOn(Assets, 'load').mockResolvedValue(texture as never)
    const layer = makeLayer(virtualTime())
    // setPixelArt を呼ばない（既定 false 相当）。

    layer.show('story/x.webp')
    await flushPromises()
    expect((texture as unknown as { source: { scaleMode: string } }).source.scaleMode).toBe(
      'linear'
    )

    // 明示 false でも同じ結果になることを確認する。
    const texture2 = mockTexture()
    vi.restoreAllMocks()
    vi.spyOn(Assets, 'load').mockResolvedValue(texture2 as never)
    const layer2 = makeLayer(virtualTime())
    layer2.setPixelArt(false)
    layer2.show('story/y.webp')
    await flushPromises()
    expect((texture2 as unknown as { source: { scaleMode: string } }).source.scaleMode).toBe(
      'linear'
    )
  })

  it('E3: 世代ガード — show() を連続2回呼び、旧世代のロードが後から解決してもscaleMode代入行を通らない', async () => {
    const resolvers: Record<string, (t: Texture) => void> = {}
    vi.spyOn(Assets, 'load').mockImplementation(
      (url: unknown) =>
        new Promise((resolve) => {
          resolvers[String(url)] = resolve
        }) as never
    )
    const layer = makeLayer(virtualTime())
    layer.setPixelArt(true)

    layer.show('a.webp')
    const urlA = '/assets/images/a.webp'
    layer.show('b.webp')
    const urlB = '/assets/images/b.webp'

    // 旧世代(a)の texture は loadToken 不一致で早期 return され、scaleMode 代入行（texture.source.scaleMode = ...）
    // を通らないため、mockTexture() が最初から持つ 'linear' のまま変化しない。
    const textureA = mockTexture()
    resolvers[urlA](textureA)
    await flushPromises()
    expect((textureA as unknown as { source: { scaleMode: string } }).source.scaleMode).toBe(
      'linear'
    )

    // 最新世代(b)は scaleMode 代入行を通り、setPixelArt(true) が反映されnearestになる。
    const textureB = mockTexture()
    resolvers[urlB](textureB)
    await flushPromises()
    expect((textureB as unknown as { source: { scaleMode: string } }).source.scaleMode).toBe(
      'nearest'
    )
  })

  it('E4: 表示済みイベント絵がある状態で setPixelArt(true) を呼ぶと、再 show を待たず既存 texture の scaleMode が即座に nearest へ切り替わる（ライブ再適用, CharacterLayer.setPixelArt と対称）', async () => {
    const texture = mockTexture()
    vi.spyOn(Assets, 'load').mockResolvedValue(texture as never)
    const layer = makeLayer(virtualTime())
    // pixel_art 未設定（既定 false）のまま表示 → linear。
    layer.show('story/x.webp')
    await flushPromises()
    expect((texture as unknown as { source: { scaleMode: string } }).source.scaleMode).toBe(
      'linear'
    )

    // CharacterLayer.setPixelArt/reapplyPixelArt (#466 セルフレビュー指摘) と同じく、既存表示済み
    // texture にもその場で即再適用する。次の show を待たせない。
    layer.setPixelArt(true)
    expect((texture as unknown as { source: { scaleMode: string } }).source.scaleMode).toBe(
      'nearest'
    )
  })

  it('E5: setPixelArt(true) の後に setPixelArt(false) へ戻すと、表示済み texture も即座に linear へ戻る', async () => {
    const texture = mockTexture()
    vi.spyOn(Assets, 'load').mockResolvedValue(texture as never)
    const layer = makeLayer(virtualTime())
    layer.setPixelArt(true)
    layer.show('story/x.webp')
    await flushPromises()
    expect((texture as unknown as { source: { scaleMode: string } }).source.scaleMode).toBe(
      'nearest'
    )

    layer.setPixelArt(false)
    expect((texture as unknown as { source: { scaleMode: string } }).source.scaleMode).toBe(
      'linear'
    )
  })

  it('E6: イベント絵が表示されていない状態で setPixelArt() を呼んでも例外を投げない（remove 後 / show 未呼び出し）', () => {
    const layer = makeLayer(virtualTime())
    expect(() => layer.setPixelArt(true)).not.toThrow()
  })

  it('E7: remove() 後に setPixelArt() を呼んでも、既に破棄済みの texture は再適用対象から外れる', async () => {
    const texture = mockTexture()
    vi.spyOn(Assets, 'load').mockResolvedValue(texture as never)
    const layer = makeLayer(virtualTime())
    layer.show('story/x.webp')
    await flushPromises()
    expect((texture as unknown as { source: { scaleMode: string } }).source.scaleMode).toBe(
      'linear'
    )

    layer.remove()
    // remove 後は currentTexture が null に戻るため、この texture オブジェクトはもう触られない。
    expect(() => layer.setPixelArt(true)).not.toThrow()
    expect((texture as unknown as { source: { scaleMode: string } }).source.scaleMode).toBe(
      'linear'
    )
  })
})

describe('EventImageLayer back=Hide/Keep の値保持', () => {
  it('back 未指定は既定 Hide になる', () => {
    const layer = makeLayer(virtualTime())
    layer.show('x.webp')
    expect(layer.getState()!.back).toBe('Hide')
  })

  it('back=Keep を指定するとそのまま保持される', () => {
    const layer = makeLayer(virtualTime())
    layer.show('x.webp', { back: 'Keep' })
    expect(layer.getState()!.back).toBe('Keep')
  })

  it('back=null は既定 Hide に丸められる', () => {
    const layer = makeLayer(virtualTime())
    layer.show('x.webp', { back: null })
    expect(layer.getState()!.back).toBe('Hide')
  })
})

describe('EventImageLayer getState/restore の往復（save/load・seek 用）', () => {
  it('getState() はフェード進行中でも settled な目標値（path/back）を返す（ADR-0002）', async () => {
    mockAssetsLoadResolved()
    const time = virtualTime()
    const layer = makeLayer(time)
    layer.show('story/x.webp', { back: 'Keep', fadeMs: 500 })
    await flushPromises()
    time.tick(100) // フェード進行中（alpha は中間値のはず）
    expect(internals(layer).sprite!.alpha).toBeGreaterThan(0)
    expect(internals(layer).sprite!.alpha).toBeLessThan(1)

    // それでも getState() はフェードの中間 alpha を含まない settled state。
    expect(layer.getState()).toEqual({ path: 'story/x.webp', back: 'Keep' })
  })

  it('restore(state) は即時反映でフェードを行わない（巻き戻し・ロード・任意局面起動と同じ流儀）', async () => {
    mockAssetsLoadResolved()
    const layer = makeLayer(virtualTime())
    const state: EventImageState = { path: 'story/x.webp', back: 'Keep' }

    layer.restore(state)
    expect(layer.getState()).toEqual(state)
    await flushPromises()

    expect(internals(layer).sprite!.alpha).toBe(1)
    expect(internals(layer).fadeAnimation).toBeNull()
  })

  it('restore(null) はイベント絵をクリアする', async () => {
    mockAssetsLoadResolved()
    const layer = makeLayer(virtualTime())
    layer.show('story/x.webp')
    await flushPromises()
    expect(layer.hasEventImage()).toBe(true)

    layer.restore(null)
    expect(layer.hasEventImage()).toBe(false)
    expect(internals(layer).sprite).toBeNull()
  })

  it('getState() → restore() の往復で同じ状態を再現する', async () => {
    mockAssetsLoadResolved()
    const time = virtualTime()
    const layer = makeLayer(time)
    layer.show('story/x.webp', { back: 'Keep', fadeMs: 400 })
    await flushPromises()

    const snapshot = layer.getState()
    expect(snapshot).not.toBeNull()

    // 別インスタンス（例: セーブロード直後の新規レンダラ相当）へ復元する。
    const restored = makeLayer(virtualTime())
    restored.restore(snapshot)
    expect(restored.getState()).toEqual(snapshot)
    await flushPromises()
    // 復元は常に即時反映（フェードなし）。
    expect(internals(restored).sprite!.alpha).toBe(1)
    expect(internals(restored).fadeAnimation).toBeNull()
  })
})

describe('EventImageLayer hasPendingVisualTransition（[待機: 表示完了] の観測対象）', () => {
  it('何も表示していなければ false', () => {
    const layer = makeLayer(virtualTime())
    expect(layer.hasPendingVisualTransition()).toBe(false)
  })

  it('ロード中は true、完了後は false', async () => {
    mockAssetsLoadResolved()
    const layer = makeLayer(virtualTime())
    layer.show('story/x.webp')
    expect(layer.hasPendingVisualTransition()).toBe(true)
    await flushPromises()
    expect(layer.hasPendingVisualTransition()).toBe(false)
  })

  it('フェード進行中は true、完了後は false', async () => {
    mockAssetsLoadResolved()
    const time = virtualTime()
    const layer = makeLayer(time)
    layer.show('story/x.webp', { fadeMs: 300 })
    await flushPromises()
    expect(layer.hasPendingVisualTransition()).toBe(true)
    time.tick(300 + 16)
    expect(layer.hasPendingVisualTransition()).toBe(false)
  })
})

// セルフレビュー指摘 (#351): ロード失敗のまま back=Hide が残ると、覆う画像が無いのに
// 背景・立ち絵が隠れっぱなしになる。getState()（settled state・ADR-0002）は失敗しても
// 作者の意図を保持し続けるが、可視性判定専用の shouldHideBackLayer() は失敗世代を反映する。
describe('EventImageLayer shouldHideBackLayer（可視性判定専用 API・セルフレビュー指摘）', () => {
  it('current が無ければ false', () => {
    const layer = makeLayer(virtualTime())
    expect(layer.shouldHideBackLayer()).toBe(false)
  })

  it('back=Hide でロード成功後は true', async () => {
    mockAssetsLoadResolved()
    const layer = makeLayer(virtualTime())
    layer.show('story/x.webp')
    await flushPromises()
    expect(layer.shouldHideBackLayer()).toBe(true)
  })

  it('back=Keep はロード成功後も false（背面を隠さない）', async () => {
    mockAssetsLoadResolved()
    const layer = makeLayer(virtualTime())
    layer.show('story/x.webp', { back: 'Keep' })
    await flushPromises()
    expect(layer.shouldHideBackLayer()).toBe(false)
  })

  it('back=Hide のロード完了前（pending 中）は false（暗転フラッシュを避ける）', () => {
    mockAssetsLoadResolved()
    const layer = makeLayer(virtualTime())
    layer.show('story/x.webp')
    // await flushPromises() していない = まだロード未完了。
    expect(layer.getState()).toEqual({ path: 'story/x.webp', back: 'Hide' })
    expect(layer.shouldHideBackLayer()).toBe(false)
  })

  it('back=Hide のフェードイン中は false、完了後に true へ切り替わる', async () => {
    mockAssetsLoadResolved()
    const time = virtualTime()
    const layer = makeLayer(time)
    const onVisibilityChange = vi.fn()

    layer.show('story/x.webp', { fadeMs: 700, onVisibilityChange })
    await flushPromises()

    expect(internals(layer).sprite!.alpha).toBe(0)
    expect(layer.shouldHideBackLayer()).toBe(false)
    expect(onVisibilityChange).not.toHaveBeenCalled()

    time.tick(350)
    expect(layer.shouldHideBackLayer()).toBe(false)

    time.tick(350 + 16)
    expect(layer.shouldHideBackLayer()).toBe(true)
    expect(onVisibilityChange).toHaveBeenCalledTimes(1)
  })

  it('back=Hide でロードが失敗すると false に切り替わる（getState() は Hide のまま保持）', async () => {
    vi.spyOn(Assets, 'load').mockRejectedValue(new Error('missing') as never)
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const layer = makeLayer(virtualTime())
    layer.show('story/broken.webp')
    await flushPromises()

    expect(layer.getState()).toEqual({ path: 'story/broken.webp', back: 'Hide' })
    expect(layer.shouldHideBackLayer()).toBe(false)
  })

  it('remove() 後は false（current が null）', async () => {
    mockAssetsLoadResolved()
    const layer = makeLayer(virtualTime())
    layer.show('story/x.webp')
    await flushPromises()
    expect(layer.shouldHideBackLayer()).toBe(true)

    layer.remove()
    expect(layer.shouldHideBackLayer()).toBe(false)
  })

  it('失敗後に同じ path を show() し直すとロード成功で再び true になる（loadFailed のリセット）', async () => {
    const loadSpy = vi.spyOn(Assets, 'load').mockRejectedValueOnce(new Error('missing') as never)
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const layer = makeLayer(virtualTime())
    layer.show('story/x.webp')
    await flushPromises()
    expect(layer.shouldHideBackLayer()).toBe(false)

    loadSpy.mockResolvedValueOnce(mockTexture() as never)
    layer.show('story/x.webp')
    await flushPromises()
    expect(layer.shouldHideBackLayer()).toBe(true)
  })
})

describe('EventImageLayer onSettled コールバック（CharacterLayer #293 onReady と同じ流儀）', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('ロード成功時に 1 回だけ発火する', async () => {
    mockAssetsLoadResolved()
    const layer = makeLayer(virtualTime())
    const onSettled = vi.fn()
    layer.show('story/x.webp', { onSettled })
    expect(onSettled).not.toHaveBeenCalled()
    await flushPromises()
    expect(onSettled).toHaveBeenCalledTimes(1)
  })

  it('ロード失敗時にも 1 回だけ発火する', async () => {
    vi.spyOn(Assets, 'load').mockRejectedValue(new Error('missing') as never)
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const layer = makeLayer(virtualTime())
    const onSettled = vi.fn()
    layer.show('story/x.webp', { onSettled })
    await flushPromises()
    expect(onSettled).toHaveBeenCalledTimes(1)
  })

  it('古い世代（後続の show() に追い越された）呼び出しの onSettled は発火しない', async () => {
    const resolvers: Record<string, (t: Texture) => void> = {}
    vi.spyOn(Assets, 'load').mockImplementation(
      (url: unknown) =>
        new Promise((resolve) => {
          resolvers[String(url)] = resolve
        }) as never
    )
    const layer = makeLayer(virtualTime())
    const onSettledA = vi.fn()
    const onSettledB = vi.fn()
    layer.show('a.webp', { onSettled: onSettledA })
    layer.show('b.webp', { onSettled: onSettledB })

    resolvers['/assets/images/a.webp'](mockTexture())
    await flushPromises()
    expect(onSettledA).not.toHaveBeenCalled()

    resolvers['/assets/images/b.webp'](mockTexture())
    await flushPromises()
    expect(onSettledB).toHaveBeenCalledTimes(1)
  })

  it('restore() 経由でも onSettled が伝播する', async () => {
    mockAssetsLoadResolved()
    const layer = makeLayer(virtualTime())
    const onSettled = vi.fn()
    layer.restore({ path: 'story/x.webp', back: 'Hide' }, { onSettled })
    await flushPromises()
    expect(onSettled).toHaveBeenCalledTimes(1)
  })
})

describe('EventImageLayer disposeTextures（GPU テクスチャのリーク防止・セルフレビュー指摘）', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('ロード成功した URL を Assets.unload で解放し、内部の追跡集合をクリアする', async () => {
    mockAssetsLoadResolved()
    const unloadSpy = vi.spyOn(Assets, 'unload').mockResolvedValue(undefined as never)
    const layer = makeLayer(virtualTime())
    layer.show('story/x.webp')
    await flushPromises()

    layer.disposeTextures()
    await flushPromises()

    expect(unloadSpy).toHaveBeenCalledWith('/assets/images/story/x.webp')
  })

  it('複数回 show() した URL をすべて解放する', async () => {
    mockAssetsLoadResolved()
    const unloadSpy = vi.spyOn(Assets, 'unload').mockResolvedValue(undefined as never)
    const layer = makeLayer(virtualTime())
    layer.show('a.webp')
    await flushPromises()
    layer.show('b.webp')
    await flushPromises()

    layer.disposeTextures()
    await flushPromises()

    expect(unloadSpy).toHaveBeenCalledWith('/assets/images/a.webp')
    expect(unloadSpy).toHaveBeenCalledWith('/assets/images/b.webp')
    expect(unloadSpy).toHaveBeenCalledTimes(2)
  })

  it('何もロードしていなければ Assets.unload を呼ばない', () => {
    const unloadSpy = vi.spyOn(Assets, 'unload').mockResolvedValue(undefined as never)
    const layer = makeLayer(virtualTime())
    layer.disposeTextures()
    expect(unloadSpy).not.toHaveBeenCalled()
  })

  it('disposeTextures 後に再度 show() すると新しい URL がまた追跡・解放対象になる', async () => {
    mockAssetsLoadResolved()
    const unloadSpy = vi.spyOn(Assets, 'unload').mockResolvedValue(undefined as never)
    const layer = makeLayer(virtualTime())
    layer.show('story/x.webp')
    await flushPromises()
    layer.disposeTextures()
    await flushPromises()
    unloadSpy.mockClear()

    layer.show('story/x.webp')
    await flushPromises()
    layer.disposeTextures()
    await flushPromises()

    expect(unloadSpy).toHaveBeenCalledWith('/assets/images/story/x.webp')
    expect(unloadSpy).toHaveBeenCalledTimes(1)
  })

  it('ロード失敗した URL は追跡対象にならない（成功していないので解放も不要）', async () => {
    vi.spyOn(Assets, 'load').mockRejectedValue(new Error('missing') as never)
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const unloadSpy = vi.spyOn(Assets, 'unload').mockResolvedValue(undefined as never)
    const layer = makeLayer(virtualTime())
    layer.show('story/broken.webp')
    await flushPromises()

    layer.disposeTextures()
    expect(unloadSpy).not.toHaveBeenCalled()
  })
})

// =====================================================================================
// #464: split_layout のイベント絵領域（setSplitLayoutRegion/getSplitLayoutRegion）。
//
// EventImageLayer は CharacterLayer（Container 全体の scale/position で region に収める）とは
// 異なり、sprite 個別の x/y/width/height を computeCoverFit(texW, texH, region.width,
// region.height) の結果に region.x/y を後から加算して求める（意図的に異なる方式・バグではない。
// EventImageLayer.ts の doc comment 参照）。region 参照は「show() 呼び出し時点」ではなく
// 「Assets.load().then() が解決した時点」であるため、その間の race・既存 sprite 不変の契約も
// あわせて検証する。
// =====================================================================================
describe('EventImageLayer setSplitLayoutRegion / getSplitLayoutRegion と show() の cover-fit 反映 (#464)', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  // 画面(800x450)の左半分相当・かつオフセット非ゼロで CharacterLayer.test.ts の
  // 「regionにオフセット(x,y)がある場合」テストと同じ意図の矩形を使う。
  const REGION: LayoutRect = { x: 50, y: 20, width: 400, height: 450 }

  it('getSplitLayoutRegion() は初期状態で null', () => {
    const layer = makeLayer(virtualTime())
    expect(layer.getSplitLayoutRegion()).toBeNull()
  })

  it('setSplitLayoutRegion(region) → getSplitLayoutRegion() が同じ値を返す（round-trip）', () => {
    const layer = makeLayer(virtualTime())
    layer.setSplitLayoutRegion(REGION)
    expect(layer.getSplitLayoutRegion()).toEqual(REGION)
  })

  it('setSplitLayoutRegion(region) → setSplitLayoutRegion(null) → null に戻る', () => {
    const layer = makeLayer(virtualTime())
    layer.setSplitLayoutRegion(REGION)
    layer.setSplitLayoutRegion(null)
    expect(layer.getSplitLayoutRegion()).toBeNull()
  })

  it('region=null で show(): 従来どおり screenWidth/screenHeight 基準の cover-fit になる（リグレッションガード）', async () => {
    mockAssetsLoadResolved()
    const layer = makeLayer(virtualTime())
    layer.show('story/x.webp')
    await flushPromises()

    const fit = computeCoverFit(100, 50, SCREEN_W, SCREEN_H)
    const sprite = internals(layer).sprite!
    expect(sprite.x).toBe(fit.x)
    expect(sprite.y).toBe(fit.y)
    expect(sprite.width).toBe(fit.width)
    expect(sprite.height).toBe(fit.height)
  })

  it('region 設定 + テクスチャアスペクト比が region と完全一致（境界）: クロップなしで region の矩形そのものになる', async () => {
    // 400x450 は REGION と同じアスペクト比（400/450）→ scale=1・クロップなし。
    vi.spyOn(Assets, 'load').mockResolvedValue(mockTextureSized(400, 450) as never)
    const layer = makeLayer(virtualTime())
    layer.setSplitLayoutRegion(REGION)
    layer.show('story/x.webp')
    await flushPromises()

    const sprite = internals(layer).sprite!
    expect(sprite.x).toBe(REGION.x)
    expect(sprite.y).toBe(REGION.y)
    expect(sprite.width).toBe(REGION.width)
    expect(sprite.height).toBe(REGION.height)
  })

  it('region 設定 + テクスチャが横長超過（上の境界一致ケースより横長側）: 横方向にオーバーフローし x が負値側にずれる、height は region.height にフィットする', async () => {
    // 800x450 は REGION（400x450）より横長 → 横方向がオーバーフローする。
    // 「境界+1px」という厳密な意味ではなく、上のアスペクト比一致ケースに対して横長側の
    // カテゴリであることを表す（比率のカテゴリ分けの一例）。
    vi.spyOn(Assets, 'load').mockResolvedValue(mockTextureSized(800, 450) as never)
    const layer = makeLayer(virtualTime())
    layer.setSplitLayoutRegion(REGION)
    layer.show('story/x.webp')
    await flushPromises()

    const fit = computeCoverFit(800, 450, REGION.width, REGION.height)
    expect(fit.x).toBeLessThan(0) // 前提: このテクスチャ比では横方向にオーバーフローする
    const sprite = internals(layer).sprite!
    expect(sprite.x).toBe(fit.x + REGION.x)
    expect(sprite.y).toBe(fit.y + REGION.y)
    expect(sprite.height).toBe(REGION.height)
    expect(sprite.width).toBeGreaterThan(REGION.width)
  })

  it('region 設定 + テクスチャが縦長超過（上の境界一致ケースより縦長側）: 縦方向にオーバーフローし y が負値側にずれる、width は region.width にフィットする', async () => {
    // 100x450 は REGION（400x450）より縦長 → 縦方向がオーバーフローする。
    // 「境界-1px」という厳密な意味ではなく、上のアスペクト比一致ケースに対して縦長側の
    // カテゴリであることを表す（比率のカテゴリ分けの一例）。
    vi.spyOn(Assets, 'load').mockResolvedValue(mockTextureSized(100, 450) as never)
    const layer = makeLayer(virtualTime())
    layer.setSplitLayoutRegion(REGION)
    layer.show('story/x.webp')
    await flushPromises()

    const fit = computeCoverFit(100, 450, REGION.width, REGION.height)
    expect(fit.y).toBeLessThan(0) // 前提: このテクスチャ比では縦方向にオーバーフローする
    const sprite = internals(layer).sprite!
    expect(sprite.x).toBe(fit.x + REGION.x)
    expect(sprite.y).toBe(fit.y + REGION.y)
    expect(sprite.width).toBe(REGION.width)
    expect(sprite.height).toBeGreaterThan(REGION.height)
  })

  it('region のオフセット(x,y 非ゼロ)が computeCoverFit の結果に正しく加算される', async () => {
    vi.spyOn(Assets, 'load').mockResolvedValue(mockTextureSized(120, 80) as never)
    const layer = makeLayer(virtualTime())
    layer.setSplitLayoutRegion(REGION)
    layer.show('story/x.webp')
    await flushPromises()

    const fit = computeCoverFit(120, 80, REGION.width, REGION.height)
    const sprite = internals(layer).sprite!
    expect(sprite.x).toBe(fit.x + REGION.x)
    expect(sprite.y).toBe(fit.y + REGION.y)
    expect(sprite.width).toBe(fit.width)
    expect(sprite.height).toBe(fit.height)
  })

  it('portrait 形状の region（width<height）でも同じ cover-fit + offset 計算が成立する', async () => {
    const portraitRegion: LayoutRect = { x: 10, y: 5, width: 300, height: 600 }
    vi.spyOn(Assets, 'load').mockResolvedValue(mockTextureSized(200, 100) as never)
    const layer = makeLayer(virtualTime())
    layer.setSplitLayoutRegion(portraitRegion)
    layer.show('story/x.webp')
    await flushPromises()

    const fit = computeCoverFit(200, 100, portraitRegion.width, portraitRegion.height)
    const sprite = internals(layer).sprite!
    expect(sprite.x).toBe(fit.x + portraitRegion.x)
    expect(sprite.y).toBe(fit.y + portraitRegion.y)
    expect(sprite.width).toBe(fit.width)
    expect(sprite.height).toBe(fit.height)
  })

  it('show() 呼び出し前に setSplitLayoutRegion() を設定した場合、ロード完了後の sprite に正しく反映される（実運用の初期化順序どおり）', async () => {
    vi.spyOn(Assets, 'load').mockResolvedValue(mockTextureSized(100, 50) as never)
    const layer = makeLayer(virtualTime())
    // 実運用どおり: applySplitLayout()（setSplitLayoutRegion）が mount 時に先に呼ばれ、
    // その後にディレクティブ経由で show() が呼ばれる順序。
    layer.setSplitLayoutRegion(REGION)
    layer.show('story/x.webp')
    await flushPromises()

    const fit = computeCoverFit(100, 50, REGION.width, REGION.height)
    const sprite = internals(layer).sprite!
    expect(sprite.x).toBe(fit.x + REGION.x)
    expect(sprite.y).toBe(fit.y + REGION.y)
  })

  it('（race）show() 呼び出し後・ロード未解決の間に region を変更すると、ロード解決時点の最新 region が使われる', async () => {
    const resolvers: Record<string, (t: Texture) => void> = {}
    vi.spyOn(Assets, 'load').mockImplementation(
      (url: unknown) =>
        new Promise((resolve) => {
          resolvers[String(url)] = resolve
        }) as never
    )
    const layer = makeLayer(virtualTime())
    const regionAtShowTime: LayoutRect = { x: 0, y: 0, width: 400, height: 450 }
    const regionAtResolveTime: LayoutRect = { x: 400, y: 0, width: 400, height: 450 }

    layer.setSplitLayoutRegion(regionAtShowTime)
    layer.show('story/x.webp')
    // ロード未解決の間に region を差し替える（例: applySplitLayout の再適用がロード中に割り込む）。
    layer.setSplitLayoutRegion(regionAtResolveTime)

    resolvers['/assets/images/story/x.webp'](mockTextureSized(100, 50))
    await flushPromises()

    const fit = computeCoverFit(100, 50, regionAtResolveTime.width, regionAtResolveTime.height)
    const sprite = internals(layer).sprite!
    // show() 呼び出し時点の region（regionAtShowTime）ではなく、解決時点の最新 region が使われる。
    expect(sprite.x).toBe(fit.x + regionAtResolveTime.x)
    expect(sprite.y).toBe(fit.y + regionAtResolveTime.y)
  })

  it('（既存 sprite 不変の契約）sprite 表示済みの状態で setSplitLayoutRegion() を呼んでも、既存 sprite の x/y/width/height は変化しない', async () => {
    vi.spyOn(Assets, 'load').mockResolvedValue(mockTextureSized(100, 50) as never)
    const layer = makeLayer(virtualTime())
    layer.setSplitLayoutRegion(REGION)
    layer.show('story/x.webp')
    await flushPromises()

    const sprite = internals(layer).sprite!
    const before = { x: sprite.x, y: sprite.y, width: sprite.width, height: sprite.height }

    // setSplitLayoutRegion は this.splitLayoutRegion への代入のみで、次の show() まで
    // 既存 sprite には反映しない契約（EventImageLayer.ts の doc comment 参照）。
    layer.setSplitLayoutRegion({ x: 400, y: 0, width: 400, height: 450 })

    expect(sprite.x).toBe(before.x)
    expect(sprite.y).toBe(before.y)
    expect(sprite.width).toBe(before.width)
    expect(sprite.height).toBe(before.height)
  })

  it('region 設定済みのまま 2 回目の show()（単一スロット置換）を呼んでも、新しい sprite にも同じ region が適用される', async () => {
    vi.spyOn(Assets, 'load').mockResolvedValue(mockTextureSized(100, 50) as never)
    const layer = makeLayer(virtualTime())
    layer.setSplitLayoutRegion(REGION)
    layer.show('story/a.webp')
    await flushPromises()
    const firstSprite = internals(layer).sprite

    layer.show('story/b.webp')
    await flushPromises()
    const secondSprite = internals(layer).sprite!

    expect(secondSprite).not.toBe(firstSprite)
    const fit = computeCoverFit(100, 50, REGION.width, REGION.height)
    expect(secondSprite.x).toBe(fit.x + REGION.x)
    expect(secondSprite.y).toBe(fit.y + REGION.y)
  })

  it('region 設定 → remove() → 再度 show()（region 設定のまま）でも正しく領域に収まる', async () => {
    vi.spyOn(Assets, 'load').mockResolvedValue(mockTextureSized(100, 50) as never)
    const layer = makeLayer(virtualTime())
    layer.setSplitLayoutRegion(REGION)
    layer.show('story/x.webp')
    await flushPromises()
    layer.remove()
    expect(internals(layer).sprite).toBeNull()

    layer.show('story/y.webp')
    await flushPromises()

    const fit = computeCoverFit(100, 50, REGION.width, REGION.height)
    const sprite = internals(layer).sprite!
    expect(sprite.x).toBe(fit.x + REGION.x)
    expect(sprite.y).toBe(fit.y + REGION.y)
  })

  it('region 設定状態でロード失敗（Assets.load reject）しても console.warn は従来どおり1回のみ・例外なし・sprite=null', async () => {
    vi.spyOn(Assets, 'load').mockRejectedValue(new Error('missing') as never)
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const layer = makeLayer(virtualTime())
    layer.setSplitLayoutRegion(REGION)

    expect(() => layer.show('story/broken.webp')).not.toThrow()
    await flushPromises()

    expect(warnSpy).toHaveBeenCalledTimes(1)
    expect(internals(layer).sprite).toBeNull()
  })
})

// =====================================================================================
// #530: フルキャンバス画像表示モード（setFullscreenMode/isFullscreenMode/handleWheel）。
//
// split_layout（region ベース、cover-fit でクロップする）とは別軸で、常にキャンバス全幅
// （SCREEN_W/SCREEN_H 基準）を使い、アスペクト比を保ったまま contain（クロップなし）で
// 表示する。高さが画面を超える場合は縦スクロール（マウスホイール、handleWheel）で見せる。
// =====================================================================================
describe('EventImageLayer setFullscreenMode / handleWheel (#530)', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  const REGION: LayoutRect = { x: 50, y: 20, width: 400, height: 450 }

  it('isFullscreenMode() は初期状態で false', () => {
    const layer = makeLayer(virtualTime())
    expect(layer.isFullscreenMode()).toBe(false)
  })

  it('setFullscreenMode(true) → isFullscreenMode() が true になる round-trip', () => {
    const layer = makeLayer(virtualTime())
    layer.setFullscreenMode(true)
    expect(layer.isFullscreenMode()).toBe(true)
    layer.setFullscreenMode(false)
    expect(layer.isFullscreenMode()).toBe(false)
  })

  it('fullscreenMode=false（既定）で show(): splitLayoutRegion を設定していても無視され、従来どおり region 基準の cover-fit になる（リグレッションガード）', async () => {
    vi.spyOn(Assets, 'load').mockResolvedValue(mockTextureSized(400, 450) as never)
    const layer = makeLayer(virtualTime())
    layer.setSplitLayoutRegion(REGION)
    // setFullscreenMode を一度も呼んでいない = 既定 false。
    layer.show('story/x.webp')
    await flushPromises()

    const sprite = internals(layer).sprite!
    expect(sprite.x).toBe(REGION.x)
    expect(sprite.y).toBe(REGION.y)
  })

  it('fullscreenMode=true・横長画像（キャンバス高さに収まる）: キャンバス全幅で contain、x=0・y=0、縦スクロール不要', async () => {
    // Gymnasiaロゴ相当の横長画像（256x48, aspect 5.33:1）。SCREEN_W/SCREEN_H=800x450基準では
    // 幅800にフィットさせても高さ150程度で画面(450)に収まる → スクロール不要。
    vi.spyOn(Assets, 'load').mockResolvedValue(mockTextureSized(256, 48) as never)
    const layer = makeLayer(virtualTime())
    layer.setFullscreenMode(true)
    layer.show('brand/logo.webp')
    await flushPromises()

    const sprite = internals(layer).sprite!
    expect(sprite.x).toBe(0)
    expect(sprite.y).toBe(0)
    expect(sprite.width).toBe(SCREEN_W)
    expect(sprite.height).toBeCloseTo((48 / 256) * SCREEN_W)
    expect(sprite.height).toBeLessThanOrEqual(SCREEN_H)
  })

  it('fullscreenMode=true・splitLayoutRegion が同時に設定されていても、region は無視されキャンバス全幅基準になる', async () => {
    vi.spyOn(Assets, 'load').mockResolvedValue(mockTextureSized(256, 48) as never)
    const layer = makeLayer(virtualTime())
    layer.setSplitLayoutRegion(REGION) // 400x450、通常なら幅400基準になるはず
    layer.setFullscreenMode(true)
    layer.show('brand/logo.webp')
    await flushPromises()

    const sprite = internals(layer).sprite!
    expect(sprite.width).toBe(SCREEN_W) // REGION.width(400)ではなくSCREEN_W(800)基準
    expect(sprite.x).toBe(0) // REGION.x(50)ではなく0
  })

  it('fullscreenMode=true・縦長画像（キャンバス高さを超える）: 高さがキャンバスを超えたまま追加の縮小をせず、handleWheel で縦スクロールできる', async () => {
    // 縦長画像（幅800基準にすると高さがSCREEN_H(450)を超える比率）。
    vi.spyOn(Assets, 'load').mockResolvedValue(mockTextureSized(400, 900) as never)
    const layer = makeLayer(virtualTime())
    layer.setFullscreenMode(true)
    layer.show('story/tall.webp')
    await flushPromises()

    const sprite = internals(layer).sprite!
    const expectedHeight = (900 / 400) * SCREEN_W // = 1800、追加の縮小はしない
    expect(sprite.height).toBeCloseTo(expectedHeight)
    expect(sprite.height).toBeGreaterThan(SCREEN_H)
    expect(sprite.y).toBe(0) // スクロール前は先頭

    layer.handleWheel(200) // 下方向へスクロール
    expect(sprite.y).toBeLessThan(0) // 画像を上へ動かして下側を見せる

    const maxScrollY = expectedHeight - SCREEN_H
    layer.handleWheel(100000) // 大きくスクロールしても下端でクランプされる
    expect(sprite.y).toBeCloseTo(-maxScrollY)

    layer.handleWheel(-100000) // 上方向へ大きく戻しても0未満にはならない
    // clampFullscreenImageScrollY(0) → sprite.y = -0（`toBe`はObject.isで-0と0を区別するため
    // toBeCloseToを使う。数値としては0と等価で挙動上の問題ではない）。
    expect(sprite.y).toBeCloseTo(0)
  })

  it('fullscreenMode=true・画像がキャンバス高さに収まる場合、handleWheel を呼んでも sprite.y は動かない（scrollable=falseならno-op）', async () => {
    vi.spyOn(Assets, 'load').mockResolvedValue(mockTextureSized(256, 48) as never)
    const layer = makeLayer(virtualTime())
    layer.setFullscreenMode(true)
    layer.show('brand/logo.webp')
    await flushPromises()

    const sprite = internals(layer).sprite!
    layer.handleWheel(500)
    expect(sprite.y).toBe(0)
  })

  it('fullscreenMode=false のとき handleWheel を呼んでも何も起きない（sprite.y はcover-fitのyのまま）', async () => {
    vi.spyOn(Assets, 'load').mockResolvedValue(mockTextureSized(400, 900) as never)
    const layer = makeLayer(virtualTime())
    layer.show('story/tall.webp')
    await flushPromises()

    const sprite = internals(layer).sprite!
    const yBefore = sprite.y
    layer.handleWheel(500)
    expect(sprite.y).toBe(yBefore)
  })

  it('新しい show() を呼ぶとスクロール位置がリセットされる（前の画像のスクロール量を引きずらない）', async () => {
    vi.spyOn(Assets, 'load').mockResolvedValue(mockTextureSized(400, 900) as never)
    const layer = makeLayer(virtualTime())
    layer.setFullscreenMode(true)
    layer.show('story/tall-1.webp')
    await flushPromises()
    layer.handleWheel(500)
    expect(internals(layer).sprite!.y).toBeLessThan(0)

    layer.show('story/tall-2.webp')
    await flushPromises()
    expect(internals(layer).sprite!.y).toBe(0)
  })

  it('handleWheel は sprite が無い（show() 未呼び出し・ロード未解決）間は何もせず例外を投げない', () => {
    const layer = makeLayer(virtualTime())
    layer.setFullscreenMode(true)
    expect(() => layer.handleWheel(500)).not.toThrow()
  })
})

// #547 must1: computeFullscreenImageFit の scrollable を消費するスクロールヒント表示
// （TUI版 draw_fullscreen_image の「↑/↓ でスクロール」ヒントに相当）。
describe('EventImageLayer スクロールヒント (isScrollHintVisible) (#547 must1)', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('初期状態では非表示', () => {
    const layer = makeLayer(virtualTime())
    expect(layer.isScrollHintVisible()).toBe(false)
  })

  it('fullscreenMode=true・縦長画像（スクロール必要）: show() 完了後にヒントが表示される', async () => {
    vi.spyOn(Assets, 'load').mockResolvedValue(mockTextureSized(400, 900) as never)
    const layer = makeLayer(virtualTime())
    layer.setFullscreenMode(true)
    layer.show('story/tall.webp')
    await flushPromises()

    expect(layer.isScrollHintVisible()).toBe(true)
  })

  it('fullscreenMode=true・横長画像（キャンバス高さに収まる）: ヒントは表示されない', async () => {
    vi.spyOn(Assets, 'load').mockResolvedValue(mockTextureSized(256, 48) as never)
    const layer = makeLayer(virtualTime())
    layer.setFullscreenMode(true)
    layer.show('brand/logo.webp')
    await flushPromises()

    expect(layer.isScrollHintVisible()).toBe(false)
  })

  it('fullscreenMode=false: 縦長画像でもヒントは表示されない（cover-fit にはスクロール概念が無い）', async () => {
    vi.spyOn(Assets, 'load').mockResolvedValue(mockTextureSized(400, 900) as never)
    const layer = makeLayer(virtualTime())
    layer.show('story/tall.webp')
    await flushPromises()

    expect(layer.isScrollHintVisible()).toBe(false)
  })

  it('remove() を呼ぶと即座にヒントが消える', async () => {
    vi.spyOn(Assets, 'load').mockResolvedValue(mockTextureSized(400, 900) as never)
    const layer = makeLayer(virtualTime())
    layer.setFullscreenMode(true)
    layer.show('story/tall.webp')
    await flushPromises()
    expect(layer.isScrollHintVisible()).toBe(true)

    layer.remove()
    expect(layer.isScrollHintVisible()).toBe(false)
  })

  it('setFullscreenMode(false) で切り替えると即座にヒントが消える', async () => {
    vi.spyOn(Assets, 'load').mockResolvedValue(mockTextureSized(400, 900) as never)
    const layer = makeLayer(virtualTime())
    layer.setFullscreenMode(true)
    layer.show('story/tall.webp')
    await flushPromises()
    expect(layer.isScrollHintVisible()).toBe(true)

    layer.setFullscreenMode(false)
    expect(layer.isScrollHintVisible()).toBe(false)
  })

  it('新しい show() を呼ぶと、ロード完了までヒントが一旦隠れ、その後は新しい画像の scrollable で再判定される', async () => {
    vi.spyOn(Assets, 'load').mockResolvedValue(mockTextureSized(400, 900) as never)
    const layer = makeLayer(virtualTime())
    layer.setFullscreenMode(true)
    layer.show('story/tall-1.webp')
    await flushPromises()
    expect(layer.isScrollHintVisible()).toBe(true)

    vi.spyOn(Assets, 'load').mockResolvedValue(mockTextureSized(256, 48) as never)
    layer.show('brand/logo.webp')
    // ロード完了前は隠れている。
    expect(layer.isScrollHintVisible()).toBe(false)
    await flushPromises()
    // 横長画像はスクロール不要なので表示されないまま。
    expect(layer.isScrollHintVisible()).toBe(false)
  })
})

describe('EventImageLayer アンビエント演出 (#582)', () => {
  // jsdom（`canvas` npm パッケージ未導入環境）では buildDisplacementNoiseCanvas が null を返すため
  // （ambientEffects.test.ts 参照）、コンストラクタで displacementFilter は常に null のまま。
  // そのため wobble=true でも imageGroup.filters にはビネットフィルタだけが入る
  // （ゆらぎは「静かに no-op」になる、EventImageLayer.ts の doc comment どおり）。

  it('全フラグ true で show() すると imageGroup.filters にビネットが入り、glowSprite の blendMode/alpha が設定される', async () => {
    mockAssetsLoadResolved()
    const layer = makeLayer(virtualTime())
    layer.show('story/x.webp', {
      effects: { wobble: true, vignette: true, glow: true, candle: true },
    })
    await flushPromises()

    const ll = internals(layer)
    expect(ll.imageGroup.filters).not.toBeNull()
    // jsdom は canvas 2D 未実装のため displacementFilter は常に null（ambientEffects.test.ts の
    // buildDisplacementNoiseCanvas テスト参照）。ゆらぎ指定時も静かに no-op になるため、
    // ここではビネットフィルタだけが imageGroup.filters に入ることを確認する。
    expect(ll.imageGroup.filters).toEqual([ll.vignetteFilter])

    expect(ll.glowSprite).not.toBeNull()
    expect(ll.glowSprite!.blendMode).toBe('overlay')
    expect(ll.glowSprite!.alpha).toBeCloseTo(0.45)
  })

  it('ゆらぎ単体指定時、jsdomでクラッシュせず console.error/warn も呼ばれない', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    mockAssetsLoadResolved()
    const time = virtualTime()
    const layer = makeLayer(time)

    expect(() =>
      layer.show('story/x.webp', {
        effects: { wobble: true, vignette: false, glow: false, candle: false },
      })
    ).not.toThrow()
    await flushPromises()
    // ambientTimer (wobble/candle 起動) を実際に1回発火させても例外・警告が出ないこと。
    time.tick(16)

    expect(warnSpy).not.toHaveBeenCalled()
    expect(errorSpy).not.toHaveBeenCalled()

    warnSpy.mockRestore()
    errorSpy.mockRestore()
  })

  it('グロー単体(wobble/candleともfalse)の場合 ambientTimer は起動しない(glow/vignetteは時間非依存の演出)', async () => {
    mockAssetsLoadResolved()
    const layer = makeLayer(virtualTime())
    layer.show('story/x.webp', {
      effects: { wobble: false, vignette: false, glow: true, candle: false },
    })
    await flushPromises()

    expect(internals(layer).ambientTimer).toBeNull()
  })

  it('ろうそく揺れ有効時、time.tick() で sprite.tint が時間経過とともに変化する', async () => {
    mockAssetsLoadResolved()
    const time = virtualTime()
    const layer = makeLayer(time)
    layer.show('story/x.webp', {
      effects: { wobble: false, vignette: false, glow: false, candle: true },
    })
    await flushPromises()

    const initialTint = internals(layer).sprite!.tint
    expect(initialTint).toBe(0xffffff) // 未着色の既定値

    time.tick(16) // ambientTimer (16ms間隔) を1回発火させる
    const afterFirstTick = internals(layer).sprite!.tint
    expect(afterFirstTick).not.toBe(initialTint)

    time.tick(200) // 別のろうそく step へ進める
    const afterMoreTicks = internals(layer).sprite!.tint
    expect(afterMoreTicks).not.toBe(afterFirstTick)
  })

  it('ろうそく+グロー同時指定時、glowSprite.alpha も candle の flicker 係数で連動して変化する', async () => {
    mockAssetsLoadResolved()
    const time = virtualTime()
    const layer = makeLayer(time)
    layer.show('story/x.webp', {
      effects: { wobble: false, vignette: false, glow: true, candle: true },
    })
    await flushPromises()

    const baseAlpha = internals(layer).glowSprite!.alpha
    expect(baseAlpha).toBeCloseTo(0.45) // tick 前は GLOW_BASE_ALPHA そのまま

    time.tick(16)
    const afterTick = internals(layer).glowSprite!.alpha
    expect(afterTick).not.toBeCloseTo(baseAlpha, 5)
    // GLOW_BASE_ALPHA(0.45) * flicker係数([0.86, 1.0]) の範囲に収まる。
    expect(afterTick).toBeGreaterThanOrEqual(0.45 * 0.86 - 0.001)
    expect(afterTick).toBeLessThanOrEqual(0.45 * 1.0 + 0.001)
  })

  it('状態遷移(最重要): 演出ありの画像表示中に演出なしの新しい画像へ show() すると、旧filters/旧glowSprite/旧ambientTimerが確実にクリアされ新画像に演出が一切残らない', async () => {
    mockAssetsLoadResolved()
    const time = virtualTime()
    const layer = makeLayer(time)
    layer.show('story/a.webp', {
      effects: { wobble: false, vignette: true, glow: true, candle: true },
    })
    await flushPromises()
    const ll = internals(layer)
    expect(ll.imageGroup.filters).not.toBeNull()
    expect(ll.glowSprite).not.toBeNull()
    expect(ll.ambientTimer).not.toBeNull()

    // 新しい show() は effects を省略 = 全 false（無演出）。
    layer.show('story/b.webp')
    await flushPromises()

    expect(ll.imageGroup.filters).toBeNull()
    expect(ll.glowSprite).toBeNull()
    expect(ll.ambientTimer).toBeNull()
  })

  it('remove() 時、wobble/candle 有効な画像でも ambientTimer がリークしない (time.getPendingTimerCount()===0)', async () => {
    mockAssetsLoadResolved()
    const time = virtualTime()
    const layer = makeLayer(time)
    layer.show('story/x.webp', {
      effects: { wobble: true, vignette: false, glow: false, candle: true },
    })
    await flushPromises()
    expect(internals(layer).ambientTimer).not.toBeNull()

    layer.remove()
    expect(internals(layer).ambientTimer).toBeNull()
    expect(time.getPendingTimerCount()).toBe(0)
  })

  it('getState(): 全フラグ false のとき effects キー自体が省略され、いずれか true のとき含まれる', () => {
    const noEffectsLayer = makeLayer(virtualTime())
    noEffectsLayer.show('x.webp')
    const noEffectsState = noEffectsLayer.getState()
    expect(noEffectsState).toEqual({ path: 'x.webp', back: 'Hide' })
    expect(Object.prototype.hasOwnProperty.call(noEffectsState, 'effects')).toBe(false)

    const withEffectsLayer = makeLayer(virtualTime())
    withEffectsLayer.show('y.webp', {
      effects: { wobble: true, vignette: false, glow: false, candle: false },
    })
    expect(withEffectsLayer.getState()).toEqual({
      path: 'y.webp',
      back: 'Hide',
      effects: { wobble: true, vignette: false, glow: false, candle: false },
    })
  })

  it('restore(): 旧形式セーブ({path,back}のみ、effectsキーなし)を復元すると effects は全false相当になる', async () => {
    mockAssetsLoadResolved()
    const layer = makeLayer(virtualTime())
    // 旧セーブフォーマット。effects キー自体が存在しない (#582 導入前のセーブデータを模す)。
    const legacyState: EventImageState = { path: 'story/x.webp', back: 'Keep' }
    layer.restore(legacyState)
    await flushPromises()

    // show() の `opts.effects ?? NO_AMBIENT_EFFECTS` で全 false にフォールバックするので、
    // 時間非依存/依存いずれの演出も一切発火しない。
    const ll = internals(layer)
    expect(ll.ambientTimer).toBeNull()
    expect(ll.imageGroup.filters).toBeNull()
    expect(ll.glowSprite).toBeNull()
  })
})

describe('EventImageLayer ピクセレート遷移 (#583)', () => {
  // swapAtMs が 16ms(pixelateTimer の tick 間隔)の倍数になるよう fadeMs=320 を基本値に使う
  // （swapAtMs=160、remaining=160）。境界テストで tick の累計値が swapAtMs と厳密に一致する
  // ようにするための選択（16の倍数でないと丸めで境界がぼやける）。

  it('基本のコルセン→スワップ→リファインが一連の流れとして進行する', async () => {
    mockAssetsLoadResolved()
    const time = virtualTime()
    const layer = makeLayer(time)
    layer.show('story/a.webp')
    await flushPromises()
    expect(internals(layer).sprite).not.toBeNull()

    layer.show('story/b.webp', { transition: 'Pixelate', fadeMs: 320 })
    const ll = internals(layer)
    expect(ll.pixelateState).not.toBeNull()
    expect(ll.pixelateState!.phase).toBe('coarsen')
    expect(ll.pixelateFilter!.sizeX).toBe(1)

    await flushPromises() // bのロード完了(pendingTexture確保、まだコルセン中)

    time.tick(80) // swapAtMs(160)の半分まで進める
    expect(ll.pixelateFilter!.sizeX).toBeGreaterThan(1)
    expect(ll.pixelateFilter!.sizeX).toBeLessThan(PIXELATE_TRANSITION_MAX_SIZE)

    time.tick(80) // 累計160ms = swapAtMsちょうど: スワップ
    expect(ll.pixelateState!.phase).toBe('refine')
    expect(layer.getState()?.path).toBe('story/b.webp')

    time.tick(170) // リファイン完了(remaining=160)
    expect(ll.pixelateState).toBeNull()
    expect(ll.pixelateFilter!.sizeX).toBe(1)
    expect(layer.hasPendingVisualTransition()).toBe(false)
  })

  it('スワップタイミングの境界(swapAtMs-1/swapAtMs/swapAtMs+1)で from→to が正確に切り替わる', async () => {
    mockAssetsLoadResolved()
    const time = virtualTime()
    const layer = makeLayer(time)
    layer.show('story/a.webp')
    await flushPromises()

    layer.show('story/b.webp', { transition: 'Pixelate', fadeMs: 320 })
    await flushPromises() // bのロードを先に完了させておく(holdingへ回らないようにする)

    const ll = internals(layer)
    time.tick(159)
    expect(ll.pixelateState!.phase).toBe('coarsen')

    time.tick(1) // 累計160ms = swapAtMsちょうど
    expect(ll.pixelateState!.phase).toBe('refine')
    expect(layer.getState()?.path).toBe('story/b.webp')

    time.tick(1) // 累計161ms
    expect(ll.pixelateState!.phase).toBe('refine')
  })

  it('spriteが無い場合(初回表示等)はPixelate指定でもFade経路(即時/フェード表示)にフォールバックする', async () => {
    mockAssetsLoadResolved()
    const layer = makeLayer(virtualTime())
    // 初回show()なのでthis.spriteはまだ無い。
    layer.show('story/a.webp', { transition: 'Pixelate', fadeMs: 500 })
    expect(internals(layer).pixelateState).toBeNull()

    await flushPromises()
    expect(internals(layer).sprite).not.toBeNull()
    expect(internals(layer).fadeAnimation).toMatchObject({
      durationMs: 500,
      fromAlpha: 0,
      toAlpha: 1,
    })
  })

  it('fadeMs<=0はPixelate指定でもFade経路(即時表示)にフォールバックする', async () => {
    mockAssetsLoadResolved()
    const layer = makeLayer(virtualTime())
    layer.show('story/a.webp')
    await flushPromises()

    layer.show('story/b.webp', { transition: 'Pixelate', fadeMs: 0 })
    expect(internals(layer).pixelateState).toBeNull()

    await flushPromises()
    expect(internals(layer).sprite!.alpha).toBe(1)
    expect(internals(layer).fadeAnimation).toBeNull()
  })

  it('ロードがコルセン完了より先に終わる場合、holdingフェーズを経ずに即座にスワップする', async () => {
    mockAssetsLoadResolved()
    const time = virtualTime()
    const layer = makeLayer(time)
    layer.show('story/a.webp')
    await flushPromises()

    layer.show('story/b.webp', { transition: 'Pixelate', fadeMs: 320 })
    await flushPromises() // bのロードを先に完了させておく

    const ll = internals(layer)
    time.tick(159)
    expect(ll.pixelateState!.phase).toBe('coarsen')

    time.tick(1) // swapAtMsちょうど: ロード済みなのでholdingを経由せず即座にrefineへ
    expect(ll.pixelateState!.phase).toBe('refine')
  })

  it('ロードがコルセン完了より後に終わる場合、holdingフェーズで最大粗さのまま待機してからスワップする', async () => {
    mockAssetsLoadResolved() // 最初のaは即座にロード
    const time = virtualTime()
    const layer = makeLayer(time)
    layer.show('story/a.webp')
    await flushPromises()

    // bのロードだけは手動で解決を制御する。
    let resolveB: ((t: Texture) => void) | null = null
    vi.spyOn(Assets, 'load').mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveB = resolve
        }) as never
    )
    layer.show('story/b.webp', { transition: 'Pixelate', fadeMs: 320 }) // swapAtMs=160

    const ll = internals(layer)
    time.tick(160) // コルセン完了。bのロードはまだ終わっていない。
    expect(ll.pixelateState!.phase).toBe('holding')
    expect(ll.pixelateFilter!.sizeX).toBe(PIXELATE_TRANSITION_MAX_SIZE)
    // settled state(getState())はロード成否に関わらず即座にbを指すが、見た目(sprite)は
    // まだ旧画像aのまま(スワップ未実施)。
    expect(layer.getState()?.path).toBe('story/b.webp')

    expect(resolveB).not.toBeNull()
    resolveB!(mockTexture())
    await flushPromises()
    expect(ll.pixelateState!.phase).toBe('refine')
  })

  it('pixelate進行中に別のpixelate遷移が割り込むと、直前の遷移は打ち切られ新しい遷移が最初からやり直される', async () => {
    mockAssetsLoadResolved()
    const time = virtualTime()
    const layer = makeLayer(time)
    layer.show('story/a.webp')
    await flushPromises()

    layer.show('story/b.webp', { transition: 'Pixelate', fadeMs: 320 })
    await flushPromises()
    time.tick(100) // コルセン進行中(まだswapAtMs=160未満)

    const ll = internals(layer)
    expect(ll.pixelateState!.path).toBe('story/b.webp')
    expect(ll.pixelateFilter!.sizeX).toBeGreaterThan(1)

    // 別画像へのpixelate遷移で割り込む。
    layer.show('story/c.webp', { transition: 'Pixelate', fadeMs: 320 })
    expect(ll.pixelateState!.path).toBe('story/c.webp')
    expect(ll.pixelateState!.phase).toBe('coarsen')
    expect(ll.pixelateFilter!.sizeX).toBe(1) // 新しい遷移はsize=1からやり直し
  })

  it('pixelate進行中にFadeへの通常show()が割り込むと、pixelateTimerがリークせず打ち切られる', async () => {
    mockAssetsLoadResolved()
    const time = virtualTime()
    const layer = makeLayer(time)
    layer.show('story/a.webp')
    await flushPromises()

    layer.show('story/b.webp', { transition: 'Pixelate', fadeMs: 320 })
    await flushPromises()
    time.tick(100)
    expect(internals(layer).pixelateState).not.toBeNull()

    // 表示中の絵の有無に関わらず、通常(Fade)のshow()で割り込む。
    layer.show('story/c.webp', { fadeMs: 400 })
    expect(internals(layer).pixelateState).toBeNull()

    await flushPromises()
    time.tick(500) // フェード完了まで進める
    expect(time.getPendingTimerCount()).toBe(0)
  })

  it('pixelate進行中にremove()すると遷移が打ち切られ、タイマーもリークしない', async () => {
    mockAssetsLoadResolved()
    const time = virtualTime()
    const layer = makeLayer(time)
    layer.show('story/a.webp')
    await flushPromises()

    layer.show('story/b.webp', { transition: 'Pixelate', fadeMs: 320 })
    await flushPromises()
    time.tick(100)
    expect(internals(layer).pixelateState).not.toBeNull()

    layer.remove()
    expect(internals(layer).pixelateState).toBeNull()
    expect(layer.getState()).toBeNull()
    expect(time.getPendingTimerCount()).toBe(0)
  })

  it('pixelate遷移中のテクスチャロード失敗時は遷移を打ち切り、旧画像の表示を維持する', async () => {
    mockAssetsLoadResolved()
    const time = virtualTime()
    const layer = makeLayer(time)
    layer.show('story/a.webp')
    await flushPromises()

    const err = new Error('load failed')
    vi.spyOn(Assets, 'load').mockRejectedValue(err)
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    layer.show('story/b.webp', { transition: 'Pixelate', fadeMs: 320 })
    expect(internals(layer).pixelateState).not.toBeNull() // 開始直後はまだ進行中

    await flushPromises()
    expect(warnSpy).toHaveBeenCalledTimes(1)
    expect(internals(layer).pixelateState).toBeNull() // ロード失敗でcancelPixelateTransitionされる
    expect(layer.getState()?.path).toBe('story/b.webp') // settled stateはload成否に関わらずb
    // cancelPixelateTransitionはsprite自体には触れないため、旧画像(a)のspriteが残り続ける
    // （見た目の維持、フォールバック）。
    expect(internals(layer).sprite).not.toBeNull()

    warnSpy.mockRestore()
  })

  it('pixelate遷移前後でタイマーがリークせず、ambientTimerが二重に残らない', async () => {
    mockAssetsLoadResolved()
    const time = virtualTime()
    const layer = makeLayer(time)
    const candleEffects = { wobble: false, vignette: false, glow: false, candle: true }
    layer.show('story/a.webp', { effects: candleEffects })
    await flushPromises()
    expect(time.getPendingTimerCount()).toBe(1) // ambientTimerのみ

    layer.show('story/b.webp', { transition: 'Pixelate', fadeMs: 320, effects: candleEffects })
    await flushPromises()
    expect(time.getPendingTimerCount()).toBe(2) // 旧ambientTimer + pixelateTimer

    time.tick(160) // スワップ: 旧ambientTimerは破棄され新しいambientTimerが立つ(正味変化なし)
    expect(time.getPendingTimerCount()).toBe(2) // 新ambientTimer + pixelateTimer

    time.tick(161) // リファイン完了(remaining=160)
    expect(time.getPendingTimerCount()).toBe(1) // pixelateTimerは停止、ambientTimerだけ残る
  })

  it('pixelate遷移中もglow演出(glowSprite)が新画像に正しく設定される', async () => {
    mockAssetsLoadResolved()
    const time = virtualTime()
    const layer = makeLayer(time)
    layer.show('story/a.webp')
    await flushPromises()

    layer.show('story/b.webp', {
      transition: 'Pixelate',
      fadeMs: 320,
      effects: { wobble: false, vignette: false, glow: true, candle: false },
    })
    await flushPromises()
    const ll = internals(layer)
    expect(ll.glowSprite).toBeNull() // スワップ前はまだglowSprite無し(旧画像aはglow無指定)

    time.tick(160) // スワップ
    expect(ll.glowSprite).not.toBeNull()
    expect(ll.glowSprite!.blendMode).toBe('overlay')
  })

  it('pixelate遷移中もshouldHideBackLayer()はスプライトが存在する限りtrueを維持する(back=Hide既定)', async () => {
    mockAssetsLoadResolved()
    const time = virtualTime()
    const layer = makeLayer(time)
    layer.show('story/a.webp')
    await flushPromises()
    expect(layer.shouldHideBackLayer()).toBe(true)

    layer.show('story/b.webp', { transition: 'Pixelate', fadeMs: 320 })
    await flushPromises()
    // pixelate遷移はコルセン中も常にalpha=1で旧画像を表示し続けるため、Fade経路のような
    // 「フェードイン完了まで背面を隠さない」制御は不要(doc comment参照)。
    expect(layer.shouldHideBackLayer()).toBe(true)

    time.tick(160) // スワップ
    expect(layer.shouldHideBackLayer()).toBe(true)

    time.tick(161) // リファイン完了
    expect(layer.shouldHideBackLayer()).toBe(true)
  })

  it('onVisibilityChangeはスワップの瞬間に一度だけ発火する(コルセン開始時ではない)', async () => {
    mockAssetsLoadResolved()
    const time = virtualTime()
    const layer = makeLayer(time)
    layer.show('story/a.webp')
    await flushPromises()

    const onVisibilityChange = vi.fn()
    layer.show('story/b.webp', { transition: 'Pixelate', fadeMs: 320, onVisibilityChange })
    await flushPromises()
    expect(onVisibilityChange).not.toHaveBeenCalled()

    time.tick(159)
    expect(onVisibilityChange).not.toHaveBeenCalled()

    time.tick(1) // swapAtMsちょうど: スワップ発火
    expect(onVisibilityChange).toHaveBeenCalledTimes(1)

    time.tick(161) // リファイン完了後も再度は呼ばれない
    expect(onVisibilityChange).toHaveBeenCalledTimes(1)
  })

  it('assetBaseUrl 未設定時はPixelate指定でも pixelateState/pixelateTimer を作らず hasPendingVisualTransition() は false（Fade経路の姉妹テスト）', async () => {
    const loadSpy = vi.spyOn(Assets, 'load')
    const layer = new EventImageLayer(SCREEN_W, SCREEN_H, virtualTime())
    // setAssetBaseUrl を呼ばない。show() 経由でも this.sprite が無いためこのままでは
    // Fade経路にフォールバックしてしまうので、まず内部的に sprite を直接生やしてから
    // Pixelate遷移を起動する（このテストの関心は「assetBaseUrl 未設定時のガード位置」であり
    // 「sprite の有無によるフォールバック分岐」ではないため）。
    internals(layer).sprite = { alpha: 1 } as never

    layer.show('story/b.webp', { transition: 'Pixelate', fadeMs: 320 })

    expect(loadSpy).not.toHaveBeenCalled()
    expect(internals(layer).pixelateState).toBeNull()
    expect(internals(layer).pixelateTimer).toBeNull()
    expect(layer.getState()).toEqual({ path: 'story/b.webp', back: 'Hide' })
    expect(layer.hasPendingVisualTransition()).toBe(false)
  })

  it(
    '表示中と同じパスへ遷移=pixelateで再指定すると、GUIは実際にコルセン→自己スワップ→' +
      'リファインを再生する（既知の非対称性: TUI版は current_target() != target という' +
      'パス一致ガードでno-opになり何も起きない。docs/architecture.md' +
      '「イベント絵ピクセレート遷移 (#583)」の既知の非対称性の節を参照。GUI/TUIで意図的な' +
      '仕様統一はされていない）',
    async () => {
      mockAssetsLoadResolved()
      const time = virtualTime()
      const layer = makeLayer(time)
      layer.show('story/a.webp')
      await flushPromises()
      const firstSprite = internals(layer).sprite

      // 同一パス('story/a.webp')へPixelate遷移で再指定する。GUIはパスの同一性を見ず
      // 「表示中の絵の有無」(this.sprite の有無)だけで判定するため、実際にコルセンが
      // 開始される。
      layer.show('story/a.webp', { transition: 'Pixelate', fadeMs: 320 })
      expect(internals(layer).pixelateState).not.toBeNull()
      expect(internals(layer).pixelateState!.path).toBe('story/a.webp')

      await flushPromises()
      time.tick(160) // スワップ
      expect(internals(layer).pixelateState!.phase).toBe('refine')
      // スワップにより旧spriteは破棄され、同じpathの新しいspriteインスタンスに
      // 差し替わる(見た目上は同じ画像だが、コルセン→スワップ→リファインの演出は
      // 実際に再生される)。
      expect(internals(layer).sprite).not.toBe(firstSprite)

      time.tick(161)
      expect(internals(layer).pixelateState).toBeNull() // リファイン完了で遷移終了
    }
  )
})
