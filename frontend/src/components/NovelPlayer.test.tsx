// kako-jun/name-name#310: NovelPlayer の再生 UI ボタン出し分け・配置・デバッグ HUD トグルの単体テスト。
//
// 検証ポイント:
//   - DT1: skipEnabled で Skip(S) ボタンの描画/非描画（未指定/null/true で出す・false で出さない）
//   - DT2: debugEnabled で Debug(D) ボタンの描画/非描画。D が無いとき DebugOverlay パネルも mount されない
//   - DT-SLOT: 表示ボタン集合ごとの inline style.right（右下スロット詰め＝隙間を作らない）
//   - T1-T7: デバッグ HUD の展開状態遷移（localStorage 永続化・厳格 === '1'・例外耐性・パネル開時のみ polling）
//
// NovelRenderer は PixiJS を構築し jsdom で init 不可のため vi.mock でスタブ化する
// （PlayerScreen.test.tsx の mock 流儀に倣う）。ボタンは同期 JSX の Tailwind <button> なので
// mock 後は canvas 非依存でレンダーされる。
//
// 非適用（書かない）: pixel 位置・モバイル見た目（blink で確認）/ i18n / skip-read-only(#140)・
//   auto(#139) のロジック（不変＝既存 NovelRenderer.*.test.ts の緑維持で担保）。
// /edit 経路の prop 転送（EditorScreen が debugEnabled={true} 固定）は EditorScreen のテストが
//   存在しないため対象外。ここでは「debugEnabled=true を渡せば D が出る」ことだけ DT2 で縛る。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { Assets, Texture } from 'pixi.js'
import {
  computeDynamicRenderResolution,
  getIndicatorImageUrls,
  numberToHexColor,
  AUTO_BUTTON_FALLBACK_COLOR,
  SKIP_BUTTON_FALLBACK_COLOR,
  DEBUG_BUTTON_FALLBACK_COLOR,
} from '../game/novelLayout'
import { INACTIVITY_MS } from '../game/SeekBar'
import type { NovelGameState } from '../game/GameState'

// NovelRenderer を完全スタブ化（PixiJS 構築・init を無効化）。
// NovelPlayer は init().then(...) 内で多数の setter を呼ぶので、すべて no-op で受ける。
// getDebugState は DebugOverlay の polling が呼ぶため最小の DebugState 形を返す。
//
// `new NovelRenderer(...)` で構築されるため、mock はコンストラクタ（クラス本体）を返す必要がある。
// vi.mock の factory は冒頭にホイストされるので、クラス・生成インスタンス記録は vi.hoisted で
// 一緒にホイストして factory から参照できるようにする（top-level 変数参照の TDZ を回避）。
//
// #413: setInitNeverResolves(true) を render() 前に呼ぶと、次に構築される MockRenderer の
// init() が永久 pending の Promise を返す（NP-6: renderer.init() 未解決でもインジケータ画像の
// 先読みが独立して発火することを検証するため）。既定は従来どおり即 resolve。
//
// #628 フェーズ2b race条件回帰テスト用: setInitDeferred(true) を render() 前に呼ぶと、
// 次に構築される MockRenderer の init() が「呼び出し側が任意タイミングで resolve できる」
// Promise を返す（setInitNeverResolves の「永久に解決しない」とは異なり、明示的に
// resolvePendingInit() を呼ぶまで pending のまま）。titleScreen 表示 effect が
// rendererReady（=init().then() 解決後）を待ってから showTitleScreen() を呼ぶ設計
// （バグ#2 race条件の回帰）を検証するために、init() の解決タイミングを精密に制御する。
const {
  rendererInstances,
  MockRenderer,
  setInitNeverResolves,
  setInitDeferred,
  resolvePendingInit,
} = vi.hoisted(() => {
  const instances: MockRenderer[] = []
  let initNeverResolves = false
  let initDeferred = false
  let pendingInitResolvers: Array<() => void> = []
  class MockRenderer {
    init = vi.fn(() => {
      if (initNeverResolves) return new Promise<void>(() => {})
      if (initDeferred) {
        return new Promise<void>((resolve) => {
          pendingInitResolvers.push(resolve)
        })
      }
      return Promise.resolve(undefined)
    })
    destroy = vi.fn()
    setAssetBaseUrl = vi.fn()
    setOnAutoModeChange = vi.fn()
    setOnSkipModeChange = vi.fn()
    setOnSeekActiveChange = vi.fn()
    setOnStoryEndedChange = vi.fn()
    setConfinedSceneIds = vi.fn()
    // #467: letterbox/pillarbox の黒帯タップ用公開API。NovelPlayer 側の
    // handleOutsideCanvasPointerDown が rendererRef.current?.handleOutsideCanvasTap() を叩く配線を
    // スパイで検証するために必要（実処理は NovelRenderer.outsideCanvasTap.test.ts が担保）。
    handleOutsideCanvasTap = vi.fn()
    // #460 再発修正: マルチMD構成での restoreSnapshot 遅延解決の前提（setMissingSceneResolver が
    // restoreSnapshot より前に呼ばれていること）を検証するために必要（P11）。
    setMissingSceneResolver = vi.fn()
    setDocKey = vi.fn()
    // #578: シーン切り替えごとの自動クイックセーブ配線・起動時の自動クイックロード判定用。
    setOnSceneChange = vi.fn()
    hasQuickSave = vi.fn().mockReturnValue(false)
    setChoiceStyle = vi.fn()
    setFontFamily = vi.fn()
    setFontSize = vi.fn()
    setDialogStyle = vi.fn()
    setProtagonist = vi.fn()
    setSpeakerNudge = vi.fn()
    setSplitLayout = vi.fn()
    setFullscreenImageMode = vi.fn()
    setSentencePerPage = vi.fn()
    setPixelArt = vi.fn()
    setCharacterYRatio = vi.fn()
    setCharacterHeightRatio = vi.fn()
    setCharacterHeightRatios = vi.fn()
    setCharacterScale = vi.fn()
    setCharacterFadeMs = vi.fn()
    setBackgroundFadeMs = vi.fn()
    setEventImageFadeMs = vi.fn()
    setEventImageTransitionDefault = vi.fn()
    setDefaultBackgroundColor = vi.fn()
    setSeekBarColor = vi.fn()
    setIntermissionScene = vi.fn()
    hasIntermissionScene = vi.fn().mockReturnValue(false)
    // #628 フェーズ2b: タイトル画面 (PixiJS 版 TitleScreenOverlay) の表示/非表示。
    showTitleScreen = vi.fn()
    hideTitleScreen = vi.fn()
    // #446: 実表示サイズに応じたレンダラ解像度追従。init().then() 内で無条件に1回呼ばれる
    // ため常に必要（isExporting は既定 false＝書き出し中でない扱いで自動追従を通す）。
    setRenderResolution = vi.fn()
    isExporting = vi.fn().mockReturnValue(false)
    applySettings = vi.fn()
    setScenes = vi.fn()
    setEvents = vi.fn()
    setJumpSceneIndex = vi.fn()
    setAutoMode = vi.fn()
    setSkipMode = vi.fn()
    startFrom = vi.fn()
    // #460: fluid 再マウント cleanup が destroy() 直前に必ず呼ぶ。既定は sceneId: null
    // （setEvents/setScenes 未実行の「意味のないスナップショット」相当）を返し、NovelPlayer 側の
    // 「sceneId が null なら保持しない」ガードにより従来どおり initialSceneId ベースの起動になる
    // （= 既存テストの期待値を変えない）。位置復元そのものを検証するテストは個別に上書きする。
    getSnapshot = vi.fn().mockReturnValue({
      sceneId: null,
      eventIndex: 0,
      textIndex: 0,
      sentenceIndex: 0,
      flags: {},
      backgroundPath: null,
      backgroundColor: null,
      backgroundFade: null,
      backgroundBrightness: null,
      video: null,
      eventImage: null,
      isBlackout: false,
      characters: [],
      currentBgmPath: null,
      storyEnded: false,
    })
    restoreSnapshot = vi.fn()
    playScript = vi.fn().mockResolvedValue(undefined)
    quickSave = vi.fn().mockReturnValue(false)
    quickLoad = vi.fn().mockReturnValue(false)
    // #630: F5/F8 のクイックセーブ/ロード通知 toast は PixiJS 側 (NovelRenderer.showToast) に
    // 内部化された。NovelPlayer はこのメソッドを呼ぶだけなので、DOM 側では呼び出し配線のみを
    // 検証する（表示自体は NovelRenderer.toast.test.ts が担保）。
    showToast = vi.fn()
    // #620: quickLoad() が false（同期的失敗）を返した際のフォールバック。未定義のままだと
    // NovelPlayer 側の呼び出しが TypeError で Unhandled Rejection になり、テストが握りつぶした
    // まま「緑」に見えてしまう（実際に発生していた不備）。
    resumeAutoAdvanceIfPending = vi.fn()
    getDebugState = vi.fn().mockReturnValue({
      eventIndex: 0,
      eventCount: 1,
      eventKind: 'Narration',
      autoMode: true,
      waitingForChoice: false,
      waitingForWait: false,
      currentResolvedFontFamily: null,
      sceneId: 's1',
      audioWarning: null,
      characters: [],
    })

    constructor() {
      instances.push(this)
    }
  }
  return {
    rendererInstances: instances,
    MockRenderer,
    setInitNeverResolves: (v: boolean) => {
      initNeverResolves = v
    },
    setInitDeferred: (v: boolean) => {
      initDeferred = v
      if (!v) pendingInitResolvers = []
    },
    resolvePendingInit: () => {
      const resolvers = pendingInitResolvers
      pendingInitResolvers = []
      resolvers.forEach((resolve) => resolve())
    },
  }
})
type MockRenderer = InstanceType<typeof MockRenderer>

vi.mock('../game/NovelRenderer', () => ({
  NovelRenderer: MockRenderer,
}))

// SettingsOverlay も SettingsOverlay 内の依存を避けるため軽量スタブにする
//（NovelPlayer の操作ボタンの検証に SettingsOverlay の実装は不要）。
vi.mock('./SettingsOverlay', () => ({
  default: () => null,
}))

// #395: iframe 埋め込み検知 isEmbedded() を stub する。本体ロジック（window.self!==window.top・
// null ガード）は isEmbedded.test.ts が別途固定するので、ここでは true/false を切り替えて
// 「埋め込み時だけ完読を親へ postMessage する」ゲートを分岐させる（PlayerScreen.test.tsx と同じ流儀）。
// 既定は下の beforeEach で false（standalone）に固定し、埋め込みテストだけ true に上書きする。
const { isEmbeddedMock } = vi.hoisted(() => ({ isEmbeddedMock: vi.fn() }))
vi.mock('../utils/isEmbedded', () => ({
  isEmbedded: isEmbeddedMock,
}))

// #442 self-review should-4: fluid（aspect_ratio: auto）モードの中核契約
// （ResizeObserver が向きカテゴリ変化を検知したら renderer を再マウントする）をコンポーネント
// レベルで検証するための簡易グローバル Mock。jsdom には ResizeObserver が実装されていないため、
// observe/disconnect を持つスタブクラスを用意し、テストコード側から contentRect を指定して
// コールバックを手動発火できるようにする（NovelPlayer 本体は「向き」の判定にしか contentRect の
// width/height を使わないため、モックの entry 形は最小限でよい）。
//
// #446: NovelPlayer は fluidRootRef 用（本コメント上の #442 契約）と containerRef 用
// （実表示サイズ追従・#446）の2つの独立した ResizeObserver を持つようになった。
// `window.ResizeObserver` を差し替えるこの describe 内ではどちらも本 Mock 経由で構築される
// ため、コールバックを単一の `lastCallback` に保持すると後から構築された方が先勝ちを
// 上書きしてしまう。登録された全コールバックの配列で保持し、`triggerResize` は「観測対象の
// 要素がこのサイズになった」を全登録先へブロードキャストする（実ブラウザで同時に複数の
// ResizeObserver が別要素を監視していても、テストが模擬する「画面がリサイズされた」という
// 1つの事象は両方に伝わるのと同じ扱い）。
interface FakeResizeObserverEntry {
  contentRect: { width: number; height: number }
}
const { ResizeObserverMock, triggerResize, resetResizeObserverMock } = vi.hoisted(() => {
  let callbacks: Array<(entries: FakeResizeObserverEntry[]) => void> = []
  class ResizeObserverMock {
    private readonly callback: (entries: FakeResizeObserverEntry[]) => void
    constructor(callback: (entries: FakeResizeObserverEntry[]) => void) {
      this.callback = callback
      callbacks.push(callback)
    }
    observe = vi.fn()
    unobserve = vi.fn()
    disconnect = vi.fn(() => {
      callbacks = callbacks.filter((cb) => cb !== this.callback)
    })
  }
  return {
    ResizeObserverMock,
    triggerResize: (width: number, height: number) => {
      callbacks.forEach((cb) => cb([{ contentRect: { width, height } }]))
    },
    resetResizeObserverMock: () => {
      callbacks = []
    },
  }
})

import NovelPlayer from './NovelPlayer'

const LS_DEBUG_OPEN = 'nn.debugOverlay.open'

/**
 * init().then(...) は microtask なので、render 直後に flush する。
 * これでデバッグパネルの polling effect や renderer setter が走った状態に揃う。
 */
async function flushAsync() {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

const skipButton = () => screen.queryByRole('button', { name: /スキップモードを/ })
const debugButton = () => screen.queryByRole('button', { name: /デバッグ情報を/ })
const debugPanel = () => document.querySelector('[style*="position: fixed"]') // DebugOverlay の本体 div

beforeEach(() => {
  rendererInstances.length = 0
  localStorage.clear()
  vi.clearAllMocks()
  // #395: 既定は standalone（非埋め込み）。埋め込みテストだけ true に上書きする。
  isEmbeddedMock.mockReturnValue(false)
  // #413: 既定は即 resolve。NP-6 だけ render() 前に true へ上書きする。
  setInitNeverResolves(false)
  // #628: 既定は即 resolve。race条件回帰テスト（TC38-43）だけ render() 前に true へ上書きする。
  setInitDeferred(false)
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('NovelPlayer ボタン出し分け', () => {
  // --- DT1: Skip(S) ボタン ---
  it('DT1: skipEnabled 未指定なら Skip(S) ボタンを描画する（既定・後方互換）', async () => {
    render(<NovelPlayer events={[]} />)
    await flushAsync()
    expect(skipButton()).toBeInTheDocument()
  })

  it('DT1: skipEnabled={null} なら Skip(S) ボタンを描画する', async () => {
    render(<NovelPlayer events={[]} skipEnabled={null} />)
    await flushAsync()
    expect(skipButton()).toBeInTheDocument()
  })

  it('DT1: skipEnabled={true} なら Skip(S) ボタンを描画する', async () => {
    render(<NovelPlayer events={[]} skipEnabled={true} />)
    await flushAsync()
    expect(skipButton()).toBeInTheDocument()
  })

  it('DT1: skipEnabled={false} なら Skip(S) ボタンを描画しない', async () => {
    render(<NovelPlayer events={[]} skipEnabled={false} />)
    await flushAsync()
    expect(skipButton()).toBeNull()
  })

  // --- DT-A: オート再生の初期状態 (#436) ---
  const autoToggle = () => screen.queryByRole('button', { name: /オートモードを/ })

  it('DT-A: autoPlay 未指定なら起動時オート OFF（手送り・ラベルが「オンにする」）', async () => {
    render(<NovelPlayer events={[]} />)
    await flushAsync()
    expect(autoToggle()).toHaveAttribute('aria-label', 'オートモードをオンにする')
  })

  it('DT-A: autoPlay={false} なら起動時オート OFF', async () => {
    render(<NovelPlayer events={[]} autoPlay={false} />)
    await flushAsync()
    expect(autoToggle()).toHaveAttribute('aria-label', 'オートモードをオンにする')
  })

  it('DT-A: autoPlay={true} なら起動時オート ON（ラベルが「オフにする」）', async () => {
    render(<NovelPlayer events={[]} autoPlay={true} />)
    await flushAsync()
    expect(autoToggle()).toHaveAttribute('aria-label', 'オートモードをオフにする')
  })

  // --- DT2: Debug(D) ボタン + DebugOverlay の mount ---
  it('DT2: debugEnabled={true} なら Debug(D) ボタンを描画する', async () => {
    render(<NovelPlayer events={[]} debugEnabled={true} />)
    await flushAsync()
    expect(debugButton()).toBeInTheDocument()
  })

  it('DT2: debugEnabled={false} なら Debug(D) ボタンを描画せず、DebugOverlay パネルも mount しない', async () => {
    render(<NovelPlayer events={[]} debugEnabled={false} />)
    await flushAsync()
    expect(debugButton()).toBeNull()
    // パネル本体（position: fixed の DebugOverlay）が DOM に存在しないこと。
    expect(debugPanel()).toBeNull()
    // polling も始まっていないこと（getDebugState が一度も呼ばれない）。
    const r = rendererInstances[rendererInstances.length - 1]
    expect(r.getDebugState).not.toHaveBeenCalled()
  })

  it('DT2: debugEnabled={null} なら Debug(D) ボタンを描画しない（/play 既定＝本番非表示）', async () => {
    render(<NovelPlayer events={[]} debugEnabled={null} />)
    await flushAsync()
    expect(debugButton()).toBeNull()
    expect(debugPanel()).toBeNull()
  })

  it('DT2: debugEnabled 未指定なら Debug(D) ボタンを描画しない', async () => {
    render(<NovelPlayer events={[]} />)
    await flushAsync()
    expect(debugButton()).toBeNull()
    expect(debugPanel()).toBeNull()
  })
})

describe('NovelPlayer 右下スロット詰め（DT-SLOT）', () => {
  // ボタンの inline style.right を検証する。pixel の見た目は対象外（blink）。
  // 採番: 右端から settings(slot0=12px) → auto(slot1=56px) → skip → debug の順で 44px 間隔。
  const settingsBtn = () => screen.getByRole('button', { name: '設定を開く' })
  const autoBtn = () => screen.getByRole('button', { name: /オートモードを/ })

  it('全4ボタン表示時: ⚙=12 / A=56 / S=100 / D=144 px', async () => {
    render(<NovelPlayer events={[]} skipEnabled={true} debugEnabled={true} />)
    await flushAsync()
    expect(settingsBtn().style.right).toBe('12px')
    expect(autoBtn().style.right).toBe('56px')
    expect(skipButton()!.style.right).toBe('100px')
    expect(debugButton()!.style.right).toBe('144px')
  })

  it('S 非表示時: ⚙/A は 12/56 のまま（隙間が出ず D が 100 に詰める）', async () => {
    render(<NovelPlayer events={[]} skipEnabled={false} debugEnabled={true} />)
    await flushAsync()
    // ⚙/A の位置は S の有無に依存せず固定。
    expect(settingsBtn().style.right).toBe('12px')
    expect(autoBtn().style.right).toBe('56px')
    expect(skipButton()).toBeNull()
    // S が抜けた分を D が詰める（144px ではなく 100px に来る＝隙間なし）。
    expect(debugButton()!.style.right).toBe('100px')
  })

  it('D 非表示時: S が slot2=100px に来る（D の不在で隙間が出ない）', async () => {
    render(<NovelPlayer events={[]} skipEnabled={true} debugEnabled={false} />)
    await flushAsync()
    expect(settingsBtn().style.right).toBe('12px')
    expect(autoBtn().style.right).toBe('56px')
    expect(skipButton()!.style.right).toBe('100px')
    expect(debugButton()).toBeNull()
  })

  it('S/D 両方非表示時: ⚙=12 / A=56 のみ', async () => {
    render(<NovelPlayer events={[]} skipEnabled={false} debugEnabled={false} />)
    await flushAsync()
    expect(settingsBtn().style.right).toBe('12px')
    expect(autoBtn().style.right).toBe('56px')
    expect(skipButton()).toBeNull()
    expect(debugButton()).toBeNull()
  })
})

describe('NovelPlayer デバッグ HUD トグルと永続化（T1-T7）', () => {
  it('T1: 空 localStorage では既定で畳んだ状態（aria-pressed=false・パネル本体なし）', async () => {
    render(<NovelPlayer events={[]} debugEnabled={true} />)
    await flushAsync()
    const btn = debugButton()!
    expect(btn.getAttribute('aria-pressed')).toBe('false')
    expect(debugPanel()).toBeNull()
  })

  it('T2: D クリックで展開し localStorage に "1" を書く', async () => {
    render(<NovelPlayer events={[]} debugEnabled={true} />)
    await flushAsync()
    const btn = debugButton()!
    await act(async () => {
      btn.click()
    })
    expect(btn.getAttribute('aria-pressed')).toBe('true')
    expect(debugPanel()).not.toBeNull()
    expect(localStorage.getItem(LS_DEBUG_OPEN)).toBe('1')
  })

  it('T3: 再クリックで畳んで localStorage に "0" を書く', async () => {
    render(<NovelPlayer events={[]} debugEnabled={true} />)
    await flushAsync()
    const btn = debugButton()!
    await act(async () => {
      btn.click() // 開く
    })
    await act(async () => {
      btn.click() // 畳む
    })
    expect(btn.getAttribute('aria-pressed')).toBe('false')
    expect(debugPanel()).toBeNull()
    expect(localStorage.getItem(LS_DEBUG_OPEN)).toBe('0')
  })

  it('T4: 事前に "1" が入っていれば初期状態で開いて mount する', async () => {
    localStorage.setItem(LS_DEBUG_OPEN, '1')
    render(<NovelPlayer events={[]} debugEnabled={true} />)
    await flushAsync()
    expect(debugButton()!.getAttribute('aria-pressed')).toBe('true')
    expect(debugPanel()).not.toBeNull()
  })

  it('T5: 事前 "0" は閉じたまま（=== "1" 厳格）', async () => {
    localStorage.setItem(LS_DEBUG_OPEN, '0')
    render(<NovelPlayer events={[]} debugEnabled={true} />)
    await flushAsync()
    expect(debugButton()!.getAttribute('aria-pressed')).toBe('false')
    expect(debugPanel()).toBeNull()
  })

  it('T5: 事前 "abc"（true でも 1 でもない値）は閉じたまま（=== "1" 厳格）', async () => {
    localStorage.setItem(LS_DEBUG_OPEN, 'abc')
    render(<NovelPlayer events={[]} debugEnabled={true} />)
    await flushAsync()
    expect(debugButton()!.getAttribute('aria-pressed')).toBe('false')
    expect(debugPanel()).toBeNull()
  })

  it('T8: パネル内の × ボタンで閉じられる（全体化中に D が裏に回っても閉じられる #438）', async () => {
    localStorage.setItem(LS_DEBUG_OPEN, '1')
    render(<NovelPlayer events={[]} debugEnabled={true} />)
    await flushAsync()
    expect(debugPanel()).not.toBeNull()

    const closeBtn = screen.getByRole('button', { name: 'デバッグパネルを閉じる' })
    await act(async () => {
      closeBtn.click()
    })

    expect(debugPanel()).toBeNull()
    expect(debugButton()!.getAttribute('aria-pressed')).toBe('false')
    expect(localStorage.getItem(LS_DEBUG_OPEN)).toBe('0')
  })

  it('T6: localStorage.setItem が throw しても UI トグルは動き、例外を投げない・console.error も出さない', async () => {
    const setItemSpy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceeded / private mode')
    })
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    render(<NovelPlayer events={[]} debugEnabled={true} />)
    await flushAsync()
    const btn = debugButton()!

    // クリックで例外が伝播しないこと（writeDebugOpen が try/catch で握る）。
    expect(() => {
      act(() => {
        btn.click()
      })
    }).not.toThrow()

    // setItem は試みられた（＝書き込みパスを通った）が、UI は state で開いている。
    expect(setItemSpy).toHaveBeenCalled()
    expect(btn.getAttribute('aria-pressed')).toBe('true')
    expect(debugPanel()).not.toBeNull()
    // 永続化失敗を console.error で騒がない（best-effort・静かに握る）。
    expect(errSpy).not.toHaveBeenCalled()
  })

  it('T7: パネルを開いたときだけ polling（getDebugState）が始まる（fake timers）', async () => {
    vi.useFakeTimers()
    try {
      render(<NovelPlayer events={[]} debugEnabled={true} />)
      // init().then(...) は real Promise の microtask。fake timers でも microtask は
      // real な await で解決するため、Promise を数回 flush して setter 完了状態に揃える。
      await act(async () => {
        await Promise.resolve()
        await Promise.resolve()
        await Promise.resolve()
      })
      const r = rendererInstances[rendererInstances.length - 1]

      // 閉じている間: 200ms 経過しても polling は走らない。
      act(() => {
        vi.advanceTimersByTime(600)
      })
      expect(r.getDebugState).not.toHaveBeenCalled()

      // D を押して開く → polling 開始。
      const btn = debugButton()!
      act(() => {
        btn.click()
      })
      act(() => {
        vi.advanceTimersByTime(600) // 200ms 間隔で複数回呼ばれる
      })
      const callsWhileOpen = r.getDebugState.mock.calls.length
      expect(callsWhileOpen).toBeGreaterThan(0)

      // 再度押して畳む → polling 停止（以降は呼び出し回数が増えない）。
      act(() => {
        btn.click()
      })
      act(() => {
        vi.advanceTimersByTime(600)
      })
      expect(r.getDebugState.mock.calls.length).toBe(callsWhileOpen)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('NovelPlayer 下部ボタン行フェード退避（#350 E 群）', () => {
  // SeekBar の active 変化は renderer.setOnSeekActiveChange に渡したコールバックで届く。
  // それを捕捉して act() 内で叩き、ラッパ div の className / aria-hidden を縛る。
  // 実 opacity の computed style・pointer-events 実効は jsdom では観測できないので（blink 任せ）、
  // ここでは Tailwind クラスと aria-hidden（=DOM 上の値）だけを検証する。
  // active 時はラッパが aria-hidden=true になり通常の getByRole から外れる（=退避が効いている証拠）。
  // active/inactive 両状態で同じ要素を掴めるよう hidden:true で引く。
  const settingsBtn = () => screen.getByRole('button', { name: '設定を開く', hidden: true })
  // 設定ボタンの親 = フェード退避するラッパ div。
  const fadeWrapper = () => settingsBtn().parentElement as HTMLElement
  // init().then(...) で渡された onSeekActiveChange コールバックを捕捉する。
  const capturedSeekCb = (): ((active: boolean) => void) => {
    const r = rendererInstances[rendererInstances.length - 1]
    return r.setOnSeekActiveChange.mock.calls[0][0] as (active: boolean) => void
  }

  it('E-1: 既定（inactive）ではラッパが opacity-100・pointer-events-auto・aria-hidden=false・inert なし', async () => {
    render(<NovelPlayer events={[]} />)
    await flushAsync()
    const w = fadeWrapper()
    expect(w.className).toContain('opacity-100')
    expect(w.className).toContain('[&_button]:pointer-events-auto')
    expect(w.getAttribute('aria-hidden')).toBe('false')
    // a11y(#350): 通常時は子ボタンがフォーカス可能（inert を付けない）。
    expect(w.hasAttribute('inert')).toBe(false)
  })

  it('E-2: active（cb(true)）でラッパが opacity-0・pointer-events-none・aria-hidden=true・inert あり', async () => {
    render(<NovelPlayer events={[]} />)
    await flushAsync()
    act(() => capturedSeekCb()(true))
    const w = fadeWrapper()
    expect(w.className).toContain('opacity-0')
    expect(w.className).toContain('[&_button]:pointer-events-none')
    expect(w.getAttribute('aria-hidden')).toBe('true')
    // a11y(#350): active 時は inert でサブツリーをフォーカス不能＋a11y ツリー外にする。
    expect(w.hasAttribute('inert')).toBe(true)
  })

  it('E-3: active → inactive（cb(true)→cb(false)）で既定の見た目へ復帰し inert も外れる', async () => {
    render(<NovelPlayer events={[]} />)
    await flushAsync()
    act(() => capturedSeekCb()(true))
    act(() => capturedSeekCb()(false))
    const w = fadeWrapper()
    expect(w.className).toContain('opacity-100')
    expect(w.className).toContain('[&_button]:pointer-events-auto')
    expect(w.getAttribute('aria-hidden')).toBe('false')
    expect(w.hasAttribute('inert')).toBe(false)
  })

  it('E-4: init 後に renderer.setOnSeekActiveChange が 1 回登録される', async () => {
    render(<NovelPlayer events={[]} />)
    await flushAsync()
    const r = rendererInstances[rendererInstances.length - 1]
    expect(r.setOnSeekActiveChange).toHaveBeenCalledTimes(1)
    expect(r.setOnSeekActiveChange).toHaveBeenCalledWith(expect.any(Function))
  })

  it('E-5: active でも子ボタンの style.right は不変（ボタンは消えず位置も変わらない）', async () => {
    render(<NovelPlayer events={[]} skipEnabled={true} debugEnabled={true} />)
    await flushAsync()
    // フェードはラッパの opacity/pointer-events だけで、子ボタンのレイアウト（slot 採番）は不変。
    // active 時は aria-hidden で外れるので hidden:true で「依然存在し位置も同じ」ことを確かめる。
    act(() => capturedSeekCb()(true))
    expect(settingsBtn().style.right).toBe('12px')
    expect(screen.getByRole('button', { name: /オートモードを/, hidden: true }).style.right).toBe(
      '56px'
    )
    expect(screen.getByRole('button', { name: /スキップモードを/, hidden: true }).style.right).toBe(
      '100px'
    )
    expect(screen.getByRole('button', { name: /デバッグ情報を/, hidden: true }).style.right).toBe(
      '144px'
    )
  })
})

// --- #382: speakerNudge prop を renderer.setSpeakerNudge に転送する ---
//
// NovelPlayer は init 時（setEvents/setScenes より前）と、speakerNudge 変化時の useEffect の
// 双方で renderer.setSpeakerNudge(speakerNudge ?? null) を呼ぶ。frontmatter `speaker_nudge:` が
// PlayerScreen → NovelPlayer prop → renderer まで届く配線を、スタブ renderer の呼び出しで縛る。
// （renderer 内部の nudge 抑制ロジックそのものは NovelRenderer.novel.test.ts の D 群が担保する。）
describe('NovelPlayer speakerNudge の renderer 転送 (#382)', () => {
  const lastRenderer = () => rendererInstances[rendererInstances.length - 1]

  it('F1: speakerNudge={false} なら renderer.setSpeakerNudge が false で呼ばれる', async () => {
    render(<NovelPlayer events={[]} speakerNudge={false} />)
    await flushAsync()
    expect(lastRenderer().setSpeakerNudge).toHaveBeenCalledWith(false)
  })

  it('F2: speakerNudge 未指定なら renderer.setSpeakerNudge が null で呼ばれる（?? null・既定 false 相当）', async () => {
    render(<NovelPlayer events={[]} />)
    await flushAsync()
    expect(lastRenderer().setSpeakerNudge).toHaveBeenCalledWith(null)
  })

  it('F3: speakerNudge を false→true に変更すると setSpeakerNudge が true で再コールされる（useEffect 状態遷移）', async () => {
    const { rerender } = render(<NovelPlayer events={[]} speakerNudge={false} />)
    await flushAsync()
    const r = lastRenderer()
    expect(r.setSpeakerNudge).toHaveBeenCalledWith(false)

    // prop を true に変えると [speakerNudge] useEffect が再走して renderer に反映する。
    rerender(<NovelPlayer events={[]} speakerNudge={true} />)
    await flushAsync()
    expect(r.setSpeakerNudge).toHaveBeenCalledWith(true)
  })
})

// --- #386: `?scene=` ディープリンク（initialSceneId）+ confinement + 終劇表示 ---
//
// PlayerScreen が解決した initialSceneId / confinedSceneIds をそのまま renderer に配線する
// ことと、renderer.setOnStoryEndedChange 経由で届く終劇状態が "to be continued..." の
// DOM 表示に反映されることを検証する。DEV 限定の debug_scene（#220）との優先順位
// （initialSceneId → debug_scene の順に startFrom が呼ばれ、後勝ちで debug 側が効く）も含む。
describe('NovelPlayer `?scene=` ディープリンク + confinement 配線 (#386)', () => {
  const lastRenderer = () => rendererInstances[rendererInstances.length - 1]

  it('G1: initialSceneId を渡すと mount 時に renderer.startFrom({ sceneId }) が1回だけ呼ばれる', async () => {
    render(<NovelPlayer events={[]} initialSceneId="scene-x" />)
    await flushAsync()
    const r = lastRenderer()
    expect(r.startFrom).toHaveBeenCalledTimes(1)
    expect(r.startFrom).toHaveBeenCalledWith({ sceneId: 'scene-x' })
  })

  it('G2: initialSceneId 未指定なら startFrom は呼ばれない', async () => {
    render(<NovelPlayer events={[]} />)
    await flushAsync()
    expect(lastRenderer().startFrom).not.toHaveBeenCalled()
  })

  it('G3: initialSceneId={null} でも startFrom は呼ばれない', async () => {
    render(<NovelPlayer events={[]} initialSceneId={null} />)
    await flushAsync()
    expect(lastRenderer().startFrom).not.toHaveBeenCalled()
  })

  it('G4: confinedSceneIds を渡すと mount 時に renderer.setConfinedSceneIds がその配列で呼ばれる', async () => {
    render(<NovelPlayer events={[]} confinedSceneIds={['a', 'b']} />)
    await flushAsync()
    expect(lastRenderer().setConfinedSceneIds).toHaveBeenCalledWith(['a', 'b'])
  })

  it('G5: confinedSceneIds 未指定なら renderer.setConfinedSceneIds が null で呼ばれる（無制限＝後方互換）', async () => {
    render(<NovelPlayer events={[]} />)
    await flushAsync()
    expect(lastRenderer().setConfinedSceneIds).toHaveBeenCalledWith(null)
  })

  // G6-G9 (旧: "to be continued..." の DOM 表示が onStoryEndedChange(true/false) に追従することの
  // 検証) は #630 で削除した。表示自体が PixiJS 側 (NovelRenderer.syncEndingOverlayVisibility()) に
  // 内部化されたため、NovelPlayer 側にはもう検証対象の DOM が無い。表示ロジックの単体テストは
  // NovelRenderer.endingOverlay.test.ts が担保する。

  it('G10: DEV モードで `?scene=` 由来の initialSceneId と `?debug_scene=` が同時指定された場合、debug_scene 側の startFrom が後勝ちする', async () => {
    window.history.pushState({}, '', '?debug_scene=dbg-scene')
    try {
      render(<NovelPlayer events={[]} initialSceneId="prod-scene" />)
      await flushAsync()
      const r = lastRenderer()
      // initialSceneId(#386) が先に startFrom され、その後 DEV 限定の debug_scene(#220) が
      // 上書きする（NovelPlayer 側のコメント通り、デバッグ目的の上書きを優先させる設計）。
      expect(r.startFrom).toHaveBeenNthCalledWith(1, { sceneId: 'prod-scene' })
      expect(r.startFrom).toHaveBeenNthCalledWith(2, { sceneId: 'dbg-scene' })
      expect(r.startFrom).toHaveBeenCalledTimes(2)
    } finally {
      window.history.pushState({}, '', '/')
    }
  })
})

// --- #395: 終劇到達時に埋め込み親へ完読を postMessage で通知する ---
//
// renderer.setOnStoryEndedChange に渡したコールバックへ ended=true が立ち上がった瞬間、
// **iframe 埋め込み時のみ** window.parent.postMessage で親（theo-hayami）へ完読を通知する。
// isEmbedded() は上部で vi.mock 済み（本体ロジックは isEmbedded.test.ts が固定）。ここでは
// true/false を切り替えてゲート（`ended && isEmbedded()`）を分岐させ、postMessage 発火を spy で観測する。
// メッセージ本体の形状は buildStoryEndedMessage の純粋テスト（storyEndedMessage.test.ts）が固定するので、
// ここは「埋め込み×ended 立ち上がりのときだけ・正しい引数と origin で 1 回送る」配線と否定側を縛る。
//
// 非適用: メッセージ 4 フィールドの契約リグレッション（storyEndedMessage.test.ts が担保）/
//   isEmbedded 本体の判定ロジック（isEmbedded.test.ts が担保）/ "to be continued..." 表示（G6-G9 が担保）。
describe('NovelPlayer 終劇→埋め込み親へ postMessage 通知 (#395)', () => {
  // init().then(...) で renderer.setOnStoryEndedChange に渡された終劇コールバックを捕捉する。
  const capturedStoryEndedCb = (): ((ended: boolean) => void) => {
    const r = rendererInstances[rendererInstances.length - 1]
    return r.setOnStoryEndedChange.mock.calls[0][0] as (ended: boolean) => void
  }
  // jsdom では window.parent === window。実 postMessage は不要なので no-op 化して spy だけ取る。
  const spyPostMessage = () => vi.spyOn(window.parent, 'postMessage').mockImplementation(() => {})

  it('H1: 埋め込み時に cb(true) で postMessage が 1 回・契約 4 フィールド + "*" で発火する', async () => {
    isEmbeddedMock.mockReturnValue(true)
    const post = spyPostMessage()
    render(<NovelPlayer events={[]} initialSceneId="aristo-ai" docKey="theo-hayami" />)
    await flushAsync()
    act(() => capturedStoryEndedCb()(true))
    expect(post).toHaveBeenCalledTimes(1)
    expect(post).toHaveBeenCalledWith(
      { source: 'name-name', type: 'story-ended', scene: 'aristo-ai', project: 'theo-hayami' },
      '*'
    )
  })

  it('H2: 埋め込みでも cb(false)（終劇解除＝復元/巻き戻し）では postMessage を送らない', async () => {
    isEmbeddedMock.mockReturnValue(true)
    const post = spyPostMessage()
    render(<NovelPlayer events={[]} initialSceneId="aristo-ai" docKey="theo-hayami" />)
    await flushAsync()
    act(() => capturedStoryEndedCb()(false))
    expect(post).not.toHaveBeenCalled()
  })

  it('H3: standalone（非埋め込み）では cb(true) でも postMessage を送らない', async () => {
    isEmbeddedMock.mockReturnValue(false)
    const post = spyPostMessage()
    render(<NovelPlayer events={[]} initialSceneId="aristo-ai" docKey="theo-hayami" />)
    await flushAsync()
    act(() => capturedStoryEndedCb()(true))
    expect(post).not.toHaveBeenCalled()
  })

  it('H4: initialSceneId 未指定なら scene:null で送る（埋め込み・cb(true)）', async () => {
    isEmbeddedMock.mockReturnValue(true)
    const post = spyPostMessage()
    render(<NovelPlayer events={[]} docKey="theo-hayami" />)
    await flushAsync()
    act(() => capturedStoryEndedCb()(true))
    expect(post).toHaveBeenCalledTimes(1)
    expect(post).toHaveBeenCalledWith(
      { source: 'name-name', type: 'story-ended', scene: null, project: 'theo-hayami' },
      '*'
    )
  })

  it('H5: docKey 未指定なら project:"" で送る（送信自体は行う・埋め込み・cb(true)）', async () => {
    isEmbeddedMock.mockReturnValue(true)
    const post = spyPostMessage()
    render(<NovelPlayer events={[]} initialSceneId="aristo-ai" />)
    await flushAsync()
    act(() => capturedStoryEndedCb()(true))
    expect(post).toHaveBeenCalledTimes(1)
    expect(post).toHaveBeenCalledWith(
      { source: 'name-name', type: 'story-ended', scene: 'aristo-ai', project: '' },
      '*'
    )
  })

  it('H6: 送信先 origin は "*"（埋め込み側を name-name は知らない）', async () => {
    isEmbeddedMock.mockReturnValue(true)
    const post = spyPostMessage()
    render(<NovelPlayer events={[]} initialSceneId="aristo-ai" docKey="theo-hayami" />)
    await flushAsync()
    act(() => capturedStoryEndedCb()(true))
    expect(post.mock.calls[0][1]).toBe('*')
  })
})

// #404: 終劇表示中の埋め込み元プロジェクトロゴ（assetBaseUrl 配線・pixelArt 反映・onError
// フォールバック）は #630 で PixiJS 側 (NovelRenderer.showEndingOverlay() /
// CharacterLayer.showImage()) に内部化された。DOM 側の `<img>` はもう存在しないため、旧
// L1-L8（NovelPlayer 側の DOM 検証）は削除した。ロゴ表示の単体テストは
// NovelRenderer.endingOverlay.test.ts が担保する。

// #404 フェーズ2: intermission.md 専用シーンの renderer 配線。
//
// usedIntermissionScene は「storyEnded が true に立ち上がった瞬間の renderer.hasIntermissionScene()」
// を1回だけスナップショットし、以後 intermissionEvents prop が変化してもライブ再評価しない設計
// （早すぎる fetch で intermission がまだ届いていない場合、後から届いても DOM フォールバック表示が
// 消えない＝「同時に消えるだけの空白画面」を避けるための意図的な仕様。session ノート参照）。
describe('NovelPlayer intermission.md 専用シーン配線 (#404 フェーズ2)', () => {
  const lastRenderer = () => rendererInstances[rendererInstances.length - 1]
  const EV1 = [{ Narration: { text: ['つづく'] } }]

  it('NP-IM-1: マウント時に renderer.setIntermissionScene が intermissionEvents prop の初期値で呼ばれる', async () => {
    render(
      <NovelPlayer
        events={[]}
        intermissionEvents={EV1}
        intermissionBackgroundFadeMs={900}
        intermissionCharacterFadeMs={800}
        intermissionEventImageFadeMs={700}
      />
    )
    await flushAsync()
    expect(lastRenderer().setIntermissionScene).toHaveBeenCalledWith(EV1, {
      backgroundFadeMs: 900,
      characterFadeMs: 800,
      eventImageFadeMs: 700,
    })
  })

  it('NP-IM-2: intermissionEvents prop を後から変更して rerender すると、専用 effect が renderer.setIntermissionScene を再度呼ぶ', async () => {
    const { rerender } = render(<NovelPlayer events={[]} intermissionEvents={null} />)
    await flushAsync()
    const r = lastRenderer()
    r.setIntermissionScene.mockClear()

    rerender(<NovelPlayer events={[]} intermissionEvents={EV1} />)
    await flushAsync()

    expect(r.setIntermissionScene).toHaveBeenCalledWith(EV1, {
      backgroundFadeMs: null,
      characterFadeMs: null,
      eventImageFadeMs: null,
    })
  })

  // 旧 NP-IM-3〜6 (intermission が使われた場合に "to be continued..." の DOM 表示が二重表示防止で
  // 消えること・race 条件でのスナップショット固定) は #630 で削除した。この判定
  // (`storyEnded && !hasIntermissionScene()`) は NovelRenderer.syncEndingOverlayVisibility() に
  // 内部化され、同じ「値が変化する瞬間にスナップショットする」設計で NovelRenderer.
  // endingOverlay.test.ts が race 条件を含めて担保する。
})

// #409: doc.background_color → renderer.setDefaultBackgroundColor 配線。
// setBackgroundFadeMs（#407）と対称の per-game 設定で、init（初回背景表示より前）で流す。
// null/undefined は `?? null` で「既定の黒」に倒す（後方互換）。
describe('NovelPlayer 下地ベタの既定色 background_color 配線 (#409)', () => {
  it('backgroundColor を渡すと init 時に renderer.setDefaultBackgroundColor(値) が呼ばれる', async () => {
    render(<NovelPlayer events={[]} backgroundColor="#112233" />)
    await flushAsync()
    const r = rendererInstances[rendererInstances.length - 1]
    expect(r.setDefaultBackgroundColor).toHaveBeenCalledWith('#112233')
  })

  it('backgroundColor 未指定なら null で呼ぶ（既定の黒＝後方互換）', async () => {
    render(<NovelPlayer events={[]} />)
    await flushAsync()
    const r = rendererInstances[rendererInstances.length - 1]
    expect(r.setDefaultBackgroundColor).toHaveBeenCalledWith(null)
  })

  it('backgroundColor={null} でも null で呼ぶ（明示 null＝黒）', async () => {
    render(<NovelPlayer events={[]} backgroundColor={null} />)
    await flushAsync()
    const r = rendererInstances[rendererInstances.length - 1]
    expect(r.setDefaultBackgroundColor).toHaveBeenCalledWith(null)
  })
})

// #440: doc.seekbar_color → renderer.setSeekBarColor 配線。
// setDefaultBackgroundColor（#409）と対称の per-game 設定で、init で流す。
// null/undefined は `?? null` で「既定の水色」に倒す（後方互換）。
describe('NovelPlayer SeekBar 色 seekbar_color 配線 (#440)', () => {
  it('seekbarColor を渡すと init 時に renderer.setSeekBarColor(値) が呼ばれる', async () => {
    render(<NovelPlayer events={[]} seekbarColor="#b8934f" />)
    await flushAsync()
    const r = rendererInstances[rendererInstances.length - 1]
    expect(r.setSeekBarColor).toHaveBeenCalledWith('#b8934f')
  })

  it('seekbarColor 未指定なら null で呼ぶ（既定の水色＝後方互換）', async () => {
    render(<NovelPlayer events={[]} />)
    await flushAsync()
    const r = rendererInstances[rendererInstances.length - 1]
    expect(r.setSeekBarColor).toHaveBeenCalledWith(null)
  })

  it('seekbarColor={null} でも null で呼ぶ（明示 null＝既定色）', async () => {
    render(<NovelPlayer events={[]} seekbarColor={null} />)
    await flushAsync()
    const r = rendererInstances[rendererInstances.length - 1]
    expect(r.setSeekBarColor).toHaveBeenCalledWith(null)
  })
})

// #605: 操作ボタン（A/S/D）の ON 時背景色を seekbar_color に連動させる配線。
// 色決定ロジック自体（境界値等）は resolveActionButtonColor 単体で novelLayout.test.ts が縛るので、
// ここでは「NovelPlayer が resolveActionButtonColor の結果を各ボタンの style CSS 変数
// （--nn-action-btn-color）へ正しく配線しているか」「ON/OFF の表示条件ロジック（className の
// 出し分け）と色ロジックが分離され、互いに副作用を及ぼさないか」を検証する。
describe('NovelPlayer 操作ボタン(A/S/D) ON色 seekbar_color 連動 (#605)', () => {
  // 実装の定数から導出（ハードコード重複禁止 #605 セルフレビュー指摘）。fallback 値が変われば
  // このテストの期待値も自動で追従する。
  const AUTO_FALLBACK_HEX = numberToHexColor(AUTO_BUTTON_FALLBACK_COLOR)
  const SKIP_FALLBACK_HEX = numberToHexColor(SKIP_BUTTON_FALLBACK_COLOR)
  const DEBUG_FALLBACK_HEX = numberToHexColor(DEBUG_BUTTON_FALLBACK_COLOR)
  const autoBtn = () => screen.getByRole('button', { name: /オートモードを/ })
  const actionColorOf = (btn: HTMLElement) => btn.style.getPropertyValue('--nn-action-btn-color')

  it('TC-NP-1: seekbarColor 未指定なら auto/skip/debug 各ボタンがそれぞれの fallback 色になり、3値は互いに異なる（取り違え検出）', async () => {
    render(<NovelPlayer events={[]} debugEnabled={true} />)
    await flushAsync()
    const auto = actionColorOf(autoBtn())
    const skip = actionColorOf(skipButton()!)
    const debug = actionColorOf(debugButton()!)
    expect(auto).toBe(AUTO_FALLBACK_HEX)
    expect(skip).toBe(SKIP_FALLBACK_HEX)
    expect(debug).toBe(DEBUG_FALLBACK_HEX)
    expect(new Set([auto, skip, debug]).size).toBe(3)
  })

  it('TC-NP-2: seekbarColor="#b8934f" なら auto/skip/debug の3ボタンとも同一の色に統一される', async () => {
    render(<NovelPlayer events={[]} debugEnabled={true} seekbarColor="#b8934f" />)
    await flushAsync()
    expect(actionColorOf(autoBtn())).toBe('#b8934f')
    expect(actionColorOf(skipButton()!)).toBe('#b8934f')
    expect(actionColorOf(debugButton()!)).toBe('#b8934f')
  })

  it('TC-NP-3: seekbarColor={null} なら各ボタン個別の fallback に戻る', async () => {
    render(<NovelPlayer events={[]} debugEnabled={true} seekbarColor={null} />)
    await flushAsync()
    expect(actionColorOf(autoBtn())).toBe(AUTO_FALLBACK_HEX)
    expect(actionColorOf(skipButton()!)).toBe(SKIP_FALLBACK_HEX)
    expect(actionColorOf(debugButton()!)).toBe(DEBUG_FALLBACK_HEX)
  })

  it('TC-NP-4: seekbarColor="" なら各ボタン個別の fallback に戻る', async () => {
    render(<NovelPlayer events={[]} debugEnabled={true} seekbarColor="" />)
    await flushAsync()
    expect(actionColorOf(autoBtn())).toBe(AUTO_FALLBACK_HEX)
    expect(actionColorOf(skipButton()!)).toBe(SKIP_FALLBACK_HEX)
    expect(actionColorOf(debugButton()!)).toBe(DEBUG_FALLBACK_HEX)
  })

  it('TC-NP-5: seekbarColor="not-a-color" なら各ボタン個別の fallback に戻り、console.error/warn は呼ばれない', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    render(<NovelPlayer events={[]} debugEnabled={true} seekbarColor="not-a-color" />)
    await flushAsync()
    expect(actionColorOf(autoBtn())).toBe(AUTO_FALLBACK_HEX)
    expect(actionColorOf(skipButton()!)).toBe(SKIP_FALLBACK_HEX)
    expect(actionColorOf(debugButton()!)).toBe(DEBUG_FALLBACK_HEX)
    expect(errSpy).not.toHaveBeenCalled()
    expect(warnSpy).not.toHaveBeenCalled()
  })

  it('TC-NP-6: auto/skip/debug いずれも OFF 時は className に bg-[var(--nn-action-btn-color)] を含まず bg-black/50 のままだが、style の --nn-action-btn-color 自体は OFF 時も設定されている', async () => {
    render(<NovelPlayer events={[]} debugEnabled={true} docKey="doc-x" />)
    await flushAsync()
    for (const btn of [autoBtn(), skipButton()!, debugButton()!]) {
      expect(btn.className).not.toContain('bg-[var(--nn-action-btn-color)]')
      expect(btn.className).toContain('bg-black/50')
      expect(actionColorOf(btn)).not.toBe('')
    }
  })

  it('TC-NP-7: auto/skip/debug いずれも ON 時は className に bg-[var(--nn-action-btn-color)]/80 と hover:bg-[var(--nn-action-btn-color)] を含む', async () => {
    render(<NovelPlayer events={[]} debugEnabled={true} docKey="doc-x" autoPlay={true} />)
    await flushAsync()
    // auto は autoPlay={true} で起動時から ON。
    expect(autoBtn().className).toContain('bg-[var(--nn-action-btn-color)]/80')
    expect(autoBtn().className).toContain('hover:bg-[var(--nn-action-btn-color)]')

    // skip / debug はクリックで ON にする。
    await act(async () => {
      skipButton()!.click()
    })
    expect(skipButton()!.className).toContain('bg-[var(--nn-action-btn-color)]/80')
    expect(skipButton()!.className).toContain('hover:bg-[var(--nn-action-btn-color)]')

    await act(async () => {
      debugButton()!.click()
    })
    expect(debugButton()!.className).toContain('bg-[var(--nn-action-btn-color)]/80')
    expect(debugButton()!.className).toContain('hover:bg-[var(--nn-action-btn-color)]')
  })

  it('TC-NP-8: rerender で seekbarColor が undefined → "#1a4a7a" → null と変化すると、都度 --nn-action-btn-color が追従する', async () => {
    const { rerender } = render(<NovelPlayer events={[]} debugEnabled={true} />)
    await flushAsync()
    expect(actionColorOf(autoBtn())).toBe(AUTO_FALLBACK_HEX)

    rerender(<NovelPlayer events={[]} debugEnabled={true} seekbarColor="#1a4a7a" />)
    await flushAsync()
    expect(actionColorOf(autoBtn())).toBe('#1a4a7a')
    expect(actionColorOf(skipButton()!)).toBe('#1a4a7a')
    expect(actionColorOf(debugButton()!)).toBe('#1a4a7a')

    rerender(<NovelPlayer events={[]} debugEnabled={true} seekbarColor={null} />)
    await flushAsync()
    expect(actionColorOf(autoBtn())).toBe(AUTO_FALLBACK_HEX)
    expect(actionColorOf(skipButton()!)).toBe(SKIP_FALLBACK_HEX)
    expect(actionColorOf(debugButton()!)).toBe(DEBUG_FALLBACK_HEX)
  })

  it('TC-NP-9: seekbarColor が変化しても autoMode/skipMode/debugOpen の ON/OFF 状態（aria-label 等）は影響を受けない（色ロジックと表示条件ロジックの分離）', async () => {
    const { rerender } = render(
      <NovelPlayer events={[]} debugEnabled={true} docKey="doc-x" autoPlay={true} />
    )
    await flushAsync()
    await act(async () => {
      skipButton()!.click()
    })
    await act(async () => {
      debugButton()!.click()
    })
    expect(autoBtn()).toHaveAttribute('aria-label', 'オートモードをオフにする')
    expect(skipButton()!).toHaveAttribute('aria-label', 'スキップモードをオフにする')
    expect(debugButton()!).toHaveAttribute('aria-pressed', 'true')

    rerender(
      <NovelPlayer
        events={[]}
        debugEnabled={true}
        docKey="doc-x"
        autoPlay={true}
        seekbarColor="#1a4a7a"
      />
    )
    await flushAsync()
    expect(autoBtn()).toHaveAttribute('aria-label', 'オートモードをオフにする')
    expect(skipButton()!).toHaveAttribute('aria-label', 'スキップモードをオフにする')
    expect(debugButton()!).toHaveAttribute('aria-pressed', 'true')
  })
})

// #599: doc.event_image_transition → renderer.setEventImageTransitionDefault 配線。
// setSeekBarColor（#440）/setDefaultBackgroundColor（#409）と対称の per-game 設定で、
// init（初回イベント絵表示より前）と eventImageTransitionDefault 変化時の専用 useEffect の
// 双方で呼ばれる。null/undefined は `?? null` で「renderer 側の既定 'Fade' 相当」に倒す（後方互換）。
describe('NovelPlayer イベント絵遷移デフォルト event_image_transition 配線 (#599)', () => {
  const lastRenderer = () => rendererInstances[rendererInstances.length - 1]

  it('eventImageTransitionDefault="Pixelate" を渡すと init 時に renderer.setEventImageTransitionDefault が呼ばれる', async () => {
    render(<NovelPlayer events={[]} eventImageTransitionDefault="Pixelate" />)
    await flushAsync()
    expect(lastRenderer().setEventImageTransitionDefault).toHaveBeenCalledWith('Pixelate')
  })

  it('eventImageTransitionDefault 未指定なら null で呼ぶ（既定 Fade＝後方互換）', async () => {
    render(<NovelPlayer events={[]} />)
    await flushAsync()
    expect(lastRenderer().setEventImageTransitionDefault).toHaveBeenCalledWith(null)
  })

  it('eventImageTransitionDefault={null} でも null で呼ぶ（明示 null＝既定 Fade）', async () => {
    render(<NovelPlayer events={[]} eventImageTransitionDefault={null} />)
    await flushAsync()
    expect(lastRenderer().setEventImageTransitionDefault).toHaveBeenCalledWith(null)
  })

  it('eventImageTransitionDefault を "Fade"→"Pixelate" に変更すると setEventImageTransitionDefault が再コールされる（useEffect 状態遷移）', async () => {
    const { rerender } = render(<NovelPlayer events={[]} eventImageTransitionDefault="Fade" />)
    await flushAsync()
    const r = lastRenderer()
    expect(r.setEventImageTransitionDefault).toHaveBeenCalledWith('Fade')

    rerender(<NovelPlayer events={[]} eventImageTransitionDefault="Pixelate" />)
    await flushAsync()
    expect(r.setEventImageTransitionDefault).toHaveBeenCalledWith('Pixelate')
  })
})

// --- #442: splitLayout prop を renderer.setSplitLayout に転送する ---
//
// NovelPlayer は init 時（setEvents/setScenes より前）と、splitLayout 変化時の専用 useEffect の
// 双方で renderer.setSplitLayout(splitLayout ?? null) を呼ぶ。frontmatter `split_layout:` が
// PlayerScreen/EditorScreen → NovelPlayer prop → renderer まで届く配線を、スタブ renderer の
// 呼び出しで縛る（speakerNudge #382 と対称の配線パターン）。
describe('NovelPlayer splitLayout の renderer 転送 (#442)', () => {
  const lastRenderer = () => rendererInstances[rendererInstances.length - 1]

  it('I1: splitLayout={true} なら renderer.setSplitLayout が true で呼ばれる', async () => {
    render(<NovelPlayer events={[]} splitLayout={true} />)
    await flushAsync()
    expect(lastRenderer().setSplitLayout).toHaveBeenCalledWith(true)
  })

  it('I2: splitLayout 未指定なら renderer.setSplitLayout が null で呼ばれる（?? null・既定 false 相当）', async () => {
    render(<NovelPlayer events={[]} />)
    await flushAsync()
    expect(lastRenderer().setSplitLayout).toHaveBeenCalledWith(null)
  })

  it('I3: splitLayout={null} でも null で呼ばれる（明示 null＝既定の全面+オーバーレイ）', async () => {
    render(<NovelPlayer events={[]} splitLayout={null} />)
    await flushAsync()
    expect(lastRenderer().setSplitLayout).toHaveBeenCalledWith(null)
  })

  it('I4: splitLayout を false→true に変更すると setSplitLayout が true で再コールされる（専用 useEffect の状態遷移）', async () => {
    const { rerender } = render(<NovelPlayer events={[]} splitLayout={false} />)
    await flushAsync()
    const r = lastRenderer()
    expect(r.setSplitLayout).toHaveBeenCalledWith(false)

    rerender(<NovelPlayer events={[]} splitLayout={true} />)
    await flushAsync()
    expect(r.setSplitLayout).toHaveBeenCalledWith(true)
  })
})

// --- #448: sentencePerPage prop を renderer.setSentencePerPage に転送する ---
//
// NovelPlayer は init 時（setEvents/setScenes より前）と、sentencePerPage 変化時の専用 useEffect の
// 双方で renderer.setSentencePerPage(sentencePerPage ?? null) を呼ぶ。frontmatter `sentence_per_page:`
// が PlayerScreen/EditorScreen → NovelPlayer prop → renderer まで届く配線を、スタブ renderer の
// 呼び出しで縛る（splitLayout #442 と対称の配線パターン）。
describe('NovelPlayer sentencePerPage の renderer 転送 (#448)', () => {
  const lastRenderer = () => rendererInstances[rendererInstances.length - 1]

  it('sentencePerPage={true} なら renderer.setSentencePerPage が true で呼ばれる', async () => {
    render(<NovelPlayer events={[]} sentencePerPage={true} />)
    await flushAsync()
    expect(lastRenderer().setSentencePerPage).toHaveBeenCalledWith(true)
  })

  it('sentencePerPage 未指定なら renderer.setSentencePerPage が null で呼ばれる（?? null・既定 false 相当）', async () => {
    render(<NovelPlayer events={[]} />)
    await flushAsync()
    expect(lastRenderer().setSentencePerPage).toHaveBeenCalledWith(null)
  })

  it('sentencePerPage={null} でも null で呼ばれる（明示 null＝既定の従来ページングのまま）', async () => {
    render(<NovelPlayer events={[]} sentencePerPage={null} />)
    await flushAsync()
    expect(lastRenderer().setSentencePerPage).toHaveBeenCalledWith(null)
  })

  it('sentencePerPage を false→true に変更すると setSentencePerPage が true で再コールされる（専用 useEffect の状態遷移）', async () => {
    const { rerender } = render(<NovelPlayer events={[]} sentencePerPage={false} />)
    await flushAsync()
    const r = lastRenderer()
    expect(r.setSentencePerPage).toHaveBeenCalledWith(false)

    rerender(<NovelPlayer events={[]} sentencePerPage={true} />)
    await flushAsync()
    expect(r.setSentencePerPage).toHaveBeenCalledWith(true)
  })
})

// --- #466: pixelArt prop を renderer.setPixelArt に転送する ---
//
// NovelPlayer は init 時（setEvents/setScenes より前）と、pixelArt 変化時の専用 useEffect の
// 双方で renderer.setPixelArt(pixelArt ?? null) を呼ぶ。frontmatter `pixel_art:` が
// PlayerScreen/EditorScreen → NovelPlayer prop → renderer まで届く配線を、スタブ renderer の
// 呼び出しで縛る（sentencePerPage #448 と対称の配線パターン）。
describe('NovelPlayer pixelArt の renderer 転送 (#466)', () => {
  const lastRenderer = () => rendererInstances[rendererInstances.length - 1]

  it('NP1: pixelArt={true} なら renderer.setPixelArt が true で呼ばれる', async () => {
    render(<NovelPlayer events={[]} pixelArt={true} />)
    await flushAsync()
    expect(lastRenderer().setPixelArt).toHaveBeenCalledWith(true)
  })

  it('NP2: pixelArt 未指定なら renderer.setPixelArt が null で呼ばれる（?? null・既定 linear 相当）', async () => {
    render(<NovelPlayer events={[]} />)
    await flushAsync()
    expect(lastRenderer().setPixelArt).toHaveBeenCalledWith(null)
  })

  it('NP3: pixelArt={false}（明示）でも false で呼ばれる（null に潰れない）', async () => {
    render(<NovelPlayer events={[]} pixelArt={false} />)
    await flushAsync()
    expect(lastRenderer().setPixelArt).toHaveBeenCalledWith(false)
  })
})

// --- #442: 非 fluid（aspect_ratio 16:9/4:3/9:16/未指定）では aspectRatio 変更で再マウントしない ---
//
// mount effect の依存配列は [fluidRemountKey] のみ。fluid（aspect_ratio: auto）以外は
// fluidRemountKey が常に null で不変なため、aspectRatio prop 自体が変わっても effect は
// 再実行されない＝renderer は再構築されない（既存ゲームの「マウント時に1度だけ生成」を維持する
// 非回帰）。ResizeObserver は isFluid=false の早期 return で一切使われないため、モックなしで
// 検証できる（このリポの既存方針＝seekBarResizeObserver 等も ResizeObserver 自体はモックしない
// 先例に倣う）。
describe('NovelPlayer 非fluid時はaspectRatio変更で再マウントしない (#442)', () => {
  it('J1: aspectRatio を "16:9"→"9:16" に変更しても renderer は再構築されない（fluidRemountKey が常に null）', async () => {
    const { rerender } = render(<NovelPlayer events={[]} aspectRatio="16:9" />)
    await flushAsync()
    expect(rendererInstances.length).toBe(1)
    const r = rendererInstances[0]

    rerender(<NovelPlayer events={[]} aspectRatio="9:16" />)
    await flushAsync()

    expect(rendererInstances.length).toBe(1)
    expect(r.destroy).not.toHaveBeenCalled()
  })

  it('J2: aspectRatio 未指定のまま他の prop が変わっても renderer は再構築されない', async () => {
    const { rerender } = render(<NovelPlayer events={[]} />)
    await flushAsync()
    expect(rendererInstances.length).toBe(1)
    const r = rendererInstances[0]

    rerender(<NovelPlayer events={[]} debugEnabled={true} />)
    await flushAsync()

    expect(rendererInstances.length).toBe(1)
    expect(r.destroy).not.toHaveBeenCalled()
  })
})

// --- #578: シーン切り替えごとの自動クイックセーブ + 起動時の自動クイックロード ---
//
// デシジョンテーブル（起動時優先順位、docKey 設定済み前提。pendingSnapshot=fluid再マウント引き継ぎ）:
//   1. pendingSnapshot 有                          → restoreSnapshot() のみ（他は評価されない）
//   2. pendingSnapshot 無・initialSceneId 有        → startFrom() のみ（quickLoad は評価されない）
//   3. pendingSnapshot 無・initialSceneId 無・hasQuickSave() 真 → quickLoad()
//   4. pendingSnapshot 無・initialSceneId 無・hasQuickSave() 偽 → 何もしない（既定のエントリ再生）
// 行1（pendingSnapshot 優先）は fluid 再マウントが前提のため、P-series と同じ
// 「NovelPlayer fluidモードのResizeObserver駆動renderer再マウント」describe 内に置く（後述）。
//
// タイミングに関する注意: `new NovelRenderer(...)` は mount effect 内で render() 呼び出し中に
// 同期的に構築される（renderer.init().then(...) の中身だけが microtask で遅延する）。そのため
// `render(...)` 直後・`await flushAsync()` の前に `rendererInstances` から対象インスタンスを
// 取得し、そこで `hasQuickSave` の戻り値を上書きしてから flushAsync() すれば、mount 内の
// `renderer.hasQuickSave()` 呼び出しに反映される（P1 等が cleanup 側の getSnapshot を
// 同様に上書きするのと対になるタイミング）。
describe('NovelPlayer 自動クイックセーブ/クイックロード (#578)', () => {
  const lastRenderer = () => rendererInstances[rendererInstances.length - 1]

  it('16: pendingSnapshot 無・initialSceneId 無・hasQuickSave() 偽・docKey 有 → quickLoad は呼ばれず通常のエントリ再生のまま', async () => {
    render(<NovelPlayer events={[]} docKey="proj-a" />)
    await flushAsync()
    const r = lastRenderer()
    expect(r.hasQuickSave).toHaveBeenCalled()
    expect(r.quickLoad).not.toHaveBeenCalled()
    expect(r.startFrom).not.toHaveBeenCalled()
  })

  it('17: 同条件で hasQuickSave() が真 → quickLoad() が呼ばれる', async () => {
    render(<NovelPlayer events={[]} docKey="proj-a" />)
    const r = rendererInstances[rendererInstances.length - 1]
    r.hasQuickSave.mockReturnValue(true)
    await flushAsync()

    expect(r.quickLoad).toHaveBeenCalledTimes(1)
    expect(r.startFrom).not.toHaveBeenCalled()
  })

  // #620: willAutoQuickLoad（pendingSnapshot 無・initialSceneId 無・docKey 有・hasQuickSave() 真）
  // が成立する条件では、entry シーン冒頭の自動進行を quickLoad() 側に譲るため、setEvents/setScenes
  // 自体に skipAutoAdvance: true を渡す契約になっている。渡し忘れる回帰（#620 の直接原因）を防ぐ。
  it('23 (#620): willAutoQuickLoad が真の場合、setEvents が { skipAutoAdvance: true } で呼ばれる', async () => {
    render(<NovelPlayer events={[]} docKey="proj-a" />)
    const r = rendererInstances[rendererInstances.length - 1]
    r.hasQuickSave.mockReturnValue(true)
    await flushAsync()

    expect(r.setEvents).toHaveBeenCalledWith([], { skipAutoAdvance: true })
  })

  // #620: quickLoad() が実際にシーンを復元できた（true を返した）場合は、skipAutoAdvance で
  // 保留していた自動進行は restoreToScene 側の後始末に任せるべきで、NovelPlayer 側の
  // フォールバック resumeAutoAdvanceIfPending() を重ねて呼ぶ必要はない。
  it('24 (#620): quickLoad() が true を返す場合、resumeAutoAdvanceIfPending() は呼ばれない', async () => {
    render(<NovelPlayer events={[]} docKey="proj-a" />)
    const r = rendererInstances[rendererInstances.length - 1]
    r.hasQuickSave.mockReturnValue(true)
    r.quickLoad.mockReturnValue(true)
    await flushAsync()

    expect(r.quickLoad).toHaveBeenCalledTimes(1)
    expect(r.resumeAutoAdvanceIfPending).not.toHaveBeenCalled()
  })

  // #620 の本題: quickLoad() が false（データ不整合等の同期的失敗）を返した場合、
  // skipAutoAdvance でスキップしたまま放置される entry シーン冒頭の自動進行を
  // resumeAutoAdvanceIfPending() で必ずフォールバック実行しないと画面が固まる。
  it('25 (#620): quickLoad() が false を返す場合、resumeAutoAdvanceIfPending() が1回呼ばれる', async () => {
    render(<NovelPlayer events={[]} docKey="proj-a" />)
    const r = rendererInstances[rendererInstances.length - 1]
    r.hasQuickSave.mockReturnValue(true)
    r.quickLoad.mockReturnValue(false)
    await flushAsync()

    expect(r.quickLoad).toHaveBeenCalledTimes(1)
    expect(r.resumeAutoAdvanceIfPending).toHaveBeenCalledTimes(1)
  })

  it('19: pendingSnapshot 無・initialSceneId 有の場合、hasQuickSave() の値に関わらず startFrom() のみが呼ばれる', async () => {
    render(<NovelPlayer events={[]} docKey="proj-a" initialSceneId="scene-x" />)
    const r = rendererInstances[rendererInstances.length - 1]
    r.hasQuickSave.mockReturnValue(true)
    await flushAsync()

    expect(r.startFrom).toHaveBeenCalledWith({ sceneId: 'scene-x' })
    expect(r.quickLoad).not.toHaveBeenCalled()
    // #620: initialSceneId が優先される場合は willAutoQuickLoad が成立しないため、
    // setEvents は skipAutoAdvance: false（既定の自動進行あり）で呼ばれる。
    expect(r.setEvents).toHaveBeenCalledWith([], { skipAutoAdvance: false })
  })

  it('20: マウント時に renderer.setOnSceneChange が渡され、そのコールバックを呼ぶと renderer.quickSave() が実行される（docKey 有り）', async () => {
    render(<NovelPlayer events={[]} docKey="proj-a" />)
    await flushAsync()
    const r = lastRenderer()

    expect(r.setOnSceneChange).toHaveBeenCalledTimes(1)
    const cb = r.setOnSceneChange.mock.calls[0][0] as () => void
    cb()

    expect(r.quickSave).toHaveBeenCalledTimes(1)
  })

  it('21 (最重要): docKey が異なる2つの NovelPlayer マウント（別プロジェクト相当）で、それぞれの setDocKey/自動クイックセーブ配線が独立し互いを呼ばない', async () => {
    render(<NovelPlayer events={[]} docKey="project-a" />)
    render(<NovelPlayer events={[]} docKey="project-b" />)
    await flushAsync()

    expect(rendererInstances.length).toBe(2)
    const [rendererA, rendererB] = rendererInstances

    expect(rendererA.setDocKey).toHaveBeenCalledWith('project-a')
    expect(rendererB.setDocKey).toHaveBeenCalledWith('project-b')

    // 各インスタンスのシーン変化コールバックは自分自身の quickSave しか呼ばない（相手を呼ばない）。
    const cbA = rendererA.setOnSceneChange.mock.calls[0][0] as () => void
    cbA()
    expect(rendererA.quickSave).toHaveBeenCalledTimes(1)
    expect(rendererB.quickSave).not.toHaveBeenCalled()

    const cbB = rendererB.setOnSceneChange.mock.calls[0][0] as () => void
    cbB()
    expect(rendererB.quickSave).toHaveBeenCalledTimes(1)
    expect(rendererA.quickSave).toHaveBeenCalledTimes(1) // A 側は変化しない
  })

  it('22: docKey 未指定でマウントした場合（EditorScreen相当）、renderer.setOnSceneChange が呼ばれず、起動時の hasQuickSave()/quickLoad チェーンも実行されない', async () => {
    render(<NovelPlayer events={[]} />)
    await flushAsync()
    const r = lastRenderer()

    expect(r.setOnSceneChange).not.toHaveBeenCalled()
    expect(r.hasQuickSave).not.toHaveBeenCalled()
    expect(r.quickLoad).not.toHaveBeenCalled()
    // #620: docKey が無いと willAutoQuickLoad は成立しない（!!docKey が偽で短絡）ため、
    // setEvents は skipAutoAdvance: false で呼ばれ、resumeAutoAdvanceIfPending() も呼ばれない
    // （quickLoad 自体が評価されないので後始末も不要）。
    expect(r.setEvents).toHaveBeenCalledWith([], { skipAutoAdvance: false })
    expect(r.resumeAutoAdvanceIfPending).not.toHaveBeenCalled()
  })
})

// #442 self-review should-4: fluid（aspect_ratio: auto）モードの中核契約
// ——ResizeObserver が向きカテゴリ変化を検知したら renderer を再マウントする——を
// コンポーネントレベルで検証する。J1/J2（非fluid）は「再マウントしない」side しか見ておらず、
// fluid 側の「実際に再マウントされる」契約が未検証だったための追加（上の ResizeObserverMock 参照）。
//
// jsdom の window.innerWidth/innerHeight は既定 1024×768（横長）のため、初期 fluidRatio は
// '16:9' になる（pickFluidAspectRatio(1024, 768) === '16:9'）。getBoundingClientRect() は
// jsdom では常に 0 を返すため、useLayoutEffect の同期補正（should-3）は発火せず、この初期値の
// まま最初の renderer が作られる（既存の非fluidテストと同じ前提）。
describe('NovelPlayer fluidモードのResizeObserver駆動renderer再マウント (#442 self-review should-4)', () => {
  let originalResizeObserver: typeof ResizeObserver | undefined

  beforeEach(() => {
    originalResizeObserver = window.ResizeObserver
    window.ResizeObserver = ResizeObserverMock as unknown as typeof ResizeObserver
    resetResizeObserverMock()
  })

  afterEach(() => {
    window.ResizeObserver = originalResizeObserver as typeof ResizeObserver
  })

  it('K1: 向きカテゴリが変わるリサイズ通知（横長→縦長）で renderer が再マウントされる（destroy→new）', async () => {
    render(<NovelPlayer events={[]} aspectRatio="auto" />)
    await flushAsync()
    expect(rendererInstances.length).toBe(1)
    const first = rendererInstances[0]
    expect(first.destroy).not.toHaveBeenCalled()

    act(() => {
      triggerResize(400, 800) // 縦長 → fluidRatio '16:9'→'9:16' でカテゴリが変わる
    })
    await flushAsync()

    expect(first.destroy).toHaveBeenCalledOnce()
    expect(rendererInstances.length).toBe(2)
    expect(rendererInstances[1]).not.toBe(first)
  })

  it('K2: 同一カテゴリ内のリサイズ（横長のまま）では renderer は再マウントされない', async () => {
    render(<NovelPlayer events={[]} aspectRatio="auto" />)
    await flushAsync()
    expect(rendererInstances.length).toBe(1)
    const first = rendererInstances[0]

    act(() => {
      triggerResize(1200, 700) // まだ横長（16:9 カテゴリのまま）
    })
    await flushAsync()

    expect(rendererInstances.length).toBe(1)
    expect(first.destroy).not.toHaveBeenCalled()
  })

  it('K3: 縦長→横長→縦長と往復しても、その都度1回ずつ再マウントされる（累積ドリフトしない）', async () => {
    render(<NovelPlayer events={[]} aspectRatio="auto" />)
    await flushAsync()
    expect(rendererInstances.length).toBe(1) // 初期は横長(16:9)

    act(() => {
      triggerResize(400, 800) // → 縦長(9:16)
    })
    await flushAsync()
    expect(rendererInstances.length).toBe(2)

    act(() => {
      triggerResize(1200, 700) // → 横長(16:9) に戻る
    })
    await flushAsync()
    expect(rendererInstances.length).toBe(3)

    expect(rendererInstances[0].destroy).toHaveBeenCalledOnce()
    expect(rendererInstances[1].destroy).toHaveBeenCalledOnce()
    expect(rendererInstances[2].destroy).not.toHaveBeenCalled()
  })

  it('K4: 非fluid（aspectRatio 明示指定）ではリサイズ通知が来ても renderer は再マウントされない', async () => {
    render(<NovelPlayer events={[]} aspectRatio="16:9" />)
    await flushAsync()

    // isFluid=false の早期 return で「向きカテゴリ変化→再マウント」契約（#442, fluidRootRef 用
    // ResizeObserver）は発火しない。#446 で追加した containerRef 用 ResizeObserver（実表示サイズ→
    // レンダラ解像度追従）は isFluid に関係なく常時 observe するため、この describe の
    // window.ResizeObserver モック経由で triggerResize すると #446 側のコールバックにも届くが、
    // それは setRenderResolution を呼ぶだけで renderer の再マウント（destroy→new）は起こさない。
    act(() => {
      triggerResize(400, 800)
    })
    await flushAsync()

    expect(rendererInstances.length).toBe(1)
    expect(rendererInstances[0].destroy).not.toHaveBeenCalled()
  })

  // #460: fluid 再マウント時に旧 renderer の getSnapshot() を新 renderer の restoreSnapshot() へ
  // 引き継ぎ、読み進め位置（背景/立ち絵/BGM 込み）を維持する契約。K1-K4 は「再マウントされる/
  // されない」だけを見ており、位置引き継ぎそのものは未検証だったための追加。
  //
  // MockRenderer.getSnapshot() の既定値は sceneId: null（NovelPlayer.test.tsx 冒頭のコメント参照）。
  // 「意味のあるスナップショット」を作るテストだけ、対象 renderer インスタンスの getSnapshot を
  // 明示的に上書きする。
  const NEUTRAL_SNAPSHOT: NovelGameState = {
    sceneId: null,
    eventIndex: 0,
    textIndex: 0,
    sentenceIndex: 0,
    flags: {},
    backgroundPath: null,
    backgroundColor: null,
    backgroundFade: null,
    backgroundBrightness: null,
    video: null,
    eventImage: null,
    isBlackout: false,
    characters: [],
    currentBgmPath: null,
    storyEnded: false,
  }

  it('P1: 旧 renderer の getSnapshot が有効な sceneId 付きの値を返すとき、新 renderer の restoreSnapshot がそのオブジェクトで1回だけ呼ばれる', async () => {
    render(<NovelPlayer events={[]} aspectRatio="auto" />)
    await flushAsync()
    const first = rendererInstances[0]
    const snapshot: NovelGameState = { ...NEUTRAL_SNAPSHOT, sceneId: 'scene-a', eventIndex: 2 }
    first.getSnapshot.mockReturnValue(snapshot)

    act(() => {
      triggerResize(400, 800) // 横長 → 縦長でカテゴリが変わる
    })
    await flushAsync()

    expect(rendererInstances.length).toBe(2)
    const second = rendererInstances[1]
    expect(second.restoreSnapshot).toHaveBeenCalledTimes(1)
    expect(second.restoreSnapshot).toHaveBeenCalledWith(snapshot)
  })

  it('P2: restoreSnapshot される場合、initialSceneId が指定されていても新 renderer の startFrom は呼ばれない（restoreSnapshot 優先・二重位置決め防止）', async () => {
    render(<NovelPlayer events={[]} aspectRatio="auto" initialSceneId="scene-x" />)
    await flushAsync()
    const first = rendererInstances[0]
    // 初回マウントは G1 と同条件: initialSceneId により startFrom が呼ばれている
    expect(first.startFrom).toHaveBeenCalledWith({ sceneId: 'scene-x' })

    const snapshot: NovelGameState = { ...NEUTRAL_SNAPSHOT, sceneId: 'scene-a' }
    first.getSnapshot.mockReturnValue(snapshot)

    act(() => {
      triggerResize(400, 800)
    })
    await flushAsync()

    const second = rendererInstances[1]
    expect(second.restoreSnapshot).toHaveBeenCalledTimes(1)
    expect(second.startFrom).not.toHaveBeenCalled()
  })

  it('P3: 旧 renderer の getSnapshot が既定の sceneId: null のままリサイズすると restoreSnapshot は呼ばれず、initialSceneId 指定時は従来どおり新 renderer で startFrom が呼ばれる', async () => {
    render(<NovelPlayer events={[]} aspectRatio="auto" initialSceneId="scene-x" />)
    await flushAsync()
    // getSnapshot は既定のまま（sceneId: null）上書きしない

    act(() => {
      triggerResize(400, 800)
    })
    await flushAsync()

    expect(rendererInstances.length).toBe(2)
    const second = rendererInstances[1]
    expect(second.restoreSnapshot).not.toHaveBeenCalled()
    expect(second.startFrom).toHaveBeenCalledTimes(1)
    expect(second.startFrom).toHaveBeenCalledWith({ sceneId: 'scene-x' })
  })

  it('P4: 縦→横→縦と2回remountさせても、2回目の restoreSnapshot は1回目に生成された renderer 自身の getSnapshot 戻り値で呼ばれ、初代(0世代目)の値が混入しない', async () => {
    render(<NovelPlayer events={[]} aspectRatio="auto" />)
    await flushAsync()
    const gen0 = rendererInstances[0]
    const snap0: NovelGameState = { ...NEUTRAL_SNAPSHOT, sceneId: 'gen0-scene' }
    gen0.getSnapshot.mockReturnValue(snap0)

    act(() => {
      triggerResize(400, 800) // 横長 → 縦長: gen0 destroy → gen1 mount
    })
    await flushAsync()
    expect(rendererInstances.length).toBe(2)
    const gen1 = rendererInstances[1]
    expect(gen1.restoreSnapshot).toHaveBeenCalledWith(snap0)

    const snap1: NovelGameState = { ...NEUTRAL_SNAPSHOT, sceneId: 'gen1-scene' }
    gen1.getSnapshot.mockReturnValue(snap1)

    act(() => {
      triggerResize(1200, 700) // 縦長 → 横長: gen1 destroy → gen2 mount
    })
    await flushAsync()
    expect(rendererInstances.length).toBe(3)
    const gen2 = rendererInstances[2]

    // 2回目の restoreSnapshot は gen1 自身の値で呼ばれる（gen0 の値が混入していない）
    expect(gen2.restoreSnapshot).toHaveBeenCalledTimes(1)
    expect(gen2.restoreSnapshot).toHaveBeenCalledWith(snap1)
    expect(gen2.restoreSnapshot).not.toHaveBeenCalledWith(snap0)
  })

  it('P5: 非fluid（aspectRatio 固定）ではリサイズ通知が来ても再マウント自体が起きず、restoreSnapshot も呼ばれない', async () => {
    render(<NovelPlayer events={[]} aspectRatio="16:9" />)
    await flushAsync()
    expect(rendererInstances.length).toBe(1)
    const r = rendererInstances[0]

    act(() => {
      triggerResize(400, 800)
    })
    await flushAsync()

    expect(rendererInstances.length).toBe(1)
    expect(r.restoreSnapshot).not.toHaveBeenCalled()
  })

  it('P6: fluid で同一カテゴリ内のリサイズでは再マウントされず restoreSnapshot も呼ばれない', async () => {
    render(<NovelPlayer events={[]} aspectRatio="auto" />)
    await flushAsync()
    const r = rendererInstances[0]

    act(() => {
      triggerResize(1200, 700) // まだ横長（16:9 カテゴリのまま）
    })
    await flushAsync()

    expect(rendererInstances.length).toBe(1)
    expect(r.restoreSnapshot).not.toHaveBeenCalled()
  })

  it('P7: 旧 renderer の init() が永久 pending でもカテゴリ変化リサイズは例外を投げず、cleanup の getSnapshot() が安全に呼ばれる（既定 null）ため restoreSnapshot は呼ばれない', async () => {
    setInitNeverResolves(true)
    render(<NovelPlayer events={[]} aspectRatio="auto" />)
    await flushAsync()
    const first = rendererInstances[0]

    // cleanup の getSnapshot() 呼び出しは init().then(...) の外（同期コード）なので、
    // 旧 renderer の init() が未解決のままでも安全に走ることを確認する。
    expect(() => {
      act(() => {
        triggerResize(400, 800)
      })
    }).not.toThrow()
    await flushAsync()

    expect(first.getSnapshot).toHaveBeenCalled()
    expect(first.destroy).toHaveBeenCalledOnce()

    // 新 renderer が作られるが、getSnapshot 既定値（sceneId: null）のため restoreSnapshot は呼ばれない。
    expect(rendererInstances.length).toBe(2)
    const second = rendererInstances[1]
    expect(second.restoreSnapshot).not.toHaveBeenCalled()
  })

  it('P8: 初回 mount 時点では restoreSnapshot は呼ばれない（再マウント経由でのみ発火する回帰防止）', async () => {
    render(<NovelPlayer events={[]} aspectRatio="auto" />)
    await flushAsync()
    expect(rendererInstances.length).toBe(1)
    expect(rendererInstances[0].restoreSnapshot).not.toHaveBeenCalled()
  })

  it('P9: restoreSnapshot 正常系フロー（P1 相当）で NovelPlayer 側が独自に console.error/console.warn を出さない', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    render(<NovelPlayer events={[]} aspectRatio="auto" />)
    await flushAsync()
    const first = rendererInstances[0]
    first.getSnapshot.mockReturnValue({ ...NEUTRAL_SNAPSHOT, sceneId: 'scene-a' })

    act(() => {
      triggerResize(400, 800)
    })
    await flushAsync()

    expect(warnSpy).not.toHaveBeenCalled()
    expect(errorSpy).not.toHaveBeenCalled()
  })

  // #460 セルフレビュー should S1: pendingSnapshotRef は単一の共有 ref で、cleanup 内で毎回
  // getSnapshot() の結果を無条件上書きしていた。gen0→gen1(init 未完了)→gen2 と短時間に連続
  // remount すると、gen1 の cleanup が「まだ何も進行していない空スナップショット」(sceneId: null)
  // で gen0 の有効なスナップショットを上書き消去してしまい、gen2 が結局位置ロストしていた。
  // 修正: cleanup 内で新しい getSnapshot().sceneId が null のときは pendingSnapshotRef を
  // 上書きしない（直前の有効な値を保持し続ける）。
  it('P10 (#460 S1): 二重連続remount（gen1 が init() 未完了のまま gen2 remount が来る）でも、gen0 の有効なスナップショットが保持され gen2 に引き継がれる', async () => {
    render(<NovelPlayer events={[]} aspectRatio="auto" />)
    await flushAsync()
    const gen0 = rendererInstances[0]
    const snap0: NovelGameState = { ...NEUTRAL_SNAPSHOT, sceneId: 'gen0-scene' }
    gen0.getSnapshot.mockReturnValue(snap0)

    // gen1 の init() を永久 pending にする。gen1 は「まだ何も進行していない」
    // （getSnapshot 既定値 sceneId: null のまま）状態で次の remount により destroy される。
    setInitNeverResolves(true)
    act(() => {
      triggerResize(400, 800) // 横長 → 縦長: gen0 destroy（snap0 を pendingSnapshotRef へ）→ gen1 mount
    })
    expect(rendererInstances.length).toBe(2)
    const gen1 = rendererInstances[1]
    // gen1.getSnapshot は既定のまま上書きしない（sceneId: null の空スナップショット）

    // gen1 の init() が未解決のまま、さらにカテゴリが変わるリサイズが来て gen1 が destroy される。
    setInitNeverResolves(false)
    act(() => {
      triggerResize(1200, 700) // 縦長 → 横長: gen1(init未完了) destroy → gen2 mount
    })
    await flushAsync()

    expect(rendererInstances.length).toBe(3)
    const gen2 = rendererInstances[2]
    // gen1 の空スナップショットで上書きされず、gen0 の有効なスナップショットが gen2 に渡る
    expect(gen2.restoreSnapshot).toHaveBeenCalledTimes(1)
    expect(gen2.restoreSnapshot).toHaveBeenCalledWith(snap0)
    expect(gen1.getSnapshot).toHaveBeenCalled()
  })

  // #460 再発修正: Gymnasia のような hub(entry doc) + ルート別 md のマルチMD構成では、
  // 再マウント直後の新 renderer の allScenes には entry doc のシーンしか無く、restoreSnapshot が
  // 渡す sceneId は missingSceneResolver 経由の遅延ロードで初めて解決できる（NovelRenderer 側の
  // 実装は NovelRenderer.restoreSnapshot.test.ts の K1-K6 で検証済み）。その遅延解決が機能する
  // 前提条件は「新 renderer に対して setMissingSceneResolver が restoreSnapshot より前に呼ばれて
  // いること」（NovelRenderer.restoreSnapshot は呼び出し時点の missingSceneResolver しか見ない）。
  // NovelRenderer は本ファイルでは全面 mock のため実際の遅延解決ロジックはここでは検証できないが、
  // その前提となる呼び出し順序の契約はここで縛れる（将来 NovelPlayer.tsx の呼び出し順が入れ替わる
  // 回帰を防ぐ）。
  it('P11 (#460 マルチMD): 再マウント後の新 renderer で setMissingSceneResolver が restoreSnapshot より前に呼ばれる', async () => {
    const resolver = vi.fn(async () => null)
    render(<NovelPlayer events={[]} aspectRatio="auto" onResolveMissingScene={resolver} />)
    await flushAsync()
    const first = rendererInstances[0]
    const snapshot: NovelGameState = { ...NEUTRAL_SNAPSHOT, sceneId: 'route-scene' }
    first.getSnapshot.mockReturnValue(snapshot)

    act(() => {
      triggerResize(400, 800)
    })
    await flushAsync()

    const second = rendererInstances[1]
    expect(second.setMissingSceneResolver).toHaveBeenCalledWith(resolver)
    expect(second.restoreSnapshot).toHaveBeenCalledTimes(1)
    expect(second.restoreSnapshot).toHaveBeenCalledWith(snapshot)

    const resolverCallOrder = second.setMissingSceneResolver.mock.invocationCallOrder[0]
    const restoreCallOrder = second.restoreSnapshot.mock.invocationCallOrder[0]
    expect(resolverCallOrder).toBeLessThan(restoreCallOrder)
  })

  // #578: 起動時優先順位デシジョンテーブルの行1（pendingSnapshot 優先）。fluid 再マウント経由で
  // pendingSnapshot が渡る状況を作れるのはこの describe だけなので、P-series の直後に置く。
  it('P12 (#578): pendingSnapshot 有の場合、hasQuickSave()/initialSceneId の値に関わらず restoreSnapshot のみが呼ばれ quickLoad()/startFrom() は呼ばれない', async () => {
    render(<NovelPlayer events={[]} aspectRatio="auto" docKey="proj-a" initialSceneId="scene-x" />)
    await flushAsync()
    const first = rendererInstances[0]
    const snapshot: NovelGameState = { ...NEUTRAL_SNAPSHOT, sceneId: 'scene-a', eventIndex: 2 }
    first.getSnapshot.mockReturnValue(snapshot)

    act(() => {
      triggerResize(400, 800) // 横長 → 縦長でカテゴリが変わる → gen0 destroy → gen1 mount
    })
    const second = rendererInstances[rendererInstances.length - 1]
    // hasQuickSave() が真でも pendingSnapshot 優先で無視されることを強く示すため true にしておく。
    second.hasQuickSave.mockReturnValue(true)
    await flushAsync()

    expect(second.restoreSnapshot).toHaveBeenCalledWith(snapshot)
    expect(second.quickLoad).not.toHaveBeenCalled()
    expect(second.startFrom).not.toHaveBeenCalled()
    // #620: pendingSnapshot が優先される場合は willAutoQuickLoad が成立しないため、
    // setEvents は skipAutoAdvance: false（既定の自動進行あり）で呼ばれる。
    expect(second.setEvents).toHaveBeenCalledWith([], { skipAutoAdvance: false })
  })
})

// #446: containerRef（letterbox 内接矩形、canvas が CSS で引き伸ばされる箱）の実表示サイズを
// ResizeObserver で監視し、200ms debounce の後に renderer.setRenderResolution(...) で
// レンダラ解像度を追従させる effect の単体テスト。isFluid に関係なく常時稼働する（K4 group と
// 同じ window.ResizeObserver モック・triggerResize を再利用する）。
//
// isExporting() によるガードが本群の核心: VideoExporter の書き出し中はこの自動追従を止めないと
// 書き出し品質を巻き戻してしまう。判定は「debounce 発火時点」の isExporting() の値で行う設計
// （スケジュール時点ではない）ため、発火前に false へ戻れば適用される「自己修復」ケースと、
// 発火時にまだ true でスキップされ、その後 false に戻っても新たなリサイズが無ければ二度と
// 適用されない「stale」ケース（#455 として別 Issue 化済み・ここでは現状挙動の固定のみ）の
// 両方を縛る。
describe('NovelPlayer containerRef の実表示サイズ追従 ResizeObserver + debounce (#446)', () => {
  let originalResizeObserver: typeof ResizeObserver | undefined
  let originalDpr: number

  beforeEach(() => {
    originalResizeObserver = window.ResizeObserver
    window.ResizeObserver = ResizeObserverMock as unknown as typeof ResizeObserver
    resetResizeObserverMock()
    originalDpr = window.devicePixelRatio
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    window.ResizeObserver = originalResizeObserver as typeof ResizeObserver
    Object.defineProperty(window, 'devicePixelRatio', {
      value: originalDpr,
      configurable: true,
      writable: true,
    })
  })

  // aspectRatio="16:9" 固定（非fluid）の gameWidth/gameHeight（ASPECT_RATIOS['16:9'], constants.ts）。
  const GAME_WIDTH_16_9 = 800
  const GAME_HEIGHT_16_9 = 450
  // aspectRatio="9:16" 固定（非fluid）の gameWidth/gameHeight（ASPECT_RATIOS['9:16'], constants.ts）。
  const GAME_WIDTH_9_16 = 450
  const GAME_HEIGHT_9_16 = 800

  it('C1: リサイズから200ms経過でrenderer.setRenderResolution(表示幅/論理幅×dprの計算値)が呼ばれる', async () => {
    render(<NovelPlayer events={[]} aspectRatio="16:9" />)
    await flushAsync()
    const r = rendererInstances[0]
    r.setRenderResolution.mockClear() // マウント時の init effect 由来の1回を除外する

    act(() => {
      triggerResize(1600, 900)
    })
    act(() => {
      vi.advanceTimersByTime(200)
    })

    const dpr = window.devicePixelRatio || 1
    expect(r.setRenderResolution).toHaveBeenCalledTimes(1)
    expect(r.setRenderResolution).toHaveBeenCalledWith(
      computeDynamicRenderResolution(1600, GAME_WIDTH_16_9, GAME_HEIGHT_16_9, dpr)
    )
  })

  it('C2: 境界値199ms時点ではまだ呼ばれず、200msちょうどで呼ばれる', async () => {
    render(<NovelPlayer events={[]} aspectRatio="16:9" />)
    await flushAsync()
    const r = rendererInstances[0]
    r.setRenderResolution.mockClear()

    act(() => {
      triggerResize(1600, 900)
    })
    act(() => {
      vi.advanceTimersByTime(199)
    })
    expect(r.setRenderResolution).not.toHaveBeenCalled()

    act(() => {
      vi.advanceTimersByTime(1) // 累計200ms
    })
    expect(r.setRenderResolution).toHaveBeenCalledTimes(1)
  })

  it('C3: 200ms窓内に連続3回リサイズすると最終値1回分だけsetRenderResolutionが呼ばれる（二重送信防止）', async () => {
    render(<NovelPlayer events={[]} aspectRatio="16:9" />)
    await flushAsync()
    const r = rendererInstances[0]
    r.setRenderResolution.mockClear()

    act(() => {
      triggerResize(1000, 600) // 1回目（窓内で上書きされ最終的に破棄される）
    })
    act(() => {
      vi.advanceTimersByTime(50)
    })
    act(() => {
      triggerResize(1200, 700) // 2回目（同じく窓内で上書き）
    })
    act(() => {
      vi.advanceTimersByTime(50)
    })
    act(() => {
      triggerResize(1600, 900) // 3回目（最終値。これだけが適用される）
    })
    act(() => {
      vi.advanceTimersByTime(200) // 3回目から200ms経過
    })

    const dpr = window.devicePixelRatio || 1
    expect(r.setRenderResolution).toHaveBeenCalledTimes(1)
    expect(r.setRenderResolution).toHaveBeenCalledWith(
      computeDynamicRenderResolution(1600, GAME_WIDTH_16_9, GAME_HEIGHT_16_9, dpr)
    )
  })

  it('C4: 200ms窓を超えて2回リサイズ(間隔250ms)すると2回とも独立して呼ばれる', async () => {
    render(<NovelPlayer events={[]} aspectRatio="16:9" />)
    await flushAsync()
    const r = rendererInstances[0]
    r.setRenderResolution.mockClear()

    act(() => {
      triggerResize(1000, 600)
    })
    act(() => {
      vi.advanceTimersByTime(250)
    })
    act(() => {
      triggerResize(1600, 900)
    })
    act(() => {
      vi.advanceTimersByTime(250)
    })

    const dpr = window.devicePixelRatio || 1
    expect(r.setRenderResolution).toHaveBeenCalledTimes(2)
    expect(r.setRenderResolution).toHaveBeenNthCalledWith(
      1,
      computeDynamicRenderResolution(1000, GAME_WIDTH_16_9, GAME_HEIGHT_16_9, dpr)
    )
    expect(r.setRenderResolution).toHaveBeenNthCalledWith(
      2,
      computeDynamicRenderResolution(1600, GAME_WIDTH_16_9, GAME_HEIGHT_16_9, dpr)
    )
  })

  it('デシジョンテーブル最重要ケース1: debounce発火時にisExporting()===trueならsetRenderResolutionは呼ばれない', async () => {
    render(<NovelPlayer events={[]} aspectRatio="16:9" />)
    await flushAsync()
    const r = rendererInstances[0]
    r.setRenderResolution.mockClear()
    r.isExporting.mockReturnValue(true)

    act(() => {
      triggerResize(1600, 900)
    })
    act(() => {
      vi.advanceTimersByTime(200) // 発火時点でも isExporting()===true のまま
    })

    expect(r.setRenderResolution).not.toHaveBeenCalled()
  })

  it('デシジョンテーブル最重要ケース2(自己修復): リサイズ時isExporting()===trueでも200ms経過前にfalseへ変わればこの回は適用される', async () => {
    render(<NovelPlayer events={[]} aspectRatio="16:9" />)
    await flushAsync()
    const r = rendererInstances[0]
    r.setRenderResolution.mockClear()
    r.isExporting.mockReturnValue(true)

    act(() => {
      triggerResize(1600, 900)
    })
    act(() => {
      vi.advanceTimersByTime(100) // まだ窓の途中
    })
    r.isExporting.mockReturnValue(false) // 書き出しが200ms経過前に終わる
    act(() => {
      vi.advanceTimersByTime(100) // 累計200ms＝発火時点は isExporting()===false
    })

    const dpr = window.devicePixelRatio || 1
    expect(r.setRenderResolution).toHaveBeenCalledTimes(1)
    expect(r.setRenderResolution).toHaveBeenCalledWith(
      computeDynamicRenderResolution(1600, GAME_WIDTH_16_9, GAME_HEIGHT_16_9, dpr)
    )
  })

  it('デシジョンテーブル最重要ケース3(stale・#455として別Issue化済・現状挙動の固定): 発火時もisExporting()===trueでスキップされた回は、その後falseに戻すだけでは適用されないまま終わる', async () => {
    render(<NovelPlayer events={[]} aspectRatio="16:9" />)
    await flushAsync()
    const r = rendererInstances[0]
    r.setRenderResolution.mockClear()
    r.isExporting.mockReturnValue(true)

    act(() => {
      triggerResize(1600, 900)
    })
    act(() => {
      vi.advanceTimersByTime(200) // 発火時点でまだ true → スキップ（debounceTimer は消費済み）
    })
    expect(r.setRenderResolution).not.toHaveBeenCalled()

    // 書き出しは終わったが、新たなリサイズは発生しない（#455: 現行実装はこのケースを
    // 自己修復しない。ここでは「直す」のではなく現状挙動を固定するだけ）。
    r.isExporting.mockReturnValue(false)
    act(() => {
      vi.advanceTimersByTime(5000)
    })
    expect(r.setRenderResolution).not.toHaveBeenCalled()
  })

  it('クリーンアップ: unmount時にpending中のdebounceタイマーがクリアされ、unmount後200ms経過してもsetRenderResolutionが呼ばれない', async () => {
    const { unmount } = render(<NovelPlayer events={[]} aspectRatio="16:9" />)
    await flushAsync()
    const r = rendererInstances[0]
    r.setRenderResolution.mockClear()

    act(() => {
      triggerResize(1600, 900)
    })
    unmount()
    act(() => {
      vi.advanceTimersByTime(200)
    })

    expect(r.setRenderResolution).not.toHaveBeenCalled()
  })

  it('C9: gameWidth変化（aspectRatio prop変更）でeffectが張り直され、旧ResizeObserverはdisconnectされる（同一リサイズで二重発火しない）', async () => {
    const { rerender } = render(<NovelPlayer events={[]} aspectRatio="16:9" />)
    await flushAsync()
    const r = rendererInstances[0]

    rerender(<NovelPlayer events={[]} aspectRatio="9:16" />)
    await flushAsync()
    // 非fluidのaspectRatio変更はrendererを再構築しない（#442 J1と同じ前提）。
    expect(rendererInstances.length).toBe(1)
    r.setRenderResolution.mockClear()

    act(() => {
      triggerResize(900, 1600)
    })
    act(() => {
      vi.advanceTimersByTime(200)
    })

    // 旧effect（gameWidth=800側）のコールバックがdisconnectされずに残っていれば、
    // 同じtriggerResizeで2回呼ばれてしまう。新gameWidth(450)基準の1回だけが正しい。
    const dpr = window.devicePixelRatio || 1
    expect(r.setRenderResolution).toHaveBeenCalledTimes(1)
    expect(r.setRenderResolution).toHaveBeenCalledWith(
      computeDynamicRenderResolution(900, GAME_WIDTH_9_16, GAME_HEIGHT_9_16, dpr)
    )
  })

  it('K4連動確認: 非fluid(aspectRatio="16:9"固定)でもcontainerRefのResizeObserverは常時稼働し、リサイズでsetRenderResolutionが呼ばれる（renderer自体は再マウントされない）', async () => {
    render(<NovelPlayer events={[]} aspectRatio="16:9" />)
    await flushAsync()
    const r = rendererInstances[0]
    r.setRenderResolution.mockClear()

    act(() => {
      triggerResize(1600, 900)
    })
    act(() => {
      vi.advanceTimersByTime(200)
    })

    expect(r.setRenderResolution).toHaveBeenCalledTimes(1)
    // K4契約: renderer自体はdestroy→newされない（#446は解像度追従のみでrenderer再マウントとは無関係）。
    expect(rendererInstances.length).toBe(1)
    expect(r.destroy).not.toHaveBeenCalled()
  })

  it('fluid+向きカテゴリ変化との共存: K1と同条件のリサイズで、旧renderer破棄と#446 debounce発火が競合しても例外にならない', async () => {
    render(<NovelPlayer events={[]} aspectRatio="auto" />)
    await flushAsync()
    const first = rendererInstances[0]
    first.setRenderResolution.mockClear() // マウント時の init effect 由来の1回を除外する

    expect(() => {
      act(() => {
        triggerResize(400, 800) // K1と同条件: 横長→縦長で向きカテゴリが変わりrendererが再マウントされる
      })
    }).not.toThrow()
    await flushAsync()

    // K1契約の再確認: 旧rendererはdestroyされ、新rendererが作られている。
    expect(first.destroy).toHaveBeenCalledOnce()
    expect(rendererInstances.length).toBe(2)

    // #446のdebounceタイマー（gameWidth変化でeffectごと張り直されているはずなので、生き残っていても
    // 新gameWidthの新effect分のみのはず）が発火する200ms後まで進めても例外にならない。
    expect(() => {
      act(() => {
        vi.advanceTimersByTime(200)
      })
    }).not.toThrow()

    // セルフレビュー nit 対応: 「例外にならない」だけでは、既にdestroyされた旧rendererへ
    // debounce発火が誤って setRenderResolution を叩いてしまうケースを見逃す。containerRef effect
    // は gameWidth 変化のたびに張り直され、クリーンアップで旧 debounceTimer を確実に clearTimeout
    // する設計（apply() 内の renderer も呼び出し時点の rendererRef.current を都度参照する）なので、
    // 旧renderer（first）の setRenderResolution が一切呼ばれていないことを直接アサートする。
    expect(first.setRenderResolution).not.toHaveBeenCalled()
  })

  it('境界値/縮退: containerRef.currentがあってもgetBoundingClientRect().width<=0（jsdom既定）なら初回同期測定でapply()は呼ばれない', () => {
    render(<NovelPlayer events={[]} aspectRatio="16:9" />)
    // ここではまだ renderer.init(...).then(...) のmicrotaskをflushしていない。
    // もし#446 layout effect自身の初回同期測定（containerRef.getBoundingClientRect().width<=0の
    // はずのguard）が誤って発火していれば、この時点で既にsetRenderResolutionが呼ばれているはず。
    const r = rendererInstances[0]
    expect(r.setRenderResolution).not.toHaveBeenCalled()
  })

  it('dpr伝播確認: window.devicePixelRatioを2に差し替えてリサイズすると、渡る値にdpr=2が反映される', async () => {
    render(<NovelPlayer events={[]} aspectRatio="16:9" />)
    await flushAsync()
    const r = rendererInstances[0]
    r.setRenderResolution.mockClear()

    Object.defineProperty(window, 'devicePixelRatio', {
      value: 2,
      configurable: true,
      writable: true,
    })

    act(() => {
      triggerResize(1600, 900)
    })
    act(() => {
      vi.advanceTimersByTime(200)
    })

    expect(r.setRenderResolution).toHaveBeenCalledTimes(1)
    expect(r.setRenderResolution).toHaveBeenCalledWith(
      computeDynamicRenderResolution(1600, GAME_WIDTH_16_9, GAME_HEIGHT_16_9, 2)
    )
  })
})

// #446: window.ResizeObserver 非対応環境（古いブラウザ・一部jsdom設定等）でも、containerRef用
// effectがthrowせず・console.errorも出さずに黙って早期returnすることを縛る
// （fluidRootRef用#442 effectと同じガード・同じ流儀）。上のdescribeブロックはwindow.ResizeObserverを
// 常にモック化しているため、ここだけ独立してundefinedにする。
describe('NovelPlayer containerRef ResizeObserver 非対応環境 (#446)', () => {
  it('window.ResizeObserverがundefinedでもeffectがthrowせず、console.errorも出さない', async () => {
    const original = window.ResizeObserver
    // @ts-expect-error 意図的にResizeObserver非対応環境を模す
    window.ResizeObserver = undefined
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    try {
      expect(() => render(<NovelPlayer events={[]} aspectRatio="16:9" />)).not.toThrow()
      await flushAsync()
      expect(errSpy).not.toHaveBeenCalled()
    } finally {
      window.ResizeObserver = original
    }
  })
})

// #444: fluid（aspect_ratio: auto）モードで splitLayout={true} を渡すと、pickFluidAspectRatio が
// 通常の 16:9/9:16 ではなく 2:1/1:2（split_layout 2窓モード用に半分がちょうど正方形になる専用比率）
// を選ぶ。ここではキャンバス箱（`.overflow-hidden` — gameBoxStyle を当てる containerRef 要素）の
// CSS `aspect-ratio` に実際にその値が反映されることを結合レベルで確認する。
// jsdom の window.innerWidth/innerHeight は既定 1024×768（横長）— K 群のコメントと同じ前提。
describe('NovelPlayer fluid + splitLayout の CSS aspect-ratio 配線 (#444)', () => {
  const gameBox = () => document.querySelector('.overflow-hidden') as HTMLElement | null

  it('NP-1: aspectRatio="auto" + splitLayout={true} + 横長ビューポートで CSS aspect-ratio が "900 / 450"（2:1）になる', async () => {
    render(<NovelPlayer events={[]} aspectRatio="auto" splitLayout={true} />)
    await flushAsync()

    expect(gameBox()?.style.aspectRatio).toBe('900 / 450')
  })

  it('NP-3: 非破壊 — aspectRatio="auto" + splitLayout 未指定（??false）では従来どおり "800 / 450"（16:9）のまま', async () => {
    render(<NovelPlayer events={[]} aspectRatio="auto" />)
    await flushAsync()

    expect(gameBox()?.style.aspectRatio).toBe('800 / 450')
  })

  // N1（self-review nit）: NP-1 の横長ケースと対称に、縦長ビューポートでも配線されることを確認する。
  // window.innerWidth/innerHeight を縦長（768×1024）に差し替えて mount する（NP-1 と同じ実装、
  // ビューポートサイズだけ入れ替える）。pickFluidAspectRatio(768, 1024, true) は 768 < 1024 の
  // portrait 分岐で '1:2' を返し、ASPECT_RATIOS['1:2'] は {width: 450, height: 900}。
  it('NP-4: aspectRatio="auto" + splitLayout={true} + 縦長ビューポート（768×1024）で CSS aspect-ratio が "450 / 900"（1:2）になる', async () => {
    const originalWidth = window.innerWidth
    const originalHeight = window.innerHeight
    Object.defineProperty(window, 'innerWidth', { value: 768, configurable: true })
    Object.defineProperty(window, 'innerHeight', { value: 1024, configurable: true })
    try {
      render(<NovelPlayer events={[]} aspectRatio="auto" splitLayout={true} />)
      await flushAsync()

      expect(gameBox()?.style.aspectRatio).toBe('450 / 900')
    } finally {
      Object.defineProperty(window, 'innerWidth', { value: originalWidth, configurable: true })
      Object.defineProperty(window, 'innerHeight', { value: originalHeight, configurable: true })
    }
  })
})

// #413: インジケータ画像（next/pageturn 各4枚=計8枚）の先読み useEffect。
// `renderer`/`rendererRef` を一切参照しない、`[assetBaseUrl]` だけに依存する独立 effect（下の
// renderer 生成/init effect とは別物）であることが本題。pixi.js はこのテストファイルでは
// NovelRenderer 経由でしか使っていない（vi.mock 済み）ため未モックで、DialogBox.test.ts と同じ
// 流儀で `Assets.load` を直接 spy する。期待 URL は資料値の直書きでなく getIndicatorImageUrls で
// 組み立てて陳腐化を防ぐ（doctrine 規律4）。
describe('NovelPlayer インジケータ画像先読み (#413)', () => {
  const expectedUrls = (base: string) =>
    (['next', 'pageturn'] as const).flatMap((kind) => getIndicatorImageUrls(base, kind))

  it('NP-1: assetBaseUrl を最初から渡してmountすると8URL全てで Assets.load が呼ばれる', async () => {
    const load = vi
      .spyOn(Assets, 'load')
      .mockResolvedValue(Texture.WHITE as unknown as Awaited<ReturnType<typeof Assets.load>>)

    render(<NovelPlayer events={[]} assetBaseUrl="/asset-base" />)
    await flushAsync()

    const urls = expectedUrls('/asset-base')
    expect(urls.length).toBe(8)
    expect(load).toHaveBeenCalledTimes(8)
    urls.forEach((url) => expect(load).toHaveBeenCalledWith(url))
  })

  it('NP-2: assetBaseUrl=undefined でmount→rerenderで値確定すると、mount時0回・確定後8回', async () => {
    const load = vi
      .spyOn(Assets, 'load')
      .mockResolvedValue(Texture.WHITE as unknown as Awaited<ReturnType<typeof Assets.load>>)

    const { rerender } = render(<NovelPlayer events={[]} />)
    await flushAsync()
    expect(load).not.toHaveBeenCalled()

    rerender(<NovelPlayer events={[]} assetBaseUrl="/asset-base" />)
    await flushAsync()

    expect(load).toHaveBeenCalledTimes(8)
  })

  it('NP-3: assetBaseUrl を最後まで渡さないと Assets.load は一度も呼ばれない', async () => {
    const load = vi
      .spyOn(Assets, 'load')
      .mockResolvedValue(Texture.WHITE as unknown as Awaited<ReturnType<typeof Assets.load>>)

    render(<NovelPlayer events={[]} />)
    await flushAsync()

    expect(load).not.toHaveBeenCalled()
  })

  it('NP-3b: assetBaseUrl="" でも Assets.load は一度も呼ばれない（境界: 空文字も未設定扱い）', async () => {
    const load = vi
      .spyOn(Assets, 'load')
      .mockResolvedValue(Texture.WHITE as unknown as Awaited<ReturnType<typeof Assets.load>>)

    render(<NovelPlayer events={[]} assetBaseUrl="" />)
    await flushAsync()

    expect(load).not.toHaveBeenCalled()
  })

  it('NP-4: assetBaseUrl が /a→/b と変わると追加で8回呼ばれる（計16回）', async () => {
    const load = vi
      .spyOn(Assets, 'load')
      .mockResolvedValue(Texture.WHITE as unknown as Awaited<ReturnType<typeof Assets.load>>)

    const { rerender } = render(<NovelPlayer events={[]} assetBaseUrl="/a" />)
    await flushAsync()
    expect(load).toHaveBeenCalledTimes(8)

    rerender(<NovelPlayer events={[]} assetBaseUrl="/b" />)
    await flushAsync()

    expect(load).toHaveBeenCalledTimes(16)
  })

  it('NP-5: fetch未解決のうちに unmount しても例外を投げない', async () => {
    vi.spyOn(Assets, 'load').mockImplementation(
      () => new Promise<never>(() => {}) // 永久 pending
    )

    const { unmount } = render(<NovelPlayer events={[]} assetBaseUrl="/asset-base" />)
    await flushAsync()

    expect(() => unmount()).not.toThrow()
  })

  it('NP-6: renderer.init() が永久 pending でも Assets.load は呼ばれる（#413 の核心の直接検証）', async () => {
    const load = vi
      .spyOn(Assets, 'load')
      .mockResolvedValue(Texture.WHITE as unknown as Awaited<ReturnType<typeof Assets.load>>)
    setInitNeverResolves(true)

    render(<NovelPlayer events={[]} assetBaseUrl="/asset-base" />)
    await flushAsync()

    // このuseEffectが renderer/rendererRef に一切依存しない独立実装で無いと Issue #413 が
    // 再発する: renderer.init() の解決を待ってから先読みを始めると、初回表示に一瞬 ▼
    // フォールバックが挟まる事故（#413 本題）が起きる。renderer.init() は下のアサーションで
    // 呼ばれたことだけ確認する（＝このテストで本当に「init 未解決」状況を作れている証拠）。
    // init() の解決を要件にする別経路（setAssetBaseUrl の [assetBaseUrl] useEffect 配線）は
    // rendererRef.current 自体を init() 完了前から参照するため、ここでは検証対象にしない。
    expect(load).toHaveBeenCalledTimes(8)
    const r = rendererInstances[rendererInstances.length - 1]
    expect(r.init).toHaveBeenCalled()
  })

  it('NP-7: 8URL全てrejectしても例外を投げず console 出力もない', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(Assets, 'load').mockRejectedValue(new Error('404'))

    render(<NovelPlayer events={[]} assetBaseUrl="/asset-base" />)
    await flushAsync()

    expect(warn).not.toHaveBeenCalled()
    expect(error).not.toHaveBeenCalled()
  })

  it('NP-8: 同じ assetBaseUrl で再render しても依存配列により呼び出し回数が増えない', async () => {
    const load = vi
      .spyOn(Assets, 'load')
      .mockResolvedValue(Texture.WHITE as unknown as Awaited<ReturnType<typeof Assets.load>>)

    const { rerender } = render(<NovelPlayer events={[]} assetBaseUrl="/asset-base" />)
    await flushAsync()
    expect(load).toHaveBeenCalledTimes(8)

    rerender(<NovelPlayer events={[]} assetBaseUrl="/asset-base" />)
    await flushAsync()

    expect(load).toHaveBeenCalledTimes(8)
  })
})

// --- #467: letterbox/pillarbox の黒帯（canvas 外）タップで advance させる ---
//
// fluidRootRef（このコンポーネントのルート div、bg-black）に onPointerDown を張り、
// `e.target === e.currentTarget`（黒帯自身への直接タップ）のときだけ
// renderer.handleOutsideCanvasTap() を呼ぶ。canvas 相当の子要素・ボタン類へのタップは
// バブリングで来ても target が子要素のままなので弾かれる（二重発火防止）。
// 実処理（advance相当の前進・各種ガード）は NovelRenderer.outsideCanvasTap.test.ts が担保するので、
// ここでは NovelPlayer 側の「どのタップで呼ぶ/呼ばないか」の配線だけを縛る。
describe('NovelPlayer 黒帯タップで advance (#467)', () => {
  const lastRenderer = () => rendererInstances[rendererInstances.length - 1]
  // fluidRootRef 自身（黒帯部分を含むルート div）。className は NovelPlayer.tsx 内で一意
  // （"...bg-black"。トースト等は "bg-black/70" という別トークンなので衝突しない）。
  const fluidRoot = () => document.querySelector('.bg-black') as HTMLElement
  // canvas を内接させる containerRef の div（黒帯の内側＝canvas 相当の子要素）。
  const canvasBox = () => document.querySelector('.overflow-hidden') as HTMLElement

  it('5: fluidRootRef 自身への pointerdown（target===currentTarget）で handleOutsideCanvasTap が1回呼ばれる', async () => {
    render(<NovelPlayer events={[]} />)
    await flushAsync()

    fireEvent.pointerDown(fluidRoot())

    expect(lastRenderer().handleOutsideCanvasTap).toHaveBeenCalledTimes(1)
  })

  it('6: canvas相当の子要素への pointerdown（バブリング、target≠currentTarget）では呼ばれない', async () => {
    render(<NovelPlayer events={[]} />)
    await flushAsync()

    fireEvent.pointerDown(canvasBox())

    expect(lastRenderer().handleOutsideCanvasTap).not.toHaveBeenCalled()
  })

  it('7: 右上フルスクリーンボタン・右下⚙ボタンへの pointerdown では呼ばれない', async () => {
    render(<NovelPlayer events={[]} skipEnabled={true} debugEnabled={true} />)
    await flushAsync()

    fireEvent.pointerDown(screen.getByRole('button', { name: /フルスクリーン/ }))
    fireEvent.pointerDown(screen.getByRole('button', { name: '設定を開く' }))
    fireEvent.pointerDown(screen.getByRole('button', { name: /オートモードを/ }))
    fireEvent.pointerDown(screen.getByRole('button', { name: /スキップモードを/ }))
    fireEvent.pointerDown(screen.getByRole('button', { name: /デバッグ情報を/ }))

    expect(lastRenderer().handleOutsideCanvasTap).not.toHaveBeenCalled()
  })

  it('8: unmount後（rendererRef.current が null 化した後）に黒帯タップ相当の操作をしても例外を投げない', async () => {
    // rendererRef.current は mount 中は常に非 null（renderer 生成 effect が同期的に代入する）ため、
    // 「マウント済みDOMが残っているのに rendererRef.current だけ null」という状態は通常の
    // レンダーサイクルでは外部から再現できない。unmount 後の cleanup（rendererRef.current = null）
    // が最も近い到達可能な状態であり、かつ NovelPlayer.tsx 側のガードは
    // `rendererRef.current?.handleOutsideCanvasTap()`（optional chaining）そのものなので、
    // unmount 後に検出済みの黒帯 DOM ノードへ改めて pointerdown を投げても例外にならないことを
    // もって安全策の回帰とする（NovelPlayer.test.tsx の NP-5 と同種の割り切り）。
    const { unmount } = render(<NovelPlayer events={[]} />)
    await flushAsync()
    const root = fluidRoot()

    unmount()

    expect(() => fireEvent.pointerDown(root)).not.toThrow()
  })
})

// --- #468: フルスクリーン最大化トグル (RTL、Fullscreen API はモック) ---
//
// jsdom は Fullscreen API を実装していない（Element.prototype.requestFullscreen /
// document.exitFullscreen / document.fullscreenElement が存在しない）。NovelPlayer 側は
// 「対応していれば動く」「無ければ何もしない」の両方を担保する設計のため、テストごとに
// これらを個別にインストールし、afterEach で確実に削除して他テストへ波及させない
// （jsdom 既定＝非対応の状態に戻す）。
describe('NovelPlayer フルスクリーン最大化トグル (#468, Fullscreen API mock)', () => {
  const fullscreenButton = () => screen.getByRole('button', { name: /フルスクリーン/ })

  /**
   * Fullscreen API を実ブラウザに近い挙動でモックする。
   * requestFullscreen()/exitFullscreen() は Promise を返し、resolve 時に
   * document.fullscreenElement を更新してから 'fullscreenchange' を発火する
   * （実ブラウザの「成功後に fullscreenchange が飛ぶ」順序を模す）。
   */
  function installFullscreenMock() {
    let current: Element | null = null
    const setCurrent = (el: Element | null) => {
      current = el
    }
    Object.defineProperty(document, 'fullscreenElement', {
      configurable: true,
      get: () => current,
    })
    const requestFullscreen = vi.fn(function (this: Element) {
      return Promise.resolve().then(() => {
        // `this` は呼び出し元（`el.requestFullscreen()` の el、実際には fluidRootRef.current）。
        // 変数へ代入すると @typescript-eslint/no-this-alias に触れるため、関数呼び出しの引数として渡す。
        setCurrent(this)
        document.dispatchEvent(new Event('fullscreenchange'))
      })
    })
    Object.defineProperty(Element.prototype, 'requestFullscreen', {
      configurable: true,
      writable: true,
      value: requestFullscreen,
    })
    const exitFullscreen = vi.fn(() => {
      return Promise.resolve().then(() => {
        current = null
        document.dispatchEvent(new Event('fullscreenchange'))
      })
    })
    Object.defineProperty(document, 'exitFullscreen', {
      configurable: true,
      writable: true,
      value: exitFullscreen,
    })
    return {
      requestFullscreen,
      exitFullscreen,
      setCurrent,
    }
  }

  afterEach(() => {
    delete (Element.prototype as { requestFullscreen?: unknown }).requestFullscreen
    delete (document as { exitFullscreen?: unknown }).exitFullscreen
    delete (document as { fullscreenElement?: unknown }).fullscreenElement
  })

  /** Fullscreen Promise の resolve/reject は微小タスク経由なので複数 tick flush する。 */
  async function flushMicrotasks() {
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })
  }

  it('9: 初期状態は isFullscreen=false（aria-pressed=false）、aria-label は「フルスクリーンで表示する」', async () => {
    render(<NovelPlayer events={[]} />)
    await flushAsync()
    const btn = fullscreenButton()
    expect(btn.getAttribute('aria-pressed')).toBe('false')
    expect(btn).toHaveAttribute('aria-label', 'フルスクリーンで表示する')
  })

  it('10: ボタンクリックで requestFullscreen() が呼ばれ、fullscreenchange 発火後に isFullscreen=true・aria-label が切り替わる', async () => {
    const { requestFullscreen } = installFullscreenMock()
    render(<NovelPlayer events={[]} />)
    await flushAsync()
    const btn = fullscreenButton()

    await act(async () => {
      btn.click()
    })
    await flushMicrotasks()

    expect(requestFullscreen).toHaveBeenCalledTimes(1)
    expect(btn.getAttribute('aria-pressed')).toBe('true')
    expect(btn).toHaveAttribute('aria-label', 'フルスクリーンを解除する')
  })

  it('11: フルスクリーン中にクリックで exitFullscreen() が呼ばれ、fullscreenchange 発火後に false へ戻る', async () => {
    const { exitFullscreen } = installFullscreenMock()
    render(<NovelPlayer events={[]} />)
    await flushAsync()
    const btn = fullscreenButton()

    await act(async () => {
      btn.click() // enter
    })
    await flushMicrotasks()
    expect(btn.getAttribute('aria-pressed')).toBe('true')

    await act(async () => {
      btn.click() // exit
    })
    await flushMicrotasks()

    expect(exitFullscreen).toHaveBeenCalledTimes(1)
    expect(btn.getAttribute('aria-pressed')).toBe('false')
    expect(btn).toHaveAttribute('aria-label', 'フルスクリーンで表示する')
  })

  it('12: requestFullscreen() が reject する Promise を返す場合、isFullscreen は false のまま・unhandled rejection にならない', async () => {
    const { requestFullscreen } = installFullscreenMock()
    requestFullscreen.mockImplementation(() => Promise.reject(new Error('denied')))
    render(<NovelPlayer events={[]} />)
    await flushAsync()
    const btn = fullscreenButton()

    // catch されず伝播すれば vitest が unhandled rejection として検出しテストが落ちる。
    await act(async () => {
      btn.click()
    })
    await flushMicrotasks()

    expect(btn.getAttribute('aria-pressed')).toBe('false')
  })

  it('13: requestFullscreen が同期的に例外を投げても try/catch で握りつぶされコンポーネントは壊れない', async () => {
    const { requestFullscreen } = installFullscreenMock()
    requestFullscreen.mockImplementation(() => {
      throw new Error('blocked by permissions policy')
    })
    render(<NovelPlayer events={[]} />)
    await flushAsync()
    const btn = fullscreenButton()

    expect(() => {
      act(() => {
        btn.click()
      })
    }).not.toThrow()

    expect(btn.getAttribute('aria-pressed')).toBe('false')
    // コンポーネントが壊れていないこと（同ボタンが引き続き存在・操作可能）の確認。
    expect(fullscreenButton()).toBeInTheDocument()
  })

  it('14: el.requestFullscreen が undefined（非対応ブラウザ）のとき、クリックしても例外が出ない', async () => {
    // このテストだけは installFullscreenMock() を呼ばない。jsdom は Fullscreen API を実装しないため、
    // Element.prototype.requestFullscreen は既定で undefined＝実ブラウザの非対応ケースと同型。
    render(<NovelPlayer events={[]} />)
    await flushAsync()
    const btn = fullscreenButton()

    expect(() => {
      act(() => {
        btn.click()
      })
    }).not.toThrow()

    expect(btn.getAttribute('aria-pressed')).toBe('false')
  })

  it('15: document.fullscreenElement が自分の fluidRootRef ではない別要素のとき、isFullscreen は false のまま（=== 厳密比較）', async () => {
    const { setCurrent } = installFullscreenMock()
    render(<NovelPlayer events={[]} />)
    await flushAsync()

    // fluidRootRef 以外の要素（document.body）が fullscreenElement になったケースを模す
    // （別の UI が独自にフルスクリーン化した等）。
    setCurrent(document.body)
    act(() => {
      document.dispatchEvent(new Event('fullscreenchange'))
    })

    expect(fullscreenButton().getAttribute('aria-pressed')).toBe('false')
  })

  it('16: コンポーネント unmount 時に fullscreenchange リスナーが removeEventListener される（unmount後 dispatch でエラーが出ない）', async () => {
    installFullscreenMock()
    const removeSpy = vi.spyOn(document, 'removeEventListener')
    const { unmount } = render(<NovelPlayer events={[]} />)
    await flushAsync()

    unmount()

    expect(removeSpy).toHaveBeenCalledWith('fullscreenchange', expect.any(Function))
    expect(() => {
      document.dispatchEvent(new Event('fullscreenchange'))
    }).not.toThrow()
  })

  it('17: document.fullscreenElement が別要素のときにボタンをクリックすると、他要素の exitFullscreen を呼ばず自分の要素へ requestFullscreen を試みる（=== 厳密比較の分岐）', async () => {
    const { requestFullscreen, exitFullscreen, setCurrent } = installFullscreenMock()
    render(<NovelPlayer events={[]} />)
    await flushAsync()

    // fluidRootRef 以外の要素（document.body）が既にフルスクリーン中の状態を模す
    // （ホストページの別ウィジェット等が独自にフルスクリーン化しているケース）。
    setCurrent(document.body)
    act(() => {
      document.dispatchEvent(new Event('fullscreenchange'))
    })
    const btn = fullscreenButton()
    expect(btn.getAttribute('aria-pressed')).toBe('false')

    await act(async () => {
      btn.click()
    })
    await flushMicrotasks()

    // truthy チェックのみだと document.fullscreenElement（=document.body）を「自分がフルスクリーン中」
    // と誤認し、他要素の exitFullscreen() を呼んでしまう（意図と逆の副作用）。ここでは呼ばれないこと、
    // 代わりに自分の要素へ requestFullscreen() が試みられることを確認する。
    expect(exitFullscreen).not.toHaveBeenCalled()
    expect(requestFullscreen).toHaveBeenCalledTimes(1)
    // モック実装は resolve 時に this（呼び出し元＝fluidRootRef.current）を新しい fullscreenElement に
    // するため、自分がフルスクリーンになったこと（aria-pressed=true）まで確認できる。
    expect(btn.getAttribute('aria-pressed')).toBe('true')
  })

  // --- #468 セルフレビュー指摘: 状態遷移ロジック（余韻タイマー・data-dir導出）のテストが
  // 不足していたため追加。参考: SeekBar.test.ts B-6/B-7（同じ INACTIVITY_MS 境界パターン）。
  // フルスクリーンAPI自体の遷移（enter/exit）は 9〜17 で担保済みなので、ここでは
  // fsToggleActive（nn-fs-toggle--active クラス）と data-dir の導出だけを縛る。

  it('18: pointerdownで即座にnn-fs-toggle--active（濃い表示）が付く', async () => {
    render(<NovelPlayer events={[]} />)
    await flushAsync()
    const btn = fullscreenButton()
    expect(btn.className).not.toContain('nn-fs-toggle--active')

    act(() => {
      fireEvent.pointerDown(btn)
    })

    expect(btn.className).toContain('nn-fs-toggle--active')
  })

  it('19: focusでも同様にnn-fs-toggle--active（濃い表示）が付く', async () => {
    render(<NovelPlayer events={[]} />)
    await flushAsync()
    const btn = fullscreenButton()
    expect(btn.className).not.toContain('nn-fs-toggle--active')

    act(() => {
      fireEvent.focus(btn)
    })

    expect(btn.className).toContain('nn-fs-toggle--active')
  })

  it('20: activate後 INACTIVITY_MS-1 の経過ではまだactiveのまま（境界未満）', async () => {
    vi.useFakeTimers()
    try {
      render(<NovelPlayer events={[]} />)
      await flushAsync()
      const btn = fullscreenButton()

      act(() => {
        fireEvent.pointerDown(btn)
      })
      act(() => {
        vi.advanceTimersByTime(INACTIVITY_MS - 1)
      })

      expect(btn.className).toContain('nn-fs-toggle--active')
    } finally {
      vi.useRealTimers()
    }
  })

  it('21: activate後 INACTIVITY_MS ちょうどの経過で自動的にinactive（薄い表示）へ戻る', async () => {
    vi.useFakeTimers()
    try {
      render(<NovelPlayer events={[]} />)
      await flushAsync()
      const btn = fullscreenButton()

      act(() => {
        fireEvent.pointerDown(btn)
      })
      act(() => {
        vi.advanceTimersByTime(INACTIVITY_MS)
      })

      expect(btn.className).not.toContain('nn-fs-toggle--active')
    } finally {
      vi.useRealTimers()
    }
  })

  it('22: isFullscreen=false のとき data-dir="expand"', async () => {
    render(<NovelPlayer events={[]} />)
    await flushAsync()
    const btn = fullscreenButton()

    expect(btn.getAttribute('data-dir')).toBe('expand')
  })

  it('23: isFullscreen=true のとき data-dir="collapse"', async () => {
    installFullscreenMock()
    render(<NovelPlayer events={[]} />)
    await flushAsync()
    const btn = fullscreenButton()

    await act(async () => {
      btn.click()
    })
    await flushMicrotasks()

    expect(btn.getAttribute('data-dir')).toBe('collapse')
  })

  it('24: unmount時に余韻タイマーがクリアされる（unmount後にタイマー期限が来てもconsole.errorが出ない・回帰）', async () => {
    vi.useFakeTimers()
    try {
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      const { unmount } = render(<NovelPlayer events={[]} />)
      await flushAsync()
      const btn = fullscreenButton()

      act(() => {
        fireEvent.pointerDown(btn)
      })

      unmount()

      // クリアされていなければ、unmount 後の setFsToggleActive(false) が
      // 「unmounted component への state 更新」として console.error（React 警告）を出す。
      expect(() => {
        act(() => {
          vi.advanceTimersByTime(INACTIVITY_MS)
        })
      }).not.toThrow()
      expect(errSpy).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })
})

// --- #628 フェーズ2b: タイトル画面 showTitleScreen/hideTitleScreen 呼び出しの race 条件回帰テスト ---
//
// 実機検証で発覚したバグ#2（rendererReady 宣言部の JSDoc・NovelPlayer.tsx 参照）: `titleScreen`
// 表示 effect が `rendererRef.current` の truthy だけを見て `renderer.init().then(...)` の解決を
// 待たずに `showTitleScreen()` を呼ぶと、`characterLayer.showImage()` が空の assetBaseUrl で
// ロゴ画像を要求して失敗し、しかも `showImage` の同 id 再表示（`existing` 分岐）はテクスチャを
// 再ロードしないため、後から正しい assetBaseUrl で呼び直しても手遅れになる。
// 修正は `rendererReady`（init().then() 解決後に true になる React state）を待ってから
// showTitleScreen()/hideTitleScreen() を呼ぶ設計。ここではその race 条件そのものを固定する。
//
// 駆動: setInitDeferred(true) で render() 前に MockRenderer.init() を「明示的に
// resolvePendingInit() を呼ぶまで pending のまま」にし、init() 未解決の間の挙動と
// 解決直後の挙動を分離して検証する（#413 の setInitNeverResolves と姉妹関係、あちらは
// 「永久に解決しない」、こちらは「任意タイミングで解決できる」）。
//
// もう一段の懸念（NovelPlayer.tsx effect 本体のコメント参照）: `titleScreen` オブジェクト自体は
// 呼び出し側（PlayerScreen）が毎レンダー新しいクロージャで作り直しうるため、effect の依存配列は
// 「非 null かどうか」「title」「hasSaveData」「dark」「rendererReady」だけに絞ってあり、コールバック
// の参照同一性の変化では再実行されない設計になっている（無限ループ防止）。TC43 がこれを直接縛る。
describe('NovelPlayer タイトル画面 showTitleScreen/hideTitleScreen race条件・再実行ガード (#628 フェーズ2b)', () => {
  const lastRenderer = () => rendererInstances[rendererInstances.length - 1]

  function makeTitleScreenProp(overrides?: {
    title?: string
    hasSaveData?: boolean
    onNewGame?: () => void
    onContinue?: () => void
    onOpenSettings?: () => void
    onBack?: () => void
  }) {
    return {
      title: overrides?.title ?? 'タイトル',
      hasSaveData: overrides?.hasSaveData ?? false,
      onNewGame: overrides?.onNewGame ?? vi.fn(),
      onContinue: overrides?.onContinue ?? vi.fn(),
      onOpenSettings: overrides?.onOpenSettings ?? vi.fn(),
      onBack: overrides?.onBack ?? vi.fn(),
    }
  }

  it('TC38: renderer.init() が未解決の間は titleScreen prop を渡してマウントしても showTitleScreen は呼ばれない', async () => {
    setInitDeferred(true)
    render(<NovelPlayer events={[]} titleScreen={makeTitleScreenProp()} />)
    await flushAsync()

    expect(lastRenderer().showTitleScreen).not.toHaveBeenCalled()
  })

  it('TC39: TC38 の続き — init() の Promise を resolve すると showTitleScreen が初めて1回呼ばれる', async () => {
    setInitDeferred(true)
    render(<NovelPlayer events={[]} titleScreen={makeTitleScreenProp()} />)
    await flushAsync()
    expect(lastRenderer().showTitleScreen).not.toHaveBeenCalled()

    await act(async () => {
      resolvePendingInit()
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(lastRenderer().showTitleScreen).toHaveBeenCalledTimes(1)
  })

  it('TC40: titleScreen prop が null のままマウント（deep-linkモード相当）— rendererReady到達後も showTitleScreen は呼ばれず hideTitleScreen のみ呼ばれる', async () => {
    render(<NovelPlayer events={[]} titleScreen={null} />)
    await flushAsync()

    expect(lastRenderer().showTitleScreen).not.toHaveBeenCalled()
    expect(lastRenderer().hideTitleScreen).toHaveBeenCalled()
  })

  it('TC41: マウント後に titleScreen prop を null へ変更すると hideTitleScreen が呼ばれる', async () => {
    const { rerender } = render(<NovelPlayer events={[]} titleScreen={makeTitleScreenProp()} />)
    await flushAsync()
    const r = lastRenderer()
    expect(r.showTitleScreen).toHaveBeenCalledTimes(1)
    expect(r.hideTitleScreen).not.toHaveBeenCalled()

    rerender(<NovelPlayer events={[]} titleScreen={null} />)
    await flushAsync()

    expect(r.hideTitleScreen).toHaveBeenCalledTimes(1)
  })

  it('TC42: rendererReady到達後、titleScreen.title だけを変更した再レンダーで showTitleScreen が再度呼ばれる', async () => {
    const { rerender } = render(
      <NovelPlayer events={[]} titleScreen={makeTitleScreenProp({ title: 'A' })} />
    )
    await flushAsync()
    const r = lastRenderer()
    expect(r.showTitleScreen).toHaveBeenCalledTimes(1)

    rerender(<NovelPlayer events={[]} titleScreen={makeTitleScreenProp({ title: 'B' })} />)
    await flushAsync()

    expect(r.showTitleScreen).toHaveBeenCalledTimes(2)
  })

  it('TC43: rendererReady到達後、onNewGame等コールバックの参照だけを変えた再レンダーでは showTitleScreen は再度呼ばれない（無限ループ防止の設計確認）', async () => {
    const { rerender } = render(
      <NovelPlayer
        events={[]}
        titleScreen={makeTitleScreenProp({ title: 'A', hasSaveData: false })}
      />
    )
    await flushAsync()
    const r = lastRenderer()
    expect(r.showTitleScreen).toHaveBeenCalledTimes(1)

    // title/hasSaveData/dark は不変のまま、コールバックの参照だけを新しくする
    // （PlayerScreen が毎レンダー新しいクロージャで titleScreen オブジェクトを作り直す想定と同形）。
    rerender(
      <NovelPlayer
        events={[]}
        titleScreen={makeTitleScreenProp({
          title: 'A',
          hasSaveData: false,
          onNewGame: vi.fn(),
          onContinue: vi.fn(),
          onOpenSettings: vi.fn(),
          onBack: vi.fn(),
        })}
      />
    )
    await flushAsync()

    expect(r.showTitleScreen).toHaveBeenCalledTimes(1)
  })
})
