/**
 * NovelRenderer.showTitleScreen() / hideTitleScreen() の単体テスト (#628 フェーズ2b)。
 *
 * TitleScreenOverlay 自体（背景色・ボタン描画・disabled 状態等）は TitleScreenOverlay.test.ts が
 * 担保する。ここでは NovelRenderer 側の「仲介・オーケストレーション」契約だけを縛る:
 *   - バグ#1 z-order 固定: showTitleScreen() で dialogBox/seekBar/eventImageLayer を隠し、
 *     hideTitleScreen() で復元する
 *   - バグ#3 split_layout 固定: showTitleScreen() で split_layout 領域を一時解除し、
 *     hideTitleScreen() で退避値を復元する
 *   - ロゴ画像は自前で持たず characterLayer.showImage()/remove() に委譲する（常に Fade・
 *     id='__title_logo__'固定であることの回帰テスト）
 *   - ロード成否 (onLoaded/onError) が titleScreenOverlay.hideFallbackText() 呼び出しに反映される
 *   - canvas native pointerdown ハンドラ（handleAdvance 相当）はタイトル画面表示中はゲーム進行を
 *     抑止する。ボタンコールバックは justSelectedChoice で同一ジェスチャの二重発火を1回だけ抑止する
 *
 * 駆動方式（NovelRenderer.splitLayoutScrim.test.ts / NovelRenderer.outsideCanvasTap.test.ts と同形）:
 *   `new NovelRenderer()` のみ（init() は呼ばない）。dialogBox/seekBar/eventImageLayer/
 *   characterLayer/titleScreenOverlay は constructor で同期生成されるため、init 不要で
 *   private フィールドへ直接到達できる。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Assets } from 'pixi.js'
import { NovelRenderer } from './NovelRenderer'
import type { Event, EventScene } from '../types'
import type { LayoutRect } from './novelLayout'

function narration(...lines: string[]): Event {
  return { Narration: { text: lines } }
}

function scene(id: string, events: Event[]): EventScene {
  return { id, title: id, view: 'TopDown', events }
}

const flushPromises = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

const TITLE_LOGO_IMAGE_ID = '__title_logo__'

function makeTitleScreenOpts(overrides?: Partial<Parameters<NovelRenderer['showTitleScreen']>[0]>) {
  return {
    title: 'テストタイトル',
    hasSaveData: false,
    onNewGame: vi.fn(),
    onContinue: vi.fn(),
    onOpenSettings: vi.fn(),
    onBack: vi.fn(),
    ...overrides,
  }
}

interface TitleScreenInternals {
  dialogBox: { visible: boolean }
  seekBar: { visible: boolean; setTitleScreenHidden: (hidden: boolean) => void }
  eventImageLayer: { visible: boolean }
  characterLayer: {
    getSplitLayoutRegion(): LayoutRect | null
    setSplitLayoutRegion(region: LayoutRect | null): void
    showImage: (...args: unknown[]) => void
    remove: (...args: unknown[]) => void
  }
  titleScreenOverlay: {
    visible: boolean
    hideFallbackText: () => void
    show: (opts: {
      title: string
      hasSaveData: boolean
      dark?: boolean
      onNewGame: () => void
      onContinue: () => void
      onOpenSettings: () => void
      onBack: () => void
    }) => void
  }
  resolvedEvents: Event[]
}
function internals(r: NovelRenderer): TitleScreenInternals {
  return r as unknown as TitleScreenInternals
}

/** handleAdvance() 経由で叩かれる audioManager.ensureContext() を no-op にする（jsdom に AudioContext が無い）。 */
function muteAudio(r: NovelRenderer) {
  vi.spyOn(r.getAudioManager(), 'ensureContext').mockImplementation(() => {})
}

describe('NovelRenderer.showTitleScreen() / hideTitleScreen() (#628 フェーズ2b)', () => {
  beforeEach(() => {
    vi.spyOn(Assets, 'load').mockResolvedValue({
      width: 10,
      height: 10,
      source: { scaleMode: 'linear' },
    } as never)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('TC25: showTitleScreen() で dialogBox.visible が false になる（バグ#1 z-order の単体固定）', () => {
    const r = new NovelRenderer()
    r.showTitleScreen(makeTitleScreenOpts())
    expect(internals(r).dialogBox.visible).toBe(false)
  })

  it('TC26: showTitleScreen() で seekBar.setTitleScreenHidden(true) 相当（seekBar.visible が false）になる', () => {
    const r = new NovelRenderer()
    const setHiddenSpy = vi.spyOn(internals(r).seekBar, 'setTitleScreenHidden')
    r.showTitleScreen(makeTitleScreenOpts())
    expect(setHiddenSpy).toHaveBeenCalledWith(true)
    expect(internals(r).seekBar.visible).toBe(false)
  })

  it('TC27: showTitleScreen() で eventImageLayer.visible が false になる', () => {
    const r = new NovelRenderer()
    r.showTitleScreen(makeTitleScreenOpts())
    expect(internals(r).eventImageLayer.visible).toBe(false)
  })

  it('TC28: hideTitleScreen() で dialogBox/seekBar/eventImageLayer の可視性が全て復元される', () => {
    const r = new NovelRenderer()
    r.showTitleScreen(makeTitleScreenOpts())
    expect(internals(r).dialogBox.visible).toBe(false)
    expect(internals(r).seekBar.visible).toBe(false)
    expect(internals(r).eventImageLayer.visible).toBe(false)

    r.hideTitleScreen()

    expect(internals(r).dialogBox.visible).toBe(true)
    expect(internals(r).seekBar.visible).toBe(true)
    expect(internals(r).eventImageLayer.visible).toBe(true)
  })

  it('TC29: split_layout:true の状態で showTitleScreen() を呼ぶと characterLayer.getSplitLayoutRegion() が null になる（バグ#3の単体固定）', () => {
    const r = new NovelRenderer()
    r.setSplitLayout(true)
    expect(internals(r).characterLayer.getSplitLayoutRegion()).not.toBeNull()

    r.showTitleScreen(makeTitleScreenOpts())

    expect(internals(r).characterLayer.getSplitLayoutRegion()).toBeNull()
  })

  it('TC30: 同上の状態で hideTitleScreen() を呼ぶと getSplitLayoutRegion() が元のregion値に復元される', () => {
    const r = new NovelRenderer()
    r.setSplitLayout(true)
    const regionBefore = internals(r).characterLayer.getSplitLayoutRegion()
    expect(regionBefore).not.toBeNull()

    r.showTitleScreen(makeTitleScreenOpts())
    expect(internals(r).characterLayer.getSplitLayoutRegion()).toBeNull()

    r.hideTitleScreen()

    expect(internals(r).characterLayer.getSplitLayoutRegion()).toEqual(regionBefore)
  })

  it('TC31: split_layout:false の場合、showTitleScreen()/hideTitleScreen() を呼んでも setSplitLayoutRegion は一切呼ばれない', () => {
    const r = new NovelRenderer()
    // split_layout 未指定＝既定 false。setSplitLayout 自体は初期化時に false で呼ばれうるので、
    // スパイは setSplitLayout(false) を明示してから張る。
    r.setSplitLayout(false)
    const setRegionSpy = vi.spyOn(internals(r).characterLayer, 'setSplitLayoutRegion')

    r.showTitleScreen(makeTitleScreenOpts())
    r.hideTitleScreen()

    expect(setRegionSpy).not.toHaveBeenCalled()
  })

  it('TC32: showTitleScreen() 後、characterLayer.showImage が id: __title_logo__, path: title.png, x: 0.5, transition未指定 で呼ばれる（タイトルは常にFade固定であることの回帰テスト）', () => {
    const r = new NovelRenderer()
    const showImageSpy = vi.spyOn(internals(r).characterLayer, 'showImage')

    r.showTitleScreen(makeTitleScreenOpts({ title: '固有のタイトル' }))

    expect(showImageSpy).toHaveBeenCalledTimes(1)
    const call = showImageSpy.mock.calls[0][0] as Record<string, unknown>
    expect(call.id).toBe(TITLE_LOGO_IMAGE_ID)
    expect(call.path).toBe('title.png')
    expect(call.x).toBe(0.5)
    expect(call.transition).toBeUndefined()
  })

  it('TC33: hideTitleScreen() で characterLayer.remove(__title_logo__, {instant:true}) が呼ばれる', () => {
    const r = new NovelRenderer()
    r.showTitleScreen(makeTitleScreenOpts())
    const removeSpy = vi.spyOn(internals(r).characterLayer, 'remove')

    r.hideTitleScreen()

    expect(removeSpy).toHaveBeenCalledWith(TITLE_LOGO_IMAGE_ID, { instant: true })
  })

  it('TC34: showTitleScreen() → ロード成功相当 → titleScreenOverlay.hideFallbackText() が呼ばれる', async () => {
    const r = new NovelRenderer()
    const hideFallbackSpy = vi.spyOn(internals(r).titleScreenOverlay, 'hideFallbackText')

    r.showTitleScreen(makeTitleScreenOpts())
    await flushPromises()

    expect(hideFallbackSpy).toHaveBeenCalledTimes(1)
  })

  it('TC35: showTitleScreen() → ロード失敗 → hideFallbackText() が呼ばれない', async () => {
    vi.spyOn(Assets, 'load').mockRejectedValue(new Error('404'))
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const r = new NovelRenderer()
    const hideFallbackSpy = vi.spyOn(internals(r).titleScreenOverlay, 'hideFallbackText')

    r.showTitleScreen(makeTitleScreenOpts())
    await flushPromises()

    expect(hideFallbackSpy).not.toHaveBeenCalled()
    warnSpy.mockRestore()
  })

  it('TC36: titleScreenOverlay.visible===true の間、canvas native pointerdown 相当（handleOutsideCanvasTap）はゲーム進行処理を抑止する', () => {
    const r = new NovelRenderer()
    muteAudio(r)
    r.setScenes([scene('s', [narration('一文目'), narration('二文目')])])
    expect(r.getSnapshot().eventIndex).toBe(0)

    r.showTitleScreen(makeTitleScreenOpts())
    expect(internals(r).titleScreenOverlay.visible).toBe(true)

    r.handleOutsideCanvasTap()

    // タイトル画面表示中は advance が抑止されるため eventIndex は前進しない。
    expect(r.getSnapshot().eventIndex).toBe(0)

    // 対照: hideTitleScreen() 後は通常どおり advance が効く（抑止がタイトル画面専用であることの確認）。
    r.hideTitleScreen()
    r.handleOutsideCanvasTap()
    expect(r.getSnapshot().eventIndex).toBe(1)
  })

  it('TC37: ボタンコールバック実行後、justSelectedChoice 抑制フラグが同一ジェスチャの advance を1回だけ抑止し、タイマー後は解除される', () => {
    vi.useFakeTimers()
    try {
      const r = new NovelRenderer()
      muteAudio(r)
      r.setScenes([scene('s', [narration('一文目'), narration('二文目')])])
      // titleScreenOverlay.show() に渡される「ラップ済み」コールバックを捕捉する
      // （NovelRenderer.showTitleScreen 内の suppressAdvanceThenRun は private なので、
      // 実際に TitleScreenOverlay へ渡された関数を spy 経由で取り出して呼ぶ）。
      const showSpy = vi.spyOn(internals(r).titleScreenOverlay, 'show')
      const onNewGame = vi.fn()
      r.showTitleScreen(makeTitleScreenOpts({ onNewGame }))
      const wrappedOnNewGame = showSpy.mock.calls[0][0].onNewGame

      // titleScreenOverlay.visible===true 自体の advance 抑止（TC36）と分離するため、
      // ここで hideTitleScreen() して残る抑止要因を justSelectedChoice 単体にする
      // （justSelectedChoice はレンダラーインスタンスの状態でありタイトル画面の表示可否とは独立）。
      r.hideTitleScreen()

      wrappedOnNewGame()
      expect(onNewGame).toHaveBeenCalledTimes(1)

      // ボタン押下と同フレーム（0ms タイマー未発火）: advance が1回だけ抑止される。
      r.handleOutsideCanvasTap()
      expect(r.getSnapshot().eventIndex).toBe(0)

      // 0ms タイマーが発火し justSelectedChoice が解除された後は通常どおり advance する。
      vi.advanceTimersByTime(0)
      r.handleOutsideCanvasTap()
      expect(r.getSnapshot().eventIndex).toBe(1)
    } finally {
      vi.useRealTimers()
    }
  })
})
