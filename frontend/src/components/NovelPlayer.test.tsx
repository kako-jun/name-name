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
import { getIndicatorImageUrls } from '../game/novelLayout'

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
const { rendererInstances, MockRenderer, setInitNeverResolves } = vi.hoisted(() => {
  const instances: MockRenderer[] = []
  let initNeverResolves = false
  class MockRenderer {
    init = vi.fn(() =>
      initNeverResolves ? new Promise<void>(() => {}) : Promise.resolve(undefined)
    )
    destroy = vi.fn()
    setAssetBaseUrl = vi.fn()
    setOnAutoModeChange = vi.fn()
    setOnSkipModeChange = vi.fn()
    setOnSeekActiveChange = vi.fn()
    setOnStoryEndedChange = vi.fn()
    setConfinedSceneIds = vi.fn()
    setDocKey = vi.fn()
    setChoiceStyle = vi.fn()
    setFontFamily = vi.fn()
    setFontSize = vi.fn()
    setDialogStyle = vi.fn()
    setProtagonist = vi.fn()
    setSpeakerNudge = vi.fn()
    setSplitLayout = vi.fn()
    setSentencePerPage = vi.fn()
    setCharacterYRatio = vi.fn()
    setCharacterHeightRatio = vi.fn()
    setCharacterHeightRatios = vi.fn()
    setCharacterScale = vi.fn()
    setCharacterFadeMs = vi.fn()
    setBackgroundFadeMs = vi.fn()
    setEventImageFadeMs = vi.fn()
    setDefaultBackgroundColor = vi.fn()
    setSeekBarColor = vi.fn()
    setIntermissionScene = vi.fn()
    hasIntermissionScene = vi.fn().mockReturnValue(false)
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
    playScript = vi.fn().mockResolvedValue(undefined)
    quickSave = vi.fn().mockReturnValue(false)
    quickLoad = vi.fn().mockReturnValue(false)
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
describe('NovelPlayer `?scene=` ディープリンク + confinement + 終劇表示 (#386)', () => {
  const lastRenderer = () => rendererInstances[rendererInstances.length - 1]
  const storyEndedText = () => screen.queryByText('to be continued...')

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

  it('G6: mount 直後（onStoryEndedChange 未発火）は "to be continued..." が現れない', async () => {
    render(<NovelPlayer events={[]} />)
    await flushAsync()
    expect(storyEndedText()).toBeNull()
  })

  it('G7: onStoryEndedChange(true) が発火した時だけ "to be continued..." が表示される', async () => {
    render(<NovelPlayer events={[]} />)
    await flushAsync()
    const cb = lastRenderer().setOnStoryEndedChange.mock.calls[0][0] as (ended: boolean) => void
    act(() => cb(true))
    expect(storyEndedText()).not.toBeNull()
  })

  it('G8: onStoryEndedChange(false) では "to be continued..." は現れない', async () => {
    render(<NovelPlayer events={[]} />)
    await flushAsync()
    const cb = lastRenderer().setOnStoryEndedChange.mock.calls[0][0] as (ended: boolean) => void
    act(() => cb(false))
    expect(storyEndedText()).toBeNull()
  })

  it('G9: onStoryEndedChange(true) の後に false で発火し直すと "to be continued..." が消える', async () => {
    render(<NovelPlayer events={[]} />)
    await flushAsync()
    const cb = lastRenderer().setOnStoryEndedChange.mock.calls[0][0] as (ended: boolean) => void
    act(() => cb(true))
    expect(storyEndedText()).not.toBeNull()
    act(() => cb(false))
    expect(storyEndedText()).toBeNull()
  })

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

// --- #404: 終劇表示中の埋め込み元プロジェクトロゴ ---
//
// storyEnded 中、左上に `${assetBaseUrl}/images/title.png` を表示する。TitleOverlay の
// imageFailed と同じ onError 検知パターンだが、こちらはテキストへのフォールバックをしない
// （ロゴが無ければ単に出さない）。表示条件は `assetBaseUrl && !storyEndedLogoFailed`、
// storyEndedLogoFailed は onError で true になり、docKey 変化でだけ false にリセットされる。
//
// 非適用（書かない）: 権限/二重送信/race（該当ロジックなし）/ タイムゾーン・i18n（該当なし）/
//   モバイル表示（jsdom にレイアウトエンジンがなく単体テスト不可。ライブ確認は別途）/
//   console error ログ（TitleOverlay と同一パターンで既に許容されている慣習）。
describe('NovelPlayer 終劇ロゴ表示 (#404)', () => {
  const ASSET_BASE = '/asset-base'
  const LOGO_SRC = `${ASSET_BASE}/images/title.png`
  const capturedStoryEndedCb = (): ((ended: boolean) => void) => {
    const r = rendererInstances[rendererInstances.length - 1]
    return r.setOnStoryEndedChange.mock.calls[0][0] as (ended: boolean) => void
  }
  // alt="" の img は role が potentially presentation 扱いになるため getByRole は使わず、
  // src 属性で直接引く（テスト設計メモの推奨どおり）。
  const logoImg = () => document.querySelector(`img[src="${LOGO_SRC}"]`) as HTMLImageElement | null
  const storyEndedText = () => screen.queryByText('to be continued...')

  it('L1: storyEnded=true かつ assetBaseUrl 指定時、ロゴ img が表示される', async () => {
    render(<NovelPlayer events={[]} assetBaseUrl={ASSET_BASE} />)
    await flushAsync()
    act(() => capturedStoryEndedCb()(true))
    expect(logoImg()).not.toBeNull()
  })

  it('L2: storyEnded=true かつ assetBaseUrl 未指定時、ロゴ img は現れず "to be continued..." は表示される', async () => {
    render(<NovelPlayer events={[]} />)
    await flushAsync()
    act(() => capturedStoryEndedCb()(true))
    expect(logoImg()).toBeNull()
    expect(storyEndedText()).not.toBeNull()
  })

  it('L3: img の onError 発火後、ロゴ img がDOMから消え、テキストへのフォールバックは無い（TitleOverlay と異なる仕様）', async () => {
    render(<NovelPlayer events={[]} assetBaseUrl={ASSET_BASE} />)
    await flushAsync()
    act(() => capturedStoryEndedCb()(true))
    const img = logoImg()
    expect(img).not.toBeNull()
    act(() => {
      fireEvent.error(img!)
    })
    expect(logoImg()).toBeNull()
    // ロゴが消えた後も他の img（フォールバック画像）に差し替わっていない
    expect(document.querySelectorAll('img').length).toBe(0)
    // "to be continued..." テキストはロゴの成否と無関係に表示され続ける
    expect(storyEndedText()).not.toBeNull()
  })

  it('L4: assetBaseUrl="" のとき、ロゴは表示されない（境界: 空文字も未設定扱い）', async () => {
    render(<NovelPlayer events={[]} assetBaseUrl="" />)
    await flushAsync()
    act(() => capturedStoryEndedCb()(true))
    expect(logoImg()).toBeNull()
  })

  it('L5: onError 発火後、docKey が変化すると再びロゴが表示される（別プロジェクト再利用の想定）', async () => {
    const { rerender } = render(
      <NovelPlayer events={[]} assetBaseUrl={ASSET_BASE} docKey="doc-a" />
    )
    await flushAsync()
    act(() => capturedStoryEndedCb()(true))
    const img = logoImg()
    expect(img).not.toBeNull()
    act(() => {
      fireEvent.error(img!)
    })
    expect(logoImg()).toBeNull()

    rerender(<NovelPlayer events={[]} assetBaseUrl={ASSET_BASE} docKey="doc-b" />)
    await flushAsync()
    expect(logoImg()).not.toBeNull()
  })

  it('L6: onError 発火後、docKey が同一値のまま storyEnded を false→true にしてもロゴは再表示されない（フラグが尾を引く）', async () => {
    render(<NovelPlayer events={[]} assetBaseUrl={ASSET_BASE} docKey="doc-a" />)
    await flushAsync()
    const cb = capturedStoryEndedCb()
    act(() => cb(true))
    const img = logoImg()
    expect(img).not.toBeNull()
    act(() => {
      fireEvent.error(img!)
    })
    expect(logoImg()).toBeNull()

    act(() => cb(false))
    act(() => cb(true))
    expect(logoImg()).toBeNull()
  })
})

// #404 フェーズ2: intermission.md 専用シーンの renderer 配線 + usedIntermissionScene の
// race 固定化（デシジョンテーブル行6/7の直接証明）。
//
// usedIntermissionScene は「storyEnded が true に立ち上がった瞬間の renderer.hasIntermissionScene()」
// を1回だけスナップショットし、以後 intermissionEvents prop が変化してもライブ再評価しない設計
// （早すぎる fetch で intermission がまだ届いていない場合、後から届いても DOM フォールバック表示が
// 消えない＝「同時に消えるだけの空白画面」を避けるための意図的な仕様。session ノート参照）。
describe('NovelPlayer intermission.md 専用シーン配線 (#404 フェーズ2)', () => {
  const lastRenderer = () => rendererInstances[rendererInstances.length - 1]
  const storyEndedText = () => screen.queryByText('to be continued...')
  const captureCb = (): ((ended: boolean) => void) =>
    lastRenderer().setOnStoryEndedChange.mock.calls[0][0] as (ended: boolean) => void
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

  it('NP-IM-3 (race・最重要): storyEnded=true 発火時に hasIntermissionScene()=false だと、後から intermissionEvents が届いても usedIntermissionScene は false のまま固定される（デシジョンテーブル行7）', async () => {
    const { rerender } = render(<NovelPlayer events={[]} intermissionEvents={null} />)
    await flushAsync()
    const r = lastRenderer()
    r.hasIntermissionScene.mockReturnValue(false) // 早すぎる fetch: intermission はまだ未到着
    act(() => captureCb()(true))
    expect(storyEndedText()).not.toBeNull() // DOM フォールバックが表示される

    // intermission が遅れて届く（PlayerScreen の非同期 fetch 解決）。
    // hasIntermissionScene を true に切り替えても、usedIntermissionScene は再評価しない
    // （storyEnded の再発火が無い限りスナップショットは更新されない）。
    r.hasIntermissionScene.mockReturnValue(true)
    rerender(<NovelPlayer events={[]} intermissionEvents={EV1} />)
    await flushAsync()
    expect(storyEndedText()).not.toBeNull() // 表示され続ける（消えない）
  })

  it('NP-IM-4 (対照系): intermissionEvents を先に非空にしてから hasIntermissionScene()=true で storyEnded 発火すると usedIntermissionScene=true で DOM 非表示になる', async () => {
    render(<NovelPlayer events={[]} intermissionEvents={EV1} />)
    await flushAsync()
    const r = lastRenderer()
    r.hasIntermissionScene.mockReturnValue(true)

    act(() => captureCb()(true))

    expect(storyEndedText()).toBeNull()
  })

  it('NP-IM-5: onStoryEndedChange(true)→(false)（goBack 相当）で usedIntermissionScene が false に戻る（再評価は次の true 発火時）', async () => {
    render(<NovelPlayer events={[]} intermissionEvents={EV1} />)
    await flushAsync()
    const r = lastRenderer()
    const cb = captureCb()

    r.hasIntermissionScene.mockReturnValue(true)
    act(() => cb(true))
    expect(storyEndedText()).toBeNull() // usedIntermissionScene=true → DOM 非表示

    act(() => cb(false)) // goBack 相当。ended=false なので usedIntermissionScene も false に戻る
    expect(storyEndedText()).toBeNull() // storyEnded=false 自体で非表示（この時点では区別不可）

    // usedIntermissionScene が「true に固定されたまま」ではなく実際に false へ戻っていることを、
    // hasIntermissionScene を false に切り替えてから再度 true 発火して確認する
    // （固定されたままなら hasIntermissionScene の変更を無視して非表示のままになるはず）。
    r.hasIntermissionScene.mockReturnValue(false)
    act(() => cb(true))
    expect(storyEndedText()).not.toBeNull() // 新しい判定 (true && false) が効いて表示される
  })

  it('NP-IM-6 (二重表示防止): usedIntermissionScene=true のとき "to be continued..." のブロック自体が DOM ツリーに存在しない（ロゴ img も含む）', async () => {
    render(<NovelPlayer events={[]} intermissionEvents={EV1} assetBaseUrl="/asset-base" />)
    await flushAsync()
    const r = lastRenderer()
    r.hasIntermissionScene.mockReturnValue(true)

    act(() => captureCb()(true))

    expect(storyEndedText()).toBeNull()
    // storyEnded && !usedIntermissionScene で丸ごと JSX ツリーから外れる（CSS 非表示ではない）ので、
    // 同じブロック内にあるロゴ img も一緒に消えている。
    expect(document.querySelector('img[src="/asset-base/images/title.png"]')).toBeNull()
  })
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
