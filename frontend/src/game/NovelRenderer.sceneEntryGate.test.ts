/**
 * NovelRenderer のシーン入場（進行）の網羅テスト (#734 PR1)。
 *
 * `NovelRenderer.sceneEntry.test.ts` が golden path を押さえるのに対し、ここでは次を網羅する。
 * - 進行入場中（選択肢由来・[ジャンプ:] 由来）の全ゲート操作の拒否と、到着後の解除
 * - 失敗時の扱いの分岐（Jump 由来は stallJump、選択肢由来は再表示）と失敗の原因ごとの経路
 * - 後勝ち（進行 vs 復元、復元 vs 進行、進行 vs startFrom、状態を作り直す経路）と、破棄された入場の無害さ
 * - Jump 予約の取り消し経路ごとの deferred の superseded 解決と、playScript が止まらないこと
 * - confinement 圏外の進行、遅延ロード成功時の BGM・背景の持ち越し
 * 既存の流儀（render は no-op・時間は virtual）に倣う。
 */
import { confineForTest } from '../test/confinement'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { NovelRenderer } from './NovelRenderer'
import { defaultTimeController } from './TimeController'
import type { NovelGameState } from './GameState'
import type { Event, EventScene } from '../types'
import type { SceneEntryResult } from './sceneEntry'

function narration(...lines: string[]): Event {
  return { Narration: { text: lines } }
}
function jump(target: string): Event {
  return { Jump: { target } }
}
function bgm(path: string): Event {
  return { Bgm: { path, action: 'Play' } }
}
function choice(...targets: string[]): Event {
  return {
    Choice: { options: targets.map((t) => ({ text: `to ${t}`, jump: t })) },
  } as Event
}
function scene(id: string, events: Event[]): EventScene {
  return { id, title: id, view: 'TopDown', events }
}

interface Internals {
  initialized: boolean
  waitingForChoice: boolean
  eventIndex: number
  jumpState: 'idle' | 'pending' | 'stalled'
  storyEnded: boolean
  currentBgmPath: string | null
  currentBackgroundPath: string | null
  allScenes: EventScene[]
  pendingEntry: { promise: Promise<SceneEntryResult>; sceneId: string | null } | null
  jumpDeferred: unknown
  choiceOverlay: { show: (...args: unknown[]) => void; hide: () => void }
  saveLoadOverlay: {
    showLoad: (...args: unknown[]) => void
    showSave: (...args: unknown[]) => void
  }
  render(): void
  applyState(state: NovelGameState): void
  openSaveMenu(): void
  openLoadMenu(): void
  showToast(msg: string): void
  loadFromSaveData(...args: unknown[]): void
}
function internals(r: NovelRenderer): Internals {
  return r as unknown as Internals
}

function deferred<T>(): {
  promise: Promise<T>
  resolve: (v: T) => void
  reject: (e: unknown) => void
} {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function craftSnapshot(over: Partial<NovelGameState>): NovelGameState {
  return {
    sceneId: 'hub',
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
    backgroundBoards: [],
    props: [],
    spotlight: null,
    curtain: null,
    isBlackout: false,
    characters: [],
    currentBgmPath: null,
    cameraMode: 'Novel',
    cameraOrientation: 'Audience',
    cameraElevation: null,
    paperDollOutline: null,
    storyEnded: false,
    ...over,
  }
}

const flush = async (): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

type Resolver = (id: string) => Promise<EventScene[] | null>

const HUB = scene('hub', [narration('hub-line'), choice('far')])
const FAR = scene('far', [narration('far-1', 'far-2')])
const OTHER = scene('other', [narration('other-1')])
// Jump 由来の検証用: a の本文の次が far への Jump
const JA = scene('a', [narration('a1'), jump('far')])

function makeRenderer(resolver: Resolver | null, scenes: EventScene[] = [HUB]): NovelRenderer {
  const r = new NovelRenderer()
  r.getTimeController().setMode('virtual')
  vi.spyOn(r.getAudioManager(), 'ensureContext').mockImplementation(() => {})
  internals(r).initialized = true
  vi.spyOn(internals(r), 'render').mockImplementation(() => {})
  r.setScenes(scenes)
  r.setMissingSceneResolver(resolver)
  return r
}

function reachChoice(r: NovelRenderer): {
  confirm: (jump: string) => void
  showCount: () => number
} {
  const calls: unknown[][] = []
  vi.spyOn(internals(r).choiceOverlay, 'show').mockImplementation((...args: unknown[]) => {
    calls.push(args)
  })
  r.advance()
  expect(internals(r).waitingForChoice).toBe(true)
  return {
    confirm: calls.length ? (calls[calls.length - 1][1] as (j: string) => void) : () => {},
    showCount: () => calls.length,
  }
}

function lastConfirm(calls: unknown[][]): (jump: string) => void {
  return calls[calls.length - 1][1] as (jump: string) => void
}

/** 選択肢由来の進行（遅延ロード中）を作る。 */
function pendingByChoice(d: ReturnType<typeof deferred<EventScene[] | null>>): NovelRenderer {
  const r = makeRenderer(() => d.promise)
  const { confirm } = reachChoice(r)
  confirm('far')
  expect(internals(r).pendingEntry).not.toBeNull()
  return r
}

/** [ジャンプ:] 由来の進行（遅延ロード中）を作る。 */
function pendingByJump(d: ReturnType<typeof deferred<EventScene[] | null>>): NovelRenderer {
  const r = makeRenderer(() => d.promise, [JA])
  r.advance() // Jump に到達し予約
  r.getTimeController().tick(1) // 発火 → 遅延ロード待ち
  expect(internals(r).jumpState).toBe('pending')
  expect(internals(r).pendingEntry?.sceneId).toBe('far')
  return r
}

afterEach(() => {
  vi.restoreAllMocks()
  defaultTimeController.setMode('live')
  localStorage.clear()
})

describe('進行入場中の全ゲート操作 (#734 PR1)', () => {
  const origins: Array<[string, typeof pendingByChoice, string]> = [
    ['選択肢由来', pendingByChoice, 'hub'],
    ['[ジャンプ:] 由来', pendingByJump, 'a'],
  ]

  it.each(origins)(
    '%s: advance・オート送り・スキップ・各セーブ/ロード・goBack・seekTo・quickLoad を弾き、到着後に解除される',
    async (_name, build, startScene) => {
      const d = deferred<EventScene[] | null>()
      const r = build(d)
      const i = internals(r)
      const toast = vi.spyOn(i, 'showToast').mockImplementation(() => {})
      const showLoad = vi.spyOn(i.saveLoadOverlay, 'showLoad').mockImplementation(() => {})
      const showSave = vi.spyOn(i.saveLoadOverlay, 'showSave').mockImplementation(() => {})
      const indexBefore = i.eventIndex

      // advance
      r.advance()
      expect(i.eventIndex).toBe(indexBefore)
      // オート送り: 有効にしても時間が経っても進まない
      r.setAutoMode(true)
      r.getTimeController().tick(60_000)
      expect(i.eventIndex).toBe(indexBefore)
      r.setAutoMode(false)
      // スキップ: 有効にしても時間が経っても進まない
      r.setSkipMode(true)
      r.getTimeController().tick(60_000)
      expect(i.eventIndex).toBe(indexBefore)
      r.setSkipMode(false)
      // セーブ系
      expect(r.quickSave()).toBe(false)
      i.openSaveMenu()
      expect(showSave).not.toHaveBeenCalled()
      // ロード系
      i.openLoadMenu()
      expect(showLoad).not.toHaveBeenCalled()
      const loadSpy = vi.spyOn(i, 'loadFromSaveData').mockImplementation(() => {})
      expect(await r.quickLoad()).toBeNull()
      expect(toast).toHaveBeenCalledWith('場面転換中のためロードできません')
      expect(loadSpy).not.toHaveBeenCalled()
      // 履歴系
      r.goBack()
      r.seekTo(0)
      expect(r.getCurrentSceneId()).toBe(startScene)
      expect(i.eventIndex).toBe(indexBefore)
      expect(i.pendingEntry).not.toBeNull()

      d.resolve([HUB, FAR, JA])
      await flush()

      expect(r.getCurrentSceneId()).toBe('far')
      expect(i.pendingEntry).toBeNull()
      expect(i.jumpState).toBe('idle')
      expect(r.quickSave()).toBe(true)
      showSave.mockClear()
      i.openSaveMenu()
      expect(showSave).toHaveBeenCalledTimes(1)
      i.openLoadMenu()
      expect(showLoad).toHaveBeenCalledTimes(1)
    }
  )

  it('メニューを開いたあとに入場が始まった場合、セーブ/ロードの確定も弾かれる', async () => {
    let saveCb: ((slot: number) => void) | undefined
    let loadCb: ((data: unknown) => void) | undefined
    const d2 = deferred<EventScene[] | null>()
    const r2 = makeRenderer(() => d2.promise, [HUB])
    const i2 = internals(r2)
    const showSave = vi.spyOn(i2.saveLoadOverlay, 'showSave').mockImplementation((...a) => {
      saveCb = a[0] as (slot: number) => void
    })
    const showLoad = vi.spyOn(i2.saveLoadOverlay, 'showLoad').mockImplementation((...a) => {
      loadCb = a[0] as (data: unknown) => void
    })
    const toast = vi.spyOn(i2, 'showToast').mockImplementation(() => {})
    const loadSpy = vi.spyOn(i2, 'loadFromSaveData').mockImplementation(() => {})
    const saveSpy = vi.spyOn(
      (r2 as unknown as { saveManager: { save: (...a: unknown[]) => void } }).saveManager,
      'save'
    )
    const calls: unknown[][] = []
    vi.spyOn(i2.choiceOverlay, 'show').mockImplementation((...a: unknown[]) => {
      calls.push(a)
    })
    r2.advance()
    i2.openSaveMenu()
    i2.openLoadMenu()
    expect(showSave).toHaveBeenCalledTimes(1)
    expect(showLoad).toHaveBeenCalledTimes(1)
    lastConfirm(calls)('far') // 表示中に裏で入場が始まる
    expect(i2.pendingEntry).not.toBeNull()

    saveCb!(1)
    expect(saveSpy).not.toHaveBeenCalled()
    expect(toast).toHaveBeenCalledWith('場面転換中のためセーブできません')
    loadCb!({})
    expect(loadSpy).not.toHaveBeenCalled()
    expect(toast).toHaveBeenCalledWith('場面転換中のためロードできません')

    d2.resolve([HUB, FAR])
    await flush()
  })

  it('進行入場中は、別の選択肢の確定（confirmChoice）も弾く', async () => {
    // 復元の遅延ロード中に選択肢を出したままにし、確定を弾く（既存の sceneEntry テストは hide 不呼出のみ）
    const d = deferred<EventScene[] | null>()
    const r = makeRenderer(() => d.promise)
    const calls: unknown[][] = []
    vi.spyOn(internals(r).choiceOverlay, 'show').mockImplementation((...a: unknown[]) => {
      calls.push(a)
    })
    r.advance()
    const confirm = lastConfirm(calls)
    const enter = vi.spyOn(r as unknown as { enterScene(...a: unknown[]): unknown }, 'enterScene')

    const p = r.jumpToScene('far') // 進行入場を立てる（遅延ロード）
    confirm('other') // 古い選択肢の確定
    expect(enter).toHaveBeenCalledTimes(1) // 確定は enterScene まで届かない
    expect(internals(r).waitingForChoice).toBe(true)

    d.resolve([HUB, FAR])
    await expect(p).resolves.toEqual({ status: 'entered', sceneId: 'far' })
  })

  it('クイックロード: 入場中でない通常時は通り、入場中だけ弾く', async () => {
    const d = deferred<EventScene[] | null>()
    const r = makeRenderer(() => d.promise, [HUB, FAR])
    expect(r.quickSave()).toBe(true)
    const loadSpy = vi.spyOn(internals(r), 'loadFromSaveData').mockImplementation(() => {})
    expect(await r.quickLoad()).not.toBeNull()
    expect(loadSpy).toHaveBeenCalledTimes(1)
    loadSpy.mockClear()

    const pending = r.jumpToScene('missing')
    expect(internals(r).pendingEntry).not.toBeNull()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(await r.quickLoad()).toBeNull()
    expect(loadSpy).not.toHaveBeenCalled()

    d.resolve(null)
    await pending
    expect(internals(r).pendingEntry).toBeNull()
  })
})

describe('失敗時の扱い (#734 PR1)', () => {
  const failures: Array<[string, (d: ReturnType<typeof deferred<EventScene[] | null>>) => void]> = [
    ['resolver が null', (d) => d.resolve(null)],
    ['resolver が reject', (d) => d.reject(new Error('network'))],
    ['ロード後も遷移先が不在', (d) => d.resolve([HUB, OTHER])],
  ]

  it.each(failures)(
    'Jump 由来 / %s: stalled になり、ゲートが下り、停止位置で止まる',
    async (_n, fail) => {
      const d = deferred<EventScene[] | null>()
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const r = pendingByJump(d)
      const result = internals(r).pendingEntry!.promise

      fail(d)
      await expect(result).resolves.toMatchObject({ status: 'failed' })

      expect(warn).toHaveBeenCalled()
      expect(internals(r).jumpState).toBe('stalled')
      expect(internals(r).pendingEntry).toBeNull()
      expect(r.getCurrentSceneId()).toBe('a')
      const idx = internals(r).eventIndex
      r.advance() // 停止中は Jump を飛び越さない
      expect(internals(r).eventIndex).toBe(idx)
      // 停止中でも goBack 等の navigate は通る（ゲートは入場中のみ全拒否）
      expect(r.quickSave()).toBe(false)
    }
  )

  it('Jump 由来 / 同期で不在（resolver 無し）: 発火後に stalled になり pendingEntry が残らない', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const r = makeRenderer(null, [JA])
    r.advance()
    const waiting = internals(r).pendingEntry!.promise
    r.getTimeController().tick(1)
    await expect(waiting).resolves.toEqual({ status: 'failed', reason: 'not-found' })
    expect(internals(r).jumpState).toBe('stalled')
    expect(internals(r).pendingEntry).toBeNull()
  })

  it.each(failures.slice(1))(
    '選択肢由来 / %s: 選択肢が再表示され、advance で Choice を素通りしない',
    async (_n, fail) => {
      const d = deferred<EventScene[] | null>()
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const r = makeRenderer(() => d.promise)
      const { confirm, showCount } = reachChoice(r)
      confirm('far')
      expect(internals(r).waitingForChoice).toBe(false)

      fail(d)
      await flush()

      expect(warn).toHaveBeenCalled()
      expect(showCount()).toBe(2)
      expect(internals(r).waitingForChoice).toBe(true)
      expect(internals(r).pendingEntry).toBeNull()
      const idx = internals(r).eventIndex
      r.advance()
      expect(internals(r).eventIndex).toBe(idx)
      expect(r.getCurrentSceneId()).toBe('hub')
    }
  )
})

describe('後勝ちと破棄された入場 (#734 PR1)', () => {
  it('進行（遅延ロード）の後に別の進行（同期）が来たら、後の側が適用され、古い解決は allScenes を書き換えない', async () => {
    const d = deferred<EventScene[] | null>()
    const r = makeRenderer(() => d.promise, [HUB, OTHER])
    const first = r.jumpToScene('far')
    const second = r.jumpToScene('other')
    await expect(second).resolves.toEqual({ status: 'entered', sceneId: 'other' })
    expect(internals(r).pendingEntry).toBeNull()

    d.resolve([HUB, FAR])
    await expect(first).resolves.toEqual({ status: 'superseded' })
    expect(r.getCurrentSceneId()).toBe('other')
    expect(internals(r).allScenes.some((s) => s.id === 'far')).toBe(false)
  })

  it('進行（遅延ロード）の後の復元（同期）は後の側が適用され、ゲートが下りる', async () => {
    const d = deferred<EventScene[] | null>()
    const r = makeRenderer(() => d.promise, [HUB, OTHER])
    const first = r.jumpToScene('far')
    const second = r.restoreSnapshot(craftSnapshot({ sceneId: 'other' }))
    await expect(second).resolves.toEqual({ status: 'entered', sceneId: 'other' })
    expect(internals(r).pendingEntry).toBeNull()

    d.resolve([HUB, FAR])
    await expect(first).resolves.toEqual({ status: 'superseded' })
    expect(r.getCurrentSceneId()).toBe('other')
    expect(internals(r).allScenes.some((s) => s.id === 'far')).toBe(false)
  })

  it('復元（遅延ロード）の後の進行（同期）は後の側が適用され、古い復元の flags は適用されない', async () => {
    const d = deferred<EventScene[] | null>()
    const r = makeRenderer(() => d.promise, [HUB, OTHER])
    const first = r.restoreSnapshot(
      craftSnapshot({ sceneId: 'far', flags: { stale: { Bool: true } } })
    )
    const second = r.jumpToScene('other')
    await expect(second).resolves.toEqual({ status: 'entered', sceneId: 'other' })

    d.resolve([HUB, FAR])
    await expect(first).resolves.toEqual({ status: 'superseded' })
    expect(r.getCurrentSceneId()).toBe('other')
    expect(r.getSnapshot().flags).not.toHaveProperty('stale')
  })

  it('進行（遅延ロード）の後の startFrom は後の側が適用され、古い解決は無害', async () => {
    const d = deferred<EventScene[] | null>()
    const r = makeRenderer(() => d.promise, [HUB, OTHER])
    const first = r.jumpToScene('far')
    r.startFrom({ sceneId: 'other' })
    expect(internals(r).pendingEntry).toBeNull()

    d.resolve([HUB, FAR])
    await expect(first).resolves.toEqual({ status: 'superseded' })
    expect(r.getCurrentSceneId()).toBe('other')
    expect(internals(r).allScenes.some((s) => s.id === 'far')).toBe(false)
  })

  it('状態を作り直す経路（applyState・startFrom・setEvents）は pendingEntry を下ろし、古い進行を破棄する', async () => {
    const routes: Array<[string, (r: NovelRenderer) => void]> = [
      ['applyState', (r) => internals(r).applyState(craftSnapshot({ sceneId: 'hub' }))],
      ['startFrom', (r) => r.startFrom({})],
      ['setEvents', (r) => r.setEvents([narration('fresh')])],
    ]
    for (const [name, act] of routes) {
      const d = deferred<EventScene[] | null>()
      const r = makeRenderer(() => d.promise, [HUB])
      const p = r.jumpToScene('far')
      expect(internals(r).pendingEntry, name).not.toBeNull()

      act(r)
      expect(internals(r).pendingEntry, name).toBeNull()

      const before = r.getCurrentSceneId()
      d.resolve([HUB, FAR])
      await expect(p, name).resolves.toEqual({ status: 'superseded' })
      expect(r.getCurrentSceneId(), name).toBe(before)
      expect(
        internals(r).allScenes.some((s) => s.id === 'far'),
        name
      ).toBe(false)
    }
  })

  it('破棄された入場の失敗は、選択肢を再表示しない（後始末は新しい側が担う）', async () => {
    const d = deferred<EventScene[] | null>()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const r = makeRenderer(() => d.promise, [HUB, OTHER])
    const { confirm, showCount } = reachChoice(r)
    confirm('far')
    r.startFrom({ sceneId: 'other' })

    d.resolve(null)
    await flush()
    expect(showCount()).toBe(1)
    expect(r.getCurrentSceneId()).toBe('other')
  })

  it('destroy 後（initialized=false）の解決は何も適用せず、成功でも allScenes を書き換えない', async () => {
    const d = deferred<EventScene[] | null>()
    const r = makeRenderer(() => d.promise)
    const p = r.jumpToScene('far')
    internals(r).initialized = false

    d.resolve([HUB, FAR])
    await expect(p).resolves.toEqual({ status: 'superseded' })
    expect(r.getCurrentSceneId()).toBe('hub')
    expect(internals(r).allScenes.some((s) => s.id === 'far')).toBe(false)
  })

  it('destroy 後の失敗の解決は、警告だけ残して何も適用しない（選択肢も再表示しない）', async () => {
    const d = deferred<EventScene[] | null>()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const r = makeRenderer(() => d.promise)
    const { confirm, showCount } = reachChoice(r)
    confirm('far')
    internals(r).initialized = false

    d.resolve(null)
    await flush()
    expect(warn).toHaveBeenCalled()
    expect(showCount()).toBe(1)
    expect(r.getCurrentSceneId()).toBe('hub')
  })
})

describe('Jump 予約の取り消しと deferred (#734 PR1)', () => {
  const A = scene('a', [narration('a1'), jump('b')])
  const B = scene('b', [narration('b1')])

  const cancels: Array<[string, (r: NovelRenderer) => void]> = [
    ['startFrom(sceneId)', (r) => r.startFrom({ sceneId: 'b' })],
    ['startFrom(entry)', (r) => r.startFrom({})],
    ['setEvents', (r) => r.setEvents([narration('x')])],
    ['applyState', (r) => internals(r).applyState(craftSnapshot({ sceneId: 'b' }))],
    ['別の進行', (r) => void r.jumpToScene('b')],
    ['restoreSnapshot', (r) => void r.restoreSnapshot(craftSnapshot({ sceneId: 'b' }))],
  ]

  it.each(cancels)(
    '%s で予約中の Jump が取り消されると、待っている側は superseded で解決される',
    async (_n, act) => {
      const r = makeRenderer(null, [A, B])
      r.advance()
      expect(internals(r).jumpState).toBe('pending')
      const waiting = internals(r).pendingEntry!.promise
      let settled: SceneEntryResult | null = null
      void waiting.then((v) => {
        settled = v
      })

      act(r)
      await flush()

      // 別の進行は同期で入場し、その結果は Jump の deferred ではなく superseded
      expect(settled).toEqual({ status: 'superseded' })
      expect(internals(r).jumpDeferred).toBeNull()
    }
  )

  it('Jump の再予約（armJump の連続）でも、前の deferred は superseded で解決される', async () => {
    const r = makeRenderer(null, [A, B])
    r.advance()
    const first = internals(r).pendingEntry!.promise
    ;(r as unknown as { armJump(t: string): void }).armJump('b')
    const second = internals(r).pendingEntry!.promise
    expect(second).not.toBe(first)
    await expect(first).resolves.toEqual({ status: 'superseded' })

    r.getTimeController().tick(1)
    await expect(second).resolves.toEqual({ status: 'entered', sceneId: 'b' })
  })

  it('発火後に initialized=false だった場合、deferred は superseded で解決される', async () => {
    const r = makeRenderer(null, [A, B])
    r.advance()
    const waiting = internals(r).pendingEntry!.promise
    internals(r).initialized = false
    r.getTimeController().tick(1)
    await expect(waiting).resolves.toEqual({ status: 'superseded' })
  })

  it('発火後の遅延ロード中に新しい入場が来ても、Jump 側の Promise は superseded で解決される', async () => {
    const d = deferred<EventScene[] | null>()
    const r = makeRenderer(() => d.promise, [JA])
    r.advance()
    const waiting = internals(r).pendingEntry!.promise
    r.getTimeController().tick(1)
    r.startFrom({ sceneId: 'a' })
    d.resolve([JA, FAR])
    await expect(waiting).resolves.toEqual({ status: 'superseded' })
  })

  it('playScript: advance で Jump に到達した後に復元・新規開始が来ても止まらず、残りのステップを消化する', async () => {
    const r = makeRenderer(null, [A, B])
    const done = r.playScript([{ type: 'advance' }, { type: 'advance' }])
    expect(internals(r).jumpState).toBe('pending') // 1 つ目の advance が Jump に到達

    void r.restoreSnapshot(craftSnapshot({ sceneId: 'b' }))
    await expect(done).resolves.toBeUndefined()
    expect(r.getCurrentSceneId()).toBe('b')
  })

  it('playScript: 選択肢ステップが遅延ロード中に startFrom で置き換えられても止まらない', async () => {
    const d = deferred<EventScene[] | null>()
    const r = makeRenderer(() => d.promise, [HUB, OTHER])
    r.advance() // Choice へ
    const done = r.playScript([{ type: 'choice', jump: 'far' }, { type: 'advance' }])
    expect(internals(r).pendingEntry).not.toBeNull()

    r.startFrom({ sceneId: 'other' })
    // 遅延ロード中の入場の Promise は、ロード自体が決着してから superseded で解決される（取り消しは
    // 世代を進めるだけで、往復は打ち切らない）。ロードが決着すれば playScript は止まらず終わる。
    d.resolve([HUB, FAR])
    await expect(done).resolves.toBeUndefined()
    expect(r.getCurrentSceneId()).toBe('other')
  })

  it('playScript: 選択肢ステップが失敗しても止まらない', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const r = makeRenderer(() => Promise.resolve(null), [HUB])
    r.advance()
    await expect(r.playScript([{ type: 'choice', jump: 'far' }])).resolves.toBeUndefined()
    expect(internals(r).pendingEntry).toBeNull()
  })
})

describe('confinement と持ち越し (#734 PR1)', () => {
  it('confinement 圏外への進行は、遅延ロードを試みず ended で終劇する', async () => {
    const resolver = vi.fn(() => Promise.resolve<EventScene[] | null>([HUB, FAR]))
    const r = makeRenderer(resolver, [HUB])
    confineForTest(r, ['hub'])

    await expect(r.jumpToScene('far')).resolves.toEqual({ status: 'ended' })
    expect(resolver).not.toHaveBeenCalled()
    expect(internals(r).storyEnded).toBe(true)
    expect(internals(r).pendingEntry).toBeNull()
  })

  it('confinement 圏内の遅延ロードは通常どおり entered になる', async () => {
    const r = makeRenderer(() => Promise.resolve([HUB, FAR]), [HUB])
    confineForTest(r, ['hub', 'far'])
    await expect(r.jumpToScene('far')).resolves.toEqual({ status: 'entered', sceneId: 'far' })
    expect(internals(r).storyEnded).toBe(false)
  })

  it('遅延ロード成功時、進行は BGM と背景を持ち越す（停止しない）', async () => {
    const d = deferred<EventScene[] | null>()
    const hub = scene('hub', [bgm('hub.ogg'), narration('hub-line'), choice('far')])
    const r = makeRenderer(() => d.promise, [hub])
    const stopBgm = vi.spyOn(r.getAudioManager(), 'stopBgm').mockImplementation(() => {})
    vi.spyOn(r.getAudioManager(), 'playBgm').mockImplementation(async () => {})
    r.startFrom({ sceneId: 'hub' })
    internals(r).currentBackgroundPath = 'bg.png'
    expect(internals(r).currentBgmPath).toBe('hub.ogg')
    stopBgm.mockClear()
    const { confirm } = reachChoice(r)

    confirm('far')
    d.resolve([hub, FAR])
    await flush()

    expect(r.getCurrentSceneId()).toBe('far')
    expect(stopBgm).not.toHaveBeenCalled()
    expect(internals(r).currentBgmPath).toBe('hub.ogg')
    expect(internals(r).currentBackgroundPath).toBe('bg.png')
  })

  it('遅延ロード成功時、[ジャンプ:] 由来の進行も BGM を持ち越す', async () => {
    const d = deferred<EventScene[] | null>()
    const ja = scene('a', [bgm('a.ogg'), narration('a1'), jump('far')])
    const r = makeRenderer(() => d.promise, [ja])
    const stopBgm = vi.spyOn(r.getAudioManager(), 'stopBgm').mockImplementation(() => {})
    vi.spyOn(r.getAudioManager(), 'playBgm').mockImplementation(async () => {})
    r.startFrom({ sceneId: 'a' })
    stopBgm.mockClear()
    r.advance()
    r.getTimeController().tick(1)

    d.resolve([ja, FAR])
    await flush()

    expect(r.getCurrentSceneId()).toBe('far')
    expect(stopBgm).not.toHaveBeenCalled()
    expect(internals(r).currentBgmPath).toBe('a.ogg')
  })
})
