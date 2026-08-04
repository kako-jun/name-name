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
