/**
 * SaveController（クイックセーブ・自動セーブ・セーブ/ロードメニュー・ロード通知）の単体テスト (#827, #735 6/8)。
 *
 * `NovelRenderer` は import しない（Pixi・DOM に依存しないことの確認も兼ねる）。Host は軽いモック1つで、
 * `SceneIndex` / `TransitionState` / `PlaybackCursor` / `SaveManager`（jsdom の localStorage）は実物を使う。
 *
 * 切り出し前の `NovelRenderer`（`origin/main`）の `quickSave` / `saveQuick` / `flushAutoSave` / `quickLoad` /
 * `openSaveMenu` / `openLoadMenu` の分岐を、文面でなく「終劇 × 遷移ゲートの組合せ × 本文位置 × 手動/自動」の
 * 表として写した数行を「リファレンス」として末尾近くに置き、全組合せで突き合わせる（doctrine 規律3）。
 * リファレンスは Controller のコードも `gateReason` も呼ばず、ゲートの優先順位（入場中 > Jump 予約中 > 選択肢/待機）を
 * フラグの真偽から自前で書く。期待値にも定数計算（gameStateToSaveSlot 等）を持ち込まない。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Event, EventScene } from '../types'
import { GameState, type BackgroundFade, type NovelGameState } from './GameState'
import { PlaybackCursor } from './PlaybackCursor'
import { SaveController, type SaveHost, type SaveMenuView } from './SaveController'
import { SaveManager, type SaveSlotData } from './SaveManager'
import { SceneIndex } from './SceneIndex'
import { TimeController } from './TimeController'
import { TransitionState } from './TransitionState'
import { buildFreshPositionState } from './freshState'
import type { LoadOrigin, SceneEntryRequest, SceneEntryResult } from './sceneEntry'

// ---------------------------------------------------------------------------
// fixture
// ---------------------------------------------------------------------------
const narr = (...lines: string[]): Event => ({ Narration: { text: lines } })
const bg = (path: string): Event => ({ Background: { path } }) as unknown as Event
const scene = (id: string, title: string): EventScene => ({
  id,
  title,
  view: 'TopDown',
  events: [narr(id)],
})

/** index 0 は本文でない（背景）、1 と 2 は本文。 */
const EVENTS: Event[] = [bg('a.png'), narr('a1'), narr('a2')]
const NON_TEXT = 0
const TEXT = 1

const FIXED_NOW = '2026-10-15T01:02:03.000Z'

const SNAPSHOT: NovelGameState = {
  ...buildFreshPositionState('a', { eventIndex: TEXT, textIndex: 0 }, { seen: { Bool: true } }),
  backgroundPath: 'a.png',
  currentBgmPath: 'bgm.ogg',
}

type RestoreRequest = Extract<SceneEntryRequest, { kind: 'restore'; source: 'save' }>
const ENTERED: SceneEntryResult = { status: 'entered', sceneId: 'a' }

interface Gate {
  choice: boolean
  wait: boolean
  jump: 'idle' | 'pending' | 'stalled'
  entry: boolean
}
const OPEN: Gate = { choice: false, wait: false, jump: 'idle', entry: false }

interface Setup {
  ctrl: SaveController
  transition: TransitionState
  cursor: PlaybackCursor
  sceneIndex: SceneIndex
  host: HostMock
  state: { storyEnded: boolean; playhead: string | null; snapshot: NovelGameState }
  toasts: string[]
  /** Host 呼び出しの時系列。 */
  order: string[]
  fade: BackgroundFade
  /** 保存の実体（コントローラ内部のものと同じ localStorage を読む別インスタンス）。 */
  store: SaveManager
  setGate(g: Partial<Gate>): void
  setPosition(index: number): void
}
type HostMock = {
  [K in keyof SaveHost]: ReturnType<typeof vi.fn> & SaveHost[K]
}

function setup(): Setup {
  localStorage.clear() // 全組合せテストが1ケース内で setup を繰り返すので、保存先を毎回空にする
  const time = new TimeController()
  time.setMode('virtual')
  const transition = new TransitionState(time, () => {})
  const sceneIndex = new SceneIndex()
  sceneIndex.setJumpSceneIndex([scene('a', 'タイトルA'), scene('b', 'タイトルB')])
  const cursor = new PlaybackCursor()
  cursor.load(EVENTS, new GameState(), TEXT)
  const state = { storyEnded: false, playhead: 'a' as string | null, snapshot: SNAPSHOT }
  const toasts: string[] = []
  const order: string[] = []
  const fade = { side: 'left', size: 0.25 } as unknown as BackgroundFade
  const host = {
    getSnapshot: vi.fn(() => state.snapshot),
    isStoryEnded: vi.fn(() => state.storyEnded),
    getPlayheadSceneId: vi.fn(() => state.playhead),
    showToast: vi.fn((m: string) => {
      toasts.push(m)
    }),
    ensureAudioContext: vi.fn(() => {
      order.push('ensureAudioContext')
    }),
    normalizeBackgroundFade: vi.fn((_f: SaveSlotData['backgroundFade']) => {
      order.push('normalizeBackgroundFade')
      return fade
    }),
    enter: vi.fn((_r: SceneEntryRequest) => {
      order.push('enter')
      return Promise.resolve(ENTERED)
    }),
  } as unknown as HostMock
  const ctrl = new SaveController(host, sceneIndex, transition, cursor)
  const never = new Promise<SceneEntryResult>(() => {})
  return {
    ctrl,
    transition,
    cursor,
    sceneIndex,
    host,
    state,
    toasts,
    order,
    fade,
    store: new SaveManager(),
    setGate(g) {
      const gate = { ...OPEN, ...g }
      if (gate.choice) transition.enterChoiceWait()
      if (gate.wait) transition.enterWait()
      if (gate.jump !== 'idle') {
        transition.arm('zz', {
          isActive: () => true,
          warnChainLimit: () => {},
          enter: () => never,
        })
        if (gate.jump === 'stalled') {
          // 実際の停止は、発火したタイマーが pendingEntry を下ろしてから stall する（TransitionState.arm）。
          transition.stall()
          transition.clearPendingEntry()
        }
      }
      if (gate.entry) {
        transition.setPendingEntry({
          generation: 99,
          kind: 'progress',
          sceneId: 'x',
          promise: never,
        })
      }
    },
    setPosition(index) {
      cursor.load(EVENTS, new GameState(), index)
    },
  }
}

function restoreReq(s: Setup): RestoreRequest {
  return s.host.enter.mock.calls[0][0] as RestoreRequest
}

beforeEach(() => {
  localStorage.clear()
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(FIXED_NOW))
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  localStorage.clear()
})

const MSG = {
  saveBlocked: 'この場面ではセーブできません',
  saveTransition: '場面転換中のためセーブできません',
  saveOk: 'クイックセーブしました',
  loadBlocked: 'この場面ではロードできません',
  loadTransition: '場面転換中のためロードできません',
  loadNoData: 'クイックセーブデータがありません',
  loadOk: 'クイックロードしました',
  loadFail: 'ロードに失敗しました',
} as const

// ---------------------------------------------------------------------------
// 手動クイックセーブ: 拒否とトースト
// ---------------------------------------------------------------------------
describe('quickSave: ゲート別の拒否とトースト', () => {
  const cases: Array<[string, Partial<Gate>, string]> = [
    ['選択肢待ち', { choice: true }, MSG.saveBlocked],
    ['[待機] 中', { wait: true }, MSG.saveBlocked],
    ['停止中（stalled）の Jump', { jump: 'stalled' }, MSG.saveBlocked],
    ['Jump 予約中', { jump: 'pending' }, MSG.saveTransition],
    ['入場中', { entry: true }, MSG.saveTransition],
  ]

  it.each(cases)('%s: 手動は理由に合った文言で false・保存しない、自動は無言', (_n, gate, msg) => {
    const s = setup()
    s.setGate(gate)
    expect(s.ctrl.quickSave()).toBe(false)
    expect(s.toasts).toEqual([msg])
    expect(s.store.hasQuickSave()).toBe(false)
    expect(s.host.getSnapshot).not.toHaveBeenCalled()

    // 自動（requestAutoSave）は同じゲートで無言・保存しない
    s.toasts.length = 0
    s.ctrl.requestAutoSave()
    expect(s.toasts).toEqual([])
    expect(s.store.hasQuickSave()).toBe(false)
  })

  it('終劇後: 手動は「この場面ではセーブできません」、ゲートは見る前に返る', () => {
    const s = setup()
    s.state.storyEnded = true
    const gate = vi.spyOn(s.transition, 'gateReason')
    expect(s.ctrl.quickSave()).toBe(false)
    expect(s.toasts).toEqual([MSG.saveBlocked])
    expect(gate).not.toHaveBeenCalled()
    expect(s.store.hasQuickSave()).toBe(false)
  })

  it('終劇後 + 場面転換中でも終劇の文言が優先される', () => {
    const s = setup()
    s.state.storyEnded = true
    s.setGate({ jump: 'pending', entry: true })
    expect(s.ctrl.quickSave()).toBe(false)
    expect(s.toasts).toEqual([MSG.saveBlocked])
  })

  it('入場中 > Jump 予約中 > 選択肢/待機 の優先順位で文言が決まる（停止中は選択肢と同じ文言）', () => {
    const a = setup()
    a.setGate({ choice: true, jump: 'pending' })
    a.ctrl.quickSave()
    expect(a.toasts).toEqual([MSG.saveTransition])

    const b = setup()
    b.setGate({ wait: true, jump: 'stalled' })
    b.ctrl.quickSave()
    expect(b.toasts).toEqual([MSG.saveBlocked])

    const c = setup()
    c.setGate({ choice: true, entry: true })
    c.ctrl.quickSave()
    expect(c.toasts).toEqual([MSG.saveTransition])
  })

  it('成功: 手動は「クイックセーブしました」+ true、ゲートは quickSave の規則で見る', () => {
    const s = setup()
    const gate = vi.spyOn(s.transition, 'gateReason')
    expect(s.ctrl.quickSave()).toBe(true)
    expect(s.toasts).toEqual([MSG.saveOk])
    expect(gate).toHaveBeenCalledWith('quickSave')
    expect(s.store.hasQuickSave()).toBe(true)
  })

  it('手動は本文位置を問わない（非本文の位置でも保存する）', () => {
    const s = setup()
    s.setPosition(NON_TEXT)
    expect(s.ctrl.quickSave()).toBe(true)
    expect(s.store.hasQuickSave()).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// SaveSlotData の内容
// ---------------------------------------------------------------------------
describe('quickSave が保存する SaveSlotData', () => {
  it('slot は -1、savedAt は保存時刻（ISO）、sceneName は再生位置のシーンのタイトル、本体はスナップショット', () => {
    const s = setup()
    s.ctrl.quickSave()
    const saved = s.store.quickLoad()
    expect(saved).toMatchObject({
      slot: -1,
      savedAt: FIXED_NOW,
      sceneName: 'タイトルA',
      sceneId: 'a',
      eventIndex: TEXT,
      textIndex: 0,
      flags: { seen: { Bool: true } },
      backgroundPath: 'a.png',
      currentBgmPath: 'bgm.ogg',
    })
  })

  it('シーン名は Host の再生位置（getPlayheadSceneId）で引く。スナップショットの sceneId ではない', () => {
    const s = setup()
    s.state.playhead = 'b'
    s.ctrl.quickSave()
    expect(s.store.quickLoad()).toMatchObject({ sceneId: 'a', sceneName: 'タイトルB' })
  })

  it.each([
    ['再生位置が null（ジャンプ前の線形ストリーム）', null],
    ['索引に無いシーン', 'missing'],
  ])('%s: sceneName は null で保存できる', (_n, playhead) => {
    const s = setup()
    s.state.playhead = playhead
    expect(s.ctrl.quickSave()).toBe(true)
    expect(s.store.quickLoad()?.sceneName).toBeNull()
  })

  it('sceneId が null のスナップショットでも保存できる', () => {
    const s = setup()
    s.state.snapshot = { ...SNAPSHOT, sceneId: null }
    s.state.playhead = null
    expect(s.ctrl.quickSave()).toBe(true)
    expect(s.store.quickLoad()).toMatchObject({ sceneId: null, sceneName: null, slot: -1 })
  })
})

// ---------------------------------------------------------------------------
// 自動セーブの保留 (#768)
// ---------------------------------------------------------------------------
describe('自動セーブの保留 (#768)', () => {
  it('ゲートが開いた本文位置なら requestAutoSave で即1回保存し、無言。後の flush では保存しない', () => {
    const s = setup()
    const quickSave = vi.spyOn(s.ctrl.saveManager, 'quickSave')
    s.ctrl.requestAutoSave()
    expect(quickSave).toHaveBeenCalledTimes(1)
    expect(s.toasts).toEqual([])
    expect(s.store.quickLoad()).toMatchObject({
      slot: -1,
      savedAt: FIXED_NOW,
      sceneName: 'タイトルA',
    })
    s.ctrl.flushAutoSave()
    s.ctrl.flushAutoSave()
    expect(quickSave).toHaveBeenCalledTimes(1)
  })

  it('ゲートが閉じている間は保留のまま、開いた後の flush で1回だけ保存する', () => {
    const s = setup()
    s.transition.enterWait()
    const quickSave = vi.spyOn(s.ctrl.saveManager, 'quickSave')
    s.ctrl.requestAutoSave()
    s.ctrl.flushAutoSave()
    expect(quickSave).not.toHaveBeenCalled()

    s.transition.leaveWait()
    s.ctrl.flushAutoSave()
    s.ctrl.flushAutoSave()
    expect(quickSave).toHaveBeenCalledTimes(1)
    expect(s.toasts).toEqual([])
  })

  it('非本文の位置では保存されず、本文に着いた flush で保存される', () => {
    const s = setup()
    s.setPosition(NON_TEXT)
    s.ctrl.requestAutoSave()
    expect(s.store.hasQuickSave()).toBe(false)

    s.cursor.skipDirective() // 本文へ
    s.ctrl.flushAutoSave()
    expect(s.store.quickLoad()?.eventIndex).toBe(TEXT)
  })

  it('discardPendingAutoSave 後は、条件が揃っても保存されない', () => {
    const s = setup()
    s.transition.enterChoiceWait()
    s.ctrl.requestAutoSave()
    s.ctrl.discardPendingAutoSave()
    s.transition.leaveChoiceWait()
    s.ctrl.flushAutoSave()
    expect(s.store.hasQuickSave()).toBe(false)
  })

  it('requestAutoSave 無しの flush は何もしない', () => {
    const s = setup()
    s.ctrl.flushAutoSave()
    expect(s.store.hasQuickSave()).toBe(false)
  })

  it('保留は終劇の間は残り、終劇が解けた flush で保存される', () => {
    const s = setup()
    s.state.storyEnded = true
    s.ctrl.requestAutoSave()
    expect(s.store.hasQuickSave()).toBe(false)
    s.state.storyEnded = false
    s.ctrl.flushAutoSave()
    expect(s.store.hasQuickSave()).toBe(true)
  })

  it('flush のガード順: 終劇 → 本文でない → ゲート。手前で弾いたらゲートを問い合わせない', () => {
    const ended = setup()
    ended.state.storyEnded = true
    const g1 = vi.spyOn(ended.transition, 'gateReason')
    ended.ctrl.requestAutoSave()
    expect(g1).not.toHaveBeenCalled()

    const nonText = setup()
    nonText.setPosition(NON_TEXT)
    const g2 = vi.spyOn(nonText.transition, 'gateReason')
    nonText.ctrl.requestAutoSave()
    expect(g2).not.toHaveBeenCalled()

    const open = setup()
    const g3 = vi.spyOn(open.transition, 'gateReason')
    open.ctrl.requestAutoSave()
    expect(g3).toHaveBeenCalledWith('quickSave')
  })

  it('保留は保存の前に下ろす（保存中の再入で二重保存にならない）', () => {
    const s = setup()
    let depth = 0
    s.host.getSnapshot.mockImplementation(() => {
      depth++
      if (depth === 1) s.ctrl.flushAutoSave() // 保存中に別経路から flush が走っても保存は入れ子にならない
      return s.state.snapshot
    })
    const quickSave = vi.spyOn(s.ctrl.saveManager, 'quickSave')
    s.ctrl.requestAutoSave()
    expect(quickSave).toHaveBeenCalledTimes(1)
    expect(depth).toBe(1)
  })

  it('手動の quickSave は保留を下ろさない（自動の保留は別管理）', () => {
    const s = setup()
    s.transition.enterWait()
    s.ctrl.requestAutoSave() // 保留
    s.transition.leaveWait()
    s.ctrl.quickSave() // 手動で1回
    const quickSave = vi.spyOn(s.ctrl.saveManager, 'quickSave')
    s.ctrl.flushAutoSave() // 保留は生きているので自動が1回走る
    expect(quickSave).toHaveBeenCalledTimes(1)
  })
})

// ---------------------------------------------------------------------------
// クイックロード
// ---------------------------------------------------------------------------
describe('quickLoad', () => {
  function seed(s: Setup): SaveSlotData {
    s.ctrl.quickSave()
    s.toasts.length = 0
    return s.store.quickLoad() as SaveSlotData
  }

  const cases: Array<[string, Partial<Gate>, string]> = [
    ['選択肢待ち', { choice: true }, MSG.loadBlocked],
    ['[待機] 中', { wait: true }, MSG.loadBlocked],
    ['Jump 予約中', { jump: 'pending' }, MSG.loadTransition],
    ['入場中', { entry: true }, MSG.loadTransition],
  ]

  it.each(cases)(
    '%s: 手動は文言を出して null、auto は無言で null。入場は始めない',
    async (_n, gate, msg) => {
      const s = setup()
      seed(s)
      s.setGate(gate)
      await expect(s.ctrl.quickLoad()).resolves.toBeNull()
      expect(s.toasts).toEqual([msg])
      await expect(s.ctrl.quickLoad('auto')).resolves.toBeNull()
      expect(s.toasts).toEqual([msg])
      expect(s.host.enter).not.toHaveBeenCalled()
    }
  )

  it('ゲートは navigate の規則で見る: 停止中（stalled）の Jump ではロードできる', async () => {
    const s = setup()
    const data = seed(s)
    const gate = vi.spyOn(s.transition, 'gateReason')
    s.setGate({ jump: 'stalled' })
    gate.mockClear()
    await expect(s.ctrl.quickLoad()).resolves.toEqual(ENTERED)
    expect(gate).toHaveBeenCalledWith('navigate')
    expect(s.host.enter).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'restore', source: 'save', origin: 'quick' })
    )
    expect(restoreReq(s).state.eventIndex).toBe(data.eventIndex)
    expect(s.toasts).toEqual([])
  })

  it('データ無し: 手動は「クイックセーブデータがありません」、auto は無言。どちらも null', async () => {
    const s = setup()
    await expect(s.ctrl.quickLoad()).resolves.toBeNull()
    expect(s.toasts).toEqual([MSG.loadNoData])
    await expect(s.ctrl.quickLoad('auto')).resolves.toBeNull()
    expect(s.toasts).toEqual([MSG.loadNoData])
    expect(s.host.enter).not.toHaveBeenCalled()
  })

  it('ゲートはデータ有無より先に見る（ゲートが閉じていればデータ無しの文言は出ない）', async () => {
    const s = setup()
    s.setGate({ wait: true })
    await s.ctrl.quickLoad()
    expect(s.toasts).toEqual([MSG.loadBlocked])
  })

  it.each<['quick' | 'auto']>([['quick'], ['auto']])(
    'origin %s は enter にそのまま渡る',
    async (origin) => {
      const s = setup()
      seed(s)
      await s.ctrl.quickLoad(origin)
      expect(restoreReq(s).origin).toBe(origin)
    }
  )

  it('引数省略は quick 扱い（トーストが出る）', async () => {
    const s = setup()
    await s.ctrl.quickLoad()
    expect(s.toasts).toEqual([MSG.loadNoData])
  })
})

// ---------------------------------------------------------------------------
// SaveManager への素通し
// ---------------------------------------------------------------------------
describe('SaveManager への素通し', () => {
  it('getQuickSaveFlags / hasQuickSave / clearQuickSave', () => {
    const s = setup()
    expect(s.ctrl.hasQuickSave()).toBe(false)
    expect(s.ctrl.getQuickSaveFlags()).toBeNull()

    s.ctrl.quickSave()
    expect(s.ctrl.hasQuickSave()).toBe(true)
    expect(s.ctrl.getQuickSaveFlags()).toEqual({ seen: { Bool: true } })

    s.ctrl.clearQuickSave()
    expect(s.ctrl.hasQuickSave()).toBe(false)
    expect(s.ctrl.getQuickSaveFlags()).toBeNull()
    expect(s.store.hasQuickSave()).toBe(false)
  })

  it('saveManager の docKey を切り替えると保存先の名前空間が変わる（#578）', () => {
    const s = setup()
    s.ctrl.saveManager.setDocKey('proj')
    s.ctrl.quickSave()
    expect(new SaveManager('proj').hasQuickSave()).toBe(true)
    expect(s.store.hasQuickSave()).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// セーブ/ロードメニュー (#759)
// ---------------------------------------------------------------------------
function attachFakeMenu(s: Setup): {
  menu: SaveMenuView
  showSave: ReturnType<typeof vi.fn>
  showLoad: ReturnType<typeof vi.fn>
  confirmSave(slot: number): void
  confirmLoad(data: SaveSlotData): void
} {
  let onSave: ((slot: number) => void) | null = null
  let onLoad: ((data: SaveSlotData) => void) | null = null
  const showSave = vi.fn((cb: (slot: number) => void) => {
    onSave = cb
  })
  const showLoad = vi.fn((cb: (data: SaveSlotData) => void) => {
    onLoad = cb
  })
  const menu: SaveMenuView = { showSave, showLoad }
  s.ctrl.attachMenu(menu)
  return {
    menu,
    showSave,
    showLoad,
    confirmSave: (slot) => onSave!(slot),
    confirmLoad: (data) => onLoad!(data),
  }
}

describe('openSaveMenu', () => {
  it('終劇後は開かない', () => {
    const s = setup()
    const m = attachFakeMenu(s)
    s.state.storyEnded = true
    s.ctrl.openSaveMenu()
    expect(m.showSave).not.toHaveBeenCalled()
  })

  it.each<[string, Partial<Gate>, boolean]>([
    ['Jump 予約中', { jump: 'pending' }, false],
    ['停止中（stalled）の Jump', { jump: 'stalled' }, false],
    ['入場中', { entry: true }, false],
    ['選択肢待ち', { choice: true }, true],
    ['[待機] 中', { wait: true }, true],
  ])('開く時のゲート（saveMenu の規則）: %s は開く=%s', (_n, gate, opens) => {
    const s = setup()
    const m = attachFakeMenu(s)
    s.setGate(gate)
    s.ctrl.openSaveMenu()
    expect(m.showSave).toHaveBeenCalledTimes(opens ? 1 : 0)
    expect(s.toasts).toEqual([]) // 開く時の拒否は無言
  })

  it('確定: 選んだスロットに、スロット番号・保存時刻・シーン名つきで保存する（トーストなし）', () => {
    const s = setup()
    const m = attachFakeMenu(s)
    s.ctrl.openSaveMenu()
    m.confirmSave(2)
    expect(s.store.load(2)).toMatchObject({
      slot: 2,
      savedAt: FIXED_NOW,
      sceneName: 'タイトルA',
      sceneId: 'a',
      eventIndex: TEXT,
    })
    expect(s.store.load(0)).toBeNull()
    expect(s.store.hasQuickSave()).toBe(false)
    expect(s.toasts).toEqual([])
  })

  it('確定時にも再確認する: 表示中に Jump が予約されたら保存せず「場面転換中のためセーブできません」', () => {
    const s = setup()
    const m = attachFakeMenu(s)
    s.ctrl.openSaveMenu()
    s.setGate({ jump: 'pending' })
    m.confirmSave(1)
    expect(s.toasts).toEqual([MSG.saveTransition])
    expect(s.store.load(1)).toBeNull()
    expect(s.host.getSnapshot).not.toHaveBeenCalled()
  })

  it('確定時のゲートは saveMenu の規則: 表示中に選択肢待ちになっても保存できる', () => {
    const s = setup()
    const m = attachFakeMenu(s)
    s.ctrl.openSaveMenu()
    s.setGate({ choice: true })
    m.confirmSave(1)
    expect(s.store.load(1)).not.toBeNull()
  })

  it('menu 未接続: 黙って何もしない（旧実装は未初期化の saveLoadOverlay への参照で TypeError だった）', () => {
    const s = setup()
    expect(() => s.ctrl.openSaveMenu()).not.toThrow()
    expect(s.toasts).toEqual([])
    expect(s.store.hasQuickSave()).toBe(false)
    expect(s.host.getSnapshot).not.toHaveBeenCalled()
  })
})

describe('openLoadMenu', () => {
  it.each<[string, Partial<Gate>, boolean]>([
    ['Jump 予約中', { jump: 'pending' }, false],
    ['入場中', { entry: true }, false],
    ['停止中（stalled）の Jump', { jump: 'stalled' }, true],
    ['選択肢待ち', { choice: true }, true],
    ['[待機] 中', { wait: true }, true],
  ])('開く時のゲート（loadMenu の規則）: %s は開く=%s', (_n, gate, opens) => {
    const s = setup()
    const m = attachFakeMenu(s)
    s.setGate(gate)
    s.ctrl.openLoadMenu()
    expect(m.showLoad).toHaveBeenCalledTimes(opens ? 1 : 0)
    expect(s.toasts).toEqual([])
  })

  it('終劇後でも開ける（セーブと違いロードは終劇をガードしない）', () => {
    const s = setup()
    const m = attachFakeMenu(s)
    s.state.storyEnded = true
    s.ctrl.openLoadMenu()
    expect(m.showLoad).toHaveBeenCalledTimes(1)
  })

  it('確定: origin menu で復元の入場を始める。成功トーストは出さない', async () => {
    const s = setup()
    s.ctrl.quickSave()
    const data = s.store.quickLoad() as SaveSlotData
    s.toasts.length = 0
    const m = attachFakeMenu(s)
    s.ctrl.openLoadMenu()
    m.confirmLoad(data)
    expect(s.host.enter).toHaveBeenCalledTimes(1)
    expect(s.host.enter.mock.calls[0][0]).toMatchObject({
      kind: 'restore',
      source: 'save',
      origin: 'menu',
    })
    expect(s.toasts).toEqual([])
  })

  it('確定時にも再確認する: 表示中に Jump が予約されたら復元せず「場面転換中のためロードできません」', () => {
    const s = setup()
    s.ctrl.quickSave()
    const data = s.store.quickLoad() as SaveSlotData
    s.toasts.length = 0
    const m = attachFakeMenu(s)
    s.ctrl.openLoadMenu()
    s.setGate({ jump: 'pending' })
    m.confirmLoad(data)
    expect(s.toasts).toEqual([MSG.loadTransition])
    expect(s.host.enter).not.toHaveBeenCalled()
    expect(s.host.ensureAudioContext).not.toHaveBeenCalled()
  })

  it('menu 未接続: 黙って何もしない（旧実装は TypeError）', () => {
    const s = setup()
    expect(() => s.ctrl.openLoadMenu()).not.toThrow()
    expect(s.toasts).toEqual([])
    expect(s.host.enter).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// loadFromSaveData / 通知
// ---------------------------------------------------------------------------
describe('loadFromSaveData', () => {
  const DATA: SaveSlotData = {
    slot: -1,
    sceneId: 'b',
    eventIndex: 5,
    textIndex: 1,
    sentenceIndex: 3,
    flags: { k: { Bool: true } },
    backgroundPath: 'bg.png',
    backgroundFade: { side: 'right', size: 0.5 } as unknown as BackgroundFade,
    isBlackout: true,
    characters: [{ name: 'x', expression: 'smile', position: 'left' }],
    currentBgmPath: 'b.ogg',
    savedAt: FIXED_NOW,
    sceneName: 'タイトルB',
  }

  it('ensureAudioContext → normalizeBackgroundFade → enter の順（#578: 先に AudioContext を起こす）', async () => {
    const s = setup()
    await s.ctrl.loadFromSaveData(DATA, 'quick')
    expect(s.order).toEqual(['ensureAudioContext', 'normalizeBackgroundFade', 'enter'])
  })

  it.each<LoadOrigin>(['quick', 'menu', 'auto'])(
    '%s: enter に {kind:restore, source:save, origin} と、セーブの位置・flags・正規化済みフェードを渡す',
    async (origin) => {
      const s = setup()
      await s.ctrl.loadFromSaveData(DATA, origin)
      expect(s.host.normalizeBackgroundFade).toHaveBeenCalledWith(DATA.backgroundFade)
      const req = restoreReq(s)
      expect(req).toMatchObject({ kind: 'restore', source: 'save', origin })
      expect(req.state).toMatchObject({
        sceneId: 'b',
        eventIndex: 5,
        textIndex: 1,
        sentenceIndex: 3,
        flags: { k: { Bool: true } },
        backgroundPath: 'bg.png',
        isBlackout: true,
        currentBgmPath: 'b.ogg',
      })
      // 正規化の結果（元の値ではなく Host が返した値）が状態に載る
      expect(req.state.backgroundFade).toBe(s.fade)
      expect(req.state.backgroundFade).not.toBe(DATA.backgroundFade)
    }
  )

  it('enter の結果をそのまま返す', async () => {
    const s = setup()
    const failed: SceneEntryResult = { status: 'failed', reason: 'not-found' }
    s.host.enter.mockReturnValueOnce(Promise.resolve(failed))
    await expect(s.ctrl.loadFromSaveData(DATA, 'quick')).resolves.toBe(failed)
  })

  it('loadFromSaveData 自体はトーストを出さない（通知は入場の結末で notify が呼ぶ）', async () => {
    const s = setup()
    await s.ctrl.loadFromSaveData(DATA, 'quick')
    expect(s.toasts).toEqual([])
  })
})

describe('ロード通知 (#765)', () => {
  it.each<[LoadOrigin, string[]]>([
    ['quick', [MSG.loadOk]],
    ['menu', []],
    ['auto', []],
  ])('notifyLoadSuccess(%s): クイックロードだけ「クイックロードしました」', (origin, expected) => {
    const s = setup()
    s.ctrl.notifyLoadSuccess(origin)
    expect(s.toasts).toEqual(expected)
  })

  it('notifyLoadFailure は常に「ロードに失敗しました」', () => {
    const s = setup()
    s.ctrl.notifyLoadFailure()
    s.ctrl.notifyLoadFailure()
    expect(s.toasts).toEqual([MSG.loadFail, MSG.loadFail])
  })
})

// ---------------------------------------------------------------------------
// 旧実装との等価性: 旧 NovelRenderer の判定分岐を写したリファレンスとの全組合せ突き合わせ
// ---------------------------------------------------------------------------
/** 旧 saveQuick が見た「止める理由の文言種別」。優先順位 入場中 > Jump 予約中 > (停止中・選択肢・待機) を自前で書く。 */
function refSaveToast(origin: 'quick' | 'auto', ended: boolean, g: Gate): string | null {
  if (origin === 'auto') return null
  if (ended) return MSG.saveBlocked
  if (g.entry || g.jump === 'pending') return MSG.saveTransition
  if (g.jump === 'stalled' || g.choice || g.wait) return MSG.saveBlocked
  return MSG.saveOk
}
/** 旧 saveQuick が保存したか。quickSave 規則は stalled / choice / wait / pending / entry のどれでも止める。 */
function refSaves(ended: boolean, g: Gate): boolean {
  return !(ended || g.entry || g.jump !== 'idle' || g.choice || g.wait)
}
/** 旧 quickLoad の navigate 規則: stalled は止めない。 */
function refLoadToast(g: Gate): string | null {
  if (g.entry || g.jump === 'pending') return MSG.loadTransition
  if (g.choice || g.wait) return MSG.loadBlocked
  return null
}

const GATES: Gate[] = []
for (const choice of [false, true])
  for (const wait of [false, true])
    for (const jump of ['idle', 'pending', 'stalled'] as const)
      for (const entry of [false, true]) GATES.push({ choice, wait, jump, entry })

describe('旧実装との等価性（全組合せ）', () => {
  it('手動 quickSave: 終劇 × ゲート組合せ × 本文位置 × 再生位置シーン で 保存の有無・トースト・SaveSlotData が一致', () => {
    let saved = 0
    let rejected = 0
    const playheads: Array<[string | null, string | null]> = [
      ['a', 'タイトルA'],
      ['b', 'タイトルB'],
      [null, null],
      ['missing', null],
    ]
    for (const ended of [false, true])
      for (const g of GATES)
        for (const pos of [NON_TEXT, TEXT])
          for (const [playhead, title] of playheads) {
            const label = JSON.stringify({ ended, g, pos, playhead })
            const s = setup()
            s.state.storyEnded = ended
            s.state.playhead = playhead
            s.setGate(g)
            s.setPosition(pos)

            const result = s.ctrl.quickSave()

            expect(result, label).toBe(refSaves(ended, g))
            expect(s.toasts, label).toEqual([refSaveToast('quick', ended, g)])
            if (refSaves(ended, g)) {
              saved++
              expect(s.store.quickLoad(), label).toMatchObject({
                slot: -1,
                savedAt: FIXED_NOW,
                sceneName: title,
                sceneId: SNAPSHOT.sceneId,
                eventIndex: SNAPSHOT.eventIndex,
                textIndex: SNAPSHOT.textIndex,
                flags: SNAPSHOT.flags,
              })
            } else {
              rejected++
              expect(s.store.hasQuickSave(), label).toBe(false)
            }
          }
    // 非空虚性: 保存される組合せ・拒否される組合せの両方が十分な件数ある
    expect(saved).toBe(4 * 2) // ゲートが全部開いている 1 組合せ × 終劇なし × 位置2 × シーン4
    expect(rejected).toBe(2 * GATES.length * 2 * 4 - saved)
  })

  it('private saveQuick(auto) を直接呼ぶ防御分岐: 終劇・ゲート別に保存の有無が一致し、常に無言（旧 quickSaveToast と同じ観点）', () => {
    let saved = 0
    let rejected = 0
    for (const ended of [false, true])
      for (const g of GATES) {
        const label = JSON.stringify({ ended, g })
        const s = setup()
        s.state.storyEnded = ended
        s.setGate(g)
        const saveQuick = (s.ctrl as unknown as { saveQuick(o: 'quick' | 'auto'): boolean })
          .saveQuick
        expect(saveQuick.call(s.ctrl, 'auto'), label).toBe(refSaves(ended, g))
        expect(s.toasts, label).toEqual([refSaveToast('auto', ended, g)].filter((x) => x !== null))
        expect(s.store.hasQuickSave(), label).toBe(refSaves(ended, g))
        if (refSaves(ended, g)) saved++
        else rejected++
      }
    expect(saved).toBe(1)
    expect(rejected).toBe(2 * GATES.length - 1)
  })

  it('自動 requestAutoSave→flush: 保存の有無・無言・保存内容・保留の持ち越しが一致', () => {
    let saved = 0
    let pendingKept = 0
    for (const ended of [false, true])
      for (const g of GATES)
        for (const pos of [NON_TEXT, TEXT]) {
          const label = JSON.stringify({ ended, g, pos })
          const s = setup()
          s.state.storyEnded = ended
          s.setGate(g)
          s.setPosition(pos)

          s.ctrl.requestAutoSave()

          // 旧 flushAutoSave: 終劇・非本文・ゲートのいずれかなら保留のまま。全部通れば保存して下ろす。
          const refSaved = !ended && pos === TEXT && refSaves(false, g)
          expect(s.toasts, label).toEqual([]) // 自動は常に無言
          expect(s.store.hasQuickSave(), label).toBe(refSaved)
          if (refSaved) {
            saved++
            expect(s.store.quickLoad(), label).toMatchObject({
              slot: -1,
              savedAt: FIXED_NOW,
              sceneName: 'タイトルA',
              eventIndex: SNAPSHOT.eventIndex,
            })
          } else {
            // 保留が残っている: 条件を全部開けて flush すると保存される
            pendingKept++
            const fresh = setup()
            fresh.state.storyEnded = ended
            fresh.setGate(g)
            fresh.setPosition(pos)
            fresh.ctrl.requestAutoSave()
            fresh.state.storyEnded = false
            fresh.setPosition(TEXT)
            fresh.transition.resetForNewPosition()
            fresh.transition.clearPendingEntry()
            fresh.ctrl.flushAutoSave()
            expect(fresh.store.hasQuickSave(), label).toBe(true)
          }
          // 保存済みなら以後の flush は二重保存しない
          const quickSave = vi.spyOn(s.ctrl.saveManager, 'quickSave')
          s.ctrl.flushAutoSave()
          expect(quickSave).not.toHaveBeenCalled()
          vi.restoreAllMocks()
        }
    expect(saved).toBe(1) // ゲートが全部開いた本文位置・終劇なしの 1 組合せだけ
    expect(pendingKept).toBe(2 * GATES.length * 2 - saved)
  })

  it('quickLoad: ゲート組合せ × 手動/auto で、入場を始めるか・トースト文言が一致', async () => {
    let entered = 0
    let blocked = 0
    for (const g of GATES)
      for (const origin of ['quick', 'auto'] as const) {
        const label = JSON.stringify({ g, origin })
        const s = setup()
        s.ctrl.quickSave() // ゲートを立てる前にデータを用意
        s.toasts.length = 0
        s.setGate(g)

        const result = await s.ctrl.quickLoad(origin)

        const refToast = refLoadToast(g)
        if (refToast === null) {
          entered++
          expect(result, label).toEqual(ENTERED)
          expect(s.host.enter, label).toHaveBeenCalledTimes(1)
          expect(s.toasts, label).toEqual([])
        } else {
          blocked++
          expect(result, label).toBeNull()
          expect(s.host.enter, label).not.toHaveBeenCalled()
          expect(s.toasts, label).toEqual(origin === 'quick' ? [refToast] : [])
        }
      }
    // 閉じない組合せ: choice/wait/entry なし、jump が idle か stalled
    expect(entered).toBe(2 * 2)
    expect(blocked).toBe(GATES.length * 2 - entered)
  })
})
