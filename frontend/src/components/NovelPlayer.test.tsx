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
import { act, render, screen } from '@testing-library/react'
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
    setCharacterYRatio = vi.fn()
    setCharacterHeightRatio = vi.fn()
    setCharacterHeightRatios = vi.fn()
    setCharacterScale = vi.fn()
    setCharacterFadeMs = vi.fn()
    setBackgroundFadeMs = vi.fn()
    setDefaultBackgroundColor = vi.fn()
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
