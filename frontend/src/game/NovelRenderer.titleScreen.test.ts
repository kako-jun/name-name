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
    handleKeyDown: (key: string, shiftKey?: boolean) => boolean
  }
  resolvedEvents: Event[]
  handleKeyDown: (e: KeyboardEvent) => void
  backlogOverlay: { visible: boolean; toggle: () => void }
  // #633 フェーズB回帰用の追加フィールド。
  waitingForChoice: boolean
  choiceOverlay: {
    handleKeyDown: (key: string, shiftKey?: boolean) => boolean
    show: (...args: unknown[]) => void
    hide: () => void
  }
  advance: () => void
  saveLoadOverlay: { visible: boolean }
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

  it('TC38: hideTitleScreen() を経由せず showTitleScreen() を2回連続で呼ぶと、ロゴが読み込み済みなら2回目も同期的に hideFallbackText() が呼ばれる（実バグ修正の回帰テスト、#628 フェーズ2b）', async () => {
    // 実バグ: characterLayer.showImage() は同一 id 再表示時（existing 分岐）はテクスチャ差し替え
    // を行わず onLoaded も発火しない。一方 titleScreenOverlay.show() は呼ばれるたびに無条件で
    // 新しい titleText（既定 visible: true）を作るため、hideTitleScreen() を挟まない再呼び出し
    // （NovelPlayer の effect で title/hasSaveData が変わり再レンダーされた場合等）で、ロゴが
    // 既に表示済みなのにフォールバックテキストだけ再び見えてしまっていた。
    const r = new NovelRenderer()
    const hideFallbackSpy = vi.spyOn(internals(r).titleScreenOverlay, 'hideFallbackText')

    r.showTitleScreen(makeTitleScreenOpts())
    await flushPromises()
    expect(hideFallbackSpy).toHaveBeenCalledTimes(1)

    // hideTitleScreen() を挟まず再度呼ぶ。ロゴは既にロード済みのため characterLayer.showImage()
    // は existing 分岐に入り onLoaded は発火しないが、showTitleScreen() 側の
    // characterLayer.hasLoadedTexture() チェックが同期的に hideFallbackText() を呼ぶ。
    r.showTitleScreen(makeTitleScreenOpts({ title: '2回目' }))
    expect(hideFallbackSpy).toHaveBeenCalledTimes(2)
  })

  it('TC39: showTitleScreen() 初回呼び出し時、ロード完了前（flushPromises 前）は hasLoadedTexture が false のため hideFallbackText() は同期的には呼ばれない（新規ロード中の誤検知防止）', () => {
    const r = new NovelRenderer()
    const hideFallbackSpy = vi.spyOn(internals(r).titleScreenOverlay, 'hideFallbackText')

    r.showTitleScreen(makeTitleScreenOpts())

    // Assets.load() はまだ解決していない（await flushPromises() していない）ため、
    // hasLoadedTexture() は false を返し hideFallbackText() は呼ばれていないはず。
    expect(hideFallbackSpy).not.toHaveBeenCalled()
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

  // #633 フェーズA: NovelRenderer.handleKeyDown() 冒頭に追加した titleScreenOverlay.visible
  // ガードの回帰テスト。#628 でタイトル画面を PixiJS 描画へ移行した際、handleAdvance には
  // 同種のガードがあったが handleKeyDown には無かった（TC36/TC37 が担保するのは
  // handleAdvance 側のみ）。
  it('TC40: titleScreenOverlay.visible===true の間、window keydown は titleScreenOverlay.handleKeyDown() に委譲され、戻り値 true なら preventDefault() が呼ばれる', () => {
    const r = new NovelRenderer()
    muteAudio(r)
    r.showTitleScreen(makeTitleScreenOpts())
    expect(internals(r).titleScreenOverlay.visible).toBe(true)

    const delegateSpy = vi
      .spyOn(internals(r).titleScreenOverlay, 'handleKeyDown')
      .mockReturnValue(true)
    const event = new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true })
    const preventDefaultSpy = vi.spyOn(event, 'preventDefault')

    internals(r).handleKeyDown(event)

    expect(delegateSpy).toHaveBeenCalledWith('Tab', true)
    expect(preventDefaultSpy).toHaveBeenCalledTimes(1)
  })

  it('TC41: titleScreenOverlay.visible===true の間、既存のゲーム内ショートカット（b キーの backlogOverlay.toggle 等）は一切発火しない', () => {
    const r = new NovelRenderer()
    muteAudio(r)
    r.showTitleScreen(makeTitleScreenOpts())
    const toggleSpy = vi.spyOn(internals(r).backlogOverlay, 'toggle')

    // TitleScreenOverlay が処理しないキー（'b'）を押しても、backlogOverlay.toggle() 等の
    // ゲーム内ショートカットには一切到達しない（titleScreenOverlay.visible ガードで即 return）。
    internals(r).handleKeyDown(new KeyboardEvent('keydown', { key: 'b' }))

    expect(toggleSpy).not.toHaveBeenCalled()
  })

  it('TC42: titleScreenOverlay.visible===false の場合は従来どおり b キーで backlogOverlay.toggle() が呼ばれる（ガードがタイトル画面専用であることの対照確認）', () => {
    const r = new NovelRenderer()
    muteAudio(r)
    r.showTitleScreen(makeTitleScreenOpts())
    r.hideTitleScreen()
    const toggleSpy = vi.spyOn(internals(r).backlogOverlay, 'toggle')

    internals(r).handleKeyDown(new KeyboardEvent('keydown', { key: 'b' }))

    expect(toggleSpy).toHaveBeenCalledTimes(1)
  })
})

// #633 フェーズB: ChoiceOverlay 側のキーボード操作を NovelRenderer.handleKeyDown が正しく
// waitingForChoice ガードで委譲することの回帰テスト。TC40-42（titleScreenOverlay.visible ガード）
// と同じ構造を waitingForChoice ガードに対して繰り返す（TC-N1〜N3）。TC-N4〜N7 は
// choiceOverlay をモックせず実スクリプトで実際に選択肢を表示し、キー操作だけでシーン遷移が
// 完了するところまで確認する E2E（テスト観点整理フェーズで最優先とされた「本命」テスト）。
describe('NovelRenderer.handleKeyDown() waitingForChoiceガード (#633 フェーズB)', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('TC-N1: waitingForChoice===trueのとき、window keydownはchoiceOverlay.handleKeyDown()に委譲され、戻り値trueならpreventDefault()が呼ばれる', () => {
    const r = new NovelRenderer()
    muteAudio(r)
    internals(r).waitingForChoice = true
    const delegateSpy = vi.spyOn(internals(r).choiceOverlay, 'handleKeyDown').mockReturnValue(true)
    const event = new KeyboardEvent('keydown', { key: 'ArrowDown' })
    const preventDefaultSpy = vi.spyOn(event, 'preventDefault')

    internals(r).handleKeyDown(event)

    expect(delegateSpy).toHaveBeenCalledWith('ArrowDown', false)
    expect(preventDefaultSpy).toHaveBeenCalledTimes(1)
  })

  it('TC-N2: waitingForChoice===trueの間、bキー・sキー・lキーが一切発火しない（choiceOverlay.handleKeyDownがfalseを返すキーでも発火しないことを含む）', () => {
    const r = new NovelRenderer()
    muteAudio(r)
    internals(r).waitingForChoice = true
    // ChoiceOverlay 側が未処理（縦一列時のArrowLeft/Right等）で false を返しても、
    // waitingForChoice ガード自体が早期 return するため後続のショートカット判定へ
    // フォールスルーしないはず。
    vi.spyOn(internals(r).choiceOverlay, 'handleKeyDown').mockReturnValue(false)
    const toggleSpy = vi.spyOn(internals(r).backlogOverlay, 'toggle')

    internals(r).handleKeyDown(new KeyboardEvent('keydown', { key: 'b' }))
    internals(r).handleKeyDown(new KeyboardEvent('keydown', { key: 's' }))
    internals(r).handleKeyDown(new KeyboardEvent('keydown', { key: 'l' }))

    expect(toggleSpy).not.toHaveBeenCalled()
    expect(internals(r).saveLoadOverlay.visible).toBe(false)
  })

  it('TC-N3: waitingForChoice===false（通常時）は従来どおりbキーでbacklogOverlay.toggleが呼ばれる', () => {
    const r = new NovelRenderer()
    muteAudio(r)
    expect(internals(r).waitingForChoice).toBe(false)
    const toggleSpy = vi.spyOn(internals(r).backlogOverlay, 'toggle')

    internals(r).handleKeyDown(new KeyboardEvent('keydown', { key: 'b' }))

    expect(toggleSpy).toHaveBeenCalledTimes(1)
  })
})

describe('NovelRenderer キーボード操作でのChoice確定 E2E (#633 フェーズB 本命)', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  // narration → Choice(2択) → 各ジャンプ先シーン(narrationのみ)。jumpToScene は同期的に
  // 次のテキストイベントまで処理するため、Assets.load 等の非同期アセットを挟まない
  // narration-only な題材にする（confinement.test.ts / startFrom.test.ts と同じ割り切り）。
  const CHOICE_SCENES_2: EventScene[] = [
    scene('start2', [
      narration('本文'),
      {
        Choice: {
          options: [
            { text: '選択肢A', jump: 'sceneA2' },
            { text: '選択肢B', jump: 'sceneB2' },
          ],
        },
      } as Event,
    ]),
    scene('sceneA2', [narration('Aへ到達')]),
    scene('sceneB2', [narration('Bへ到達')]),
  ]

  const CHOICE_SCENES_3: EventScene[] = [
    scene('start3', [
      narration('本文'),
      {
        Choice: {
          options: [
            { text: '選択肢A', jump: 'sceneA3' },
            { text: '選択肢B', jump: 'sceneB3' },
            { text: '選択肢C', jump: 'sceneC3' },
          ],
        },
      } as Event,
    ]),
    scene('sceneA3', [narration('Aへ到達')]),
    scene('sceneB3', [narration('Bへ到達')]),
    scene('sceneC3', [narration('Cへ到達')]),
  ]

  // 全選択肢が未設定フラグを condition に持ち、ロックされたまま解除できないシーン。
  const CHOICE_SCENES_ALL_LOCKED: EventScene[] = [
    scene('gateLocked', [
      narration('本文'),
      {
        Choice: {
          options: [
            { text: 'ロックA', jump: 'sceneLockedA', condition: 'never_set_flag' },
            { text: 'ロックB', jump: 'sceneLockedB', condition: 'never_set_flag' },
          ],
        },
      } as Event,
    ]),
    scene('sceneLockedA', [narration('A')]),
    scene('sceneLockedB', [narration('B')]),
  ]

  it('TC-N4(本命): 実スクリプト（Choiceイベントを含む）でchoiceOverlayをモックせず実際に表示し、handleKeyDown(ArrowDown)→handleKeyDown(Enter)で想定のjump先シーンへ実際に遷移し、waitingForChoiceがfalseにリセットされる', () => {
    const r = new NovelRenderer()
    muteAudio(r)
    r.setScenes(CHOICE_SCENES_2)
    internals(r).advance() // narration → Choice に到達。実choiceOverlay.show()が呼ばれる。
    expect(internals(r).waitingForChoice).toBe(true)

    internals(r).handleKeyDown(new KeyboardEvent('keydown', { key: 'ArrowDown' })) // index0→1
    internals(r).handleKeyDown(new KeyboardEvent('keydown', { key: 'Enter' }))

    expect(r.getCurrentSceneId()).toBe('sceneB2')
    expect(internals(r).waitingForChoice).toBe(false)
  })

  it('TC-N5: TC-N4と同じE2Eで、ArrowDown等でフォーカスを非先頭の選択肢に動かしてからEnterした場合、フォーカス中の選択肢のjumpが遷移先になる', () => {
    const r = new NovelRenderer()
    muteAudio(r)
    r.setScenes(CHOICE_SCENES_3)
    internals(r).advance()
    expect(internals(r).waitingForChoice).toBe(true)

    internals(r).handleKeyDown(new KeyboardEvent('keydown', { key: 'ArrowDown' })) // index0→1
    internals(r).handleKeyDown(new KeyboardEvent('keydown', { key: 'ArrowDown' })) // index1→2
    internals(r).handleKeyDown(new KeyboardEvent('keydown', { key: 'Enter' }))

    // フォーカスが動いていなければ sceneA3（先頭）へ遷移してしまうはずだが、
    // 実際にフォーカスした index2（選択肢C）の jump が遷移先になる。
    expect(r.getCurrentSceneId()).toBe('sceneC3')
  })

  it('TC-N6: 全選択肢ロックのChoiceイベントで、ArrowDown→Enterしても遷移が起きず、waitingForChoiceがtrueのまま維持される', () => {
    const r = new NovelRenderer()
    muteAudio(r)
    r.setScenes(CHOICE_SCENES_ALL_LOCKED)
    internals(r).advance()
    expect(internals(r).waitingForChoice).toBe(true)
    const startSceneId = r.getCurrentSceneId()

    internals(r).handleKeyDown(new KeyboardEvent('keydown', { key: 'ArrowDown' }))
    internals(r).handleKeyDown(new KeyboardEvent('keydown', { key: 'Enter' }))

    expect(r.getCurrentSceneId()).toBe(startSceneId)
    expect(internals(r).waitingForChoice).toBe(true)
  })

  it('TC-N7: titleScreenOverlay.visibleとwaitingForChoiceが同時にtrueになることは通常ないが、両ガードの優先順位（TitleScreen判定が先）が意図通りであることを確認する', () => {
    const r = new NovelRenderer()
    muteAudio(r)
    r.showTitleScreen(makeTitleScreenOpts())
    expect(internals(r).titleScreenOverlay.visible).toBe(true)
    // 通常は起こらない状態（両方 true）を強制的に作り、handleKeyDown 冒頭のガード順を検証する。
    internals(r).waitingForChoice = true

    const titleDelegateSpy = vi
      .spyOn(internals(r).titleScreenOverlay, 'handleKeyDown')
      .mockReturnValue(true)
    const choiceDelegateSpy = vi.spyOn(internals(r).choiceOverlay, 'handleKeyDown')

    internals(r).handleKeyDown(new KeyboardEvent('keydown', { key: 'Enter' }))

    expect(titleDelegateSpy).toHaveBeenCalledWith('Enter', false)
    expect(choiceDelegateSpy).not.toHaveBeenCalled()
  })
})
