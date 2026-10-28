/**
 * NovelRenderer の入場の単一入口 `enterScene` と遷移中のゲートのテスト (#734 PR1)。
 *
 * 進行（選択肢の確定）と復元（restoreSnapshot）の遅延ロード中に、入場中ゲート（pendingEntry）が
 * ユーザー入力を止めること、後勝ち（要求の時点で世代を進める）、失敗時に選択肢が再表示されること、
 * 予約中の Jump の取り消しで deferred が superseded 解決されることを検証する。
 * 既存の流儀（jump.test / restoreSnapshot.test）に倣い、render は no-op・時間は virtual で駆動する。
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { NovelRenderer } from './NovelRenderer'
import { defaultTimeController } from './TimeController'
import type { NovelGameState } from './GameState'
import type { Event, EventScene } from '../types'
import { internals, type RendererInternals } from '../test/rendererInternals'

function narration(...lines: string[]): Event {
  return { Narration: { text: lines } }
}
function jump(target: string): Event {
  return { Jump: { target } }
}
function choice(...targets: string[]): Event {
  return {
    Choice: { options: targets.map((t) => ({ text: `to ${t}`, jump: t })) },
  } as Event
}
function scene(id: string, events: Event[]): EventScene {
  return { id, title: id, view: 'TopDown', events }
}

interface Internals extends RendererInternals {
  choiceOverlay: { show: (...args: unknown[]) => void; hide: () => void }
  saveLoadOverlay: { showLoad: (...args: unknown[]) => void }
}
function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
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
    wall: null,
    stageFront: null,
    props: [],
    spotlight: null,
    curtain: null,
    isBlackout: false,
    characters: [],
    currentBgmPath: null,
    cameraMode: 'Novel',
    cameraOrientation: 'Audience',
    cameraElevation: null,
    cameraZoom: null,
    paperDollOutline: null,
    storyEnded: false,
    ...over,
  }
}

const flush = async (): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

// hub: 本文 → 選択肢（far = 未ロードのサブ MD 側）
const HUB = scene('hub', [narration('hub-line'), choice('far')])
const FAR = scene('far', [narration('far-1', 'far-2')])
const OTHER = scene('other', [narration('other-1')])

function makeRenderer(
  resolver: ((id: string) => Promise<EventScene[] | null>) | null,
  scenes: EventScene[] = [HUB]
): NovelRenderer {
  const r = new NovelRenderer()
  r.getTimeController().setMode('virtual')
  vi.spyOn(r.getAudioManager(), 'ensureContext').mockImplementation(() => {})
  internals<Internals>(r).initialized = true
  vi.spyOn(internals<Internals>(r), 'render').mockImplementation(() => {})
  r.setScenes(scenes)
  r.setMissingSceneResolver(resolver)
  return r
}

/** Choice に到達させ、overlay に渡された確定コールバックと、show の呼び出し回数を返す。 */
function reachChoice(r: NovelRenderer): {
  confirm: (jump: string) => boolean | void
  showCount: () => number
} {
  const calls: unknown[][] = []
  vi.spyOn(internals<Internals>(r).choiceOverlay, 'show').mockImplementation(
    (...args: unknown[]) => {
      calls.push(args)
    }
  )
  r.advance()
  expect(internals<Internals>(r).waitingForChoice).toBe(true)
  const confirm = calls[calls.length - 1][1] as (jump: string) => boolean | void
  return { confirm, showCount: () => calls.length }
}

describe('NovelRenderer 入場中ゲートと単一入口 (#734 PR1)', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    defaultTimeController.setMode('live')
    localStorage.clear()
  })

  it('選択肢から未ロードのシーンへの遷移中は、advance・quickSave・goBack・ロードメニューを弾き、到着後に解除される', async () => {
    const d = deferred<EventScene[] | null>()
    const r = makeRenderer(() => d.promise)
    const { confirm } = reachChoice(r)
    const showLoadSpy = vi
      .spyOn(internals<Internals>(r).saveLoadOverlay, 'showLoad')
      .mockImplementation(() => {})

    confirm('far')
    // 選択肢は閉じたが、遷移先の到着までゲートが残る
    expect(internals<Internals>(r).waitingForChoice).toBe(false)
    expect(internals<Internals>(r).pendingEntry).not.toBeNull()
    const indexBefore = internals<Internals>(r).eventIndex

    r.advance()
    expect(internals<Internals>(r).eventIndex).toBe(indexBefore) // Choice を素通りしない
    expect(r.getCurrentSceneId()).toBe('hub')
    expect(r.quickSave()).toBe(false)
    r.goBack()
    expect(r.getCurrentSceneId()).toBe('hub')
    ;(r as unknown as { openLoadMenu(): void }).openLoadMenu()
    expect(showLoadSpy).not.toHaveBeenCalled()

    d.resolve([HUB, FAR])
    await flush()

    expect(r.getCurrentSceneId()).toBe('far')
    expect(internals<Internals>(r).pendingEntry).toBeNull()
    expect(r.quickSave()).toBe(true)
  })

  it('restoreSnapshot の遅延ロード中は、選択肢の確定を弾き（選択肢は表示されたまま）、advance も弾く', async () => {
    const d = deferred<EventScene[] | null>()
    const r = makeRenderer(() => d.promise)
    const { confirm } = reachChoice(r)
    const hideSpy = vi.spyOn(internals<Internals>(r).choiceOverlay, 'hide')

    const restoring = r.restoreSnapshot(craftSnapshot({ sceneId: 'far' }))
    confirm('far')
    r.advance()

    expect(internals<Internals>(r).waitingForChoice).toBe(true)
    expect(hideSpy).not.toHaveBeenCalled()
    expect(r.getCurrentSceneId()).toBe('hub')

    d.resolve([HUB, FAR])
    await expect(restoring).resolves.toEqual({ status: 'entered', sceneId: 'far' })
    expect(r.getCurrentSceneId()).toBe('far')
  })

  it('後勝ち: 復元（遅延ロード）の後の復元は、先の解決が後に終わっても後から要求した側が適用される', async () => {
    const dFar = deferred<EventScene[] | null>()
    const dOther = deferred<EventScene[] | null>()
    const r = makeRenderer((id) => (id === 'far' ? dFar.promise : dOther.promise))

    const first = r.restoreSnapshot(craftSnapshot({ sceneId: 'far' }))
    const second = r.restoreSnapshot(craftSnapshot({ sceneId: 'other' }))
    dOther.resolve([HUB, OTHER])
    await flush()
    dFar.resolve([HUB, FAR])

    await expect(first).resolves.toEqual({ status: 'superseded' })
    await expect(second).resolves.toEqual({ status: 'entered', sceneId: 'other' })
    expect(r.getCurrentSceneId()).toBe('other')
    expect(internals<Internals>(r).pendingEntry).toBeNull()
  })

  it('後勝ち: 復元（遅延ロード）の後の startFrom で、古い復元は適用されず、ゲートも下りる', async () => {
    const d = deferred<EventScene[] | null>()
    const r = makeRenderer(() => d.promise)

    const restoring = r.restoreSnapshot(craftSnapshot({ sceneId: 'far' }))
    expect(internals<Internals>(r).pendingEntry).not.toBeNull()
    r.startFrom({ sceneId: 'hub' })
    expect(internals<Internals>(r).pendingEntry).toBeNull()

    d.resolve([HUB, FAR])
    await expect(restoring).resolves.toEqual({ status: 'superseded' })
    expect(r.getCurrentSceneId()).toBe('hub')
  })

  it('遷移先が不在（resolver が null）のとき、選択肢が再表示され、advance で Choice を素通りしない', async () => {
    const r = makeRenderer(() => Promise.resolve(null))
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { confirm, showCount } = reachChoice(r)

    confirm('far')
    await flush()

    expect(showCount()).toBe(2)
    expect(internals<Internals>(r).waitingForChoice).toBe(true)
    r.advance()
    expect(r.getCurrentSceneId()).toBe('hub')
    expect(internals<Internals>(r).waitingForChoice).toBe(true)
  })

  it('resolver が無く遷移先が確実に無いときは、選択肢を閉じず（再表示もせず）その場に留める', () => {
    const r = makeRenderer(null)
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const hideSpy = vi.spyOn(internals<Internals>(r).choiceOverlay, 'hide')
    const { confirm, showCount } = reachChoice(r)

    expect(confirm('nowhere')).toBe(false)

    expect(showCount()).toBe(1)
    expect(hideSpy).not.toHaveBeenCalled()
    expect(internals<Internals>(r).waitingForChoice).toBe(true)
    r.advance()
    expect(r.getCurrentSceneId()).toBe('hub')
  })

  it('選択肢由来の進行の待機中にプログラム発の復元で置き換えられ、その復元も失敗しても、選択肢が再表示される', async () => {
    const dFar = deferred<EventScene[] | null>()
    const dGone = deferred<EventScene[] | null>()
    const r = makeRenderer((id) => (id === 'far' ? dFar.promise : dGone.promise))
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { confirm, showCount } = reachChoice(r)

    confirm('far')
    const restoring = r.restoreSnapshot(craftSnapshot({ sceneId: 'gone' }))
    dGone.resolve(null)
    await expect(restoring).resolves.toEqual({ status: 'failed', reason: 'not-found' })

    expect(showCount()).toBe(2)
    expect(internals<Internals>(r).waitingForChoice).toBe(true)

    dFar.resolve([HUB, FAR])
    await flush()
    expect(r.getCurrentSceneId()).toBe('hub') // 置き換えられた古い進行は適用されない
  })

  it('予約中の [ジャンプ:] が復元で取り消されたとき、待っている側の Promise は superseded で解決される', async () => {
    const r = makeRenderer(null, [
      scene('a', [narration('a1'), jump('b')]),
      scene('b', [narration('b1')]),
    ])
    r.advance() // Jump に到達し、遷移を予約（タイマーは未発火）
    expect(internals<Internals>(r).jumpState).toBe('pending')
    const waiting = internals<Internals>(r).pendingEntry!.promise

    void r.restoreSnapshot(craftSnapshot({ sceneId: 'a' })) // 同期で復元（予約中の Jump を取り消す）

    await expect(waiting).resolves.toEqual({ status: 'superseded' })
    expect(internals<Internals>(r).pendingEntry).toBeNull()
  })

  it('予約中の [ジャンプ:] が発火して入場できたとき、待っている側の Promise は entered で解決される', async () => {
    const r = makeRenderer(null, [
      scene('a', [narration('a1'), jump('b')]),
      scene('b', [narration('b1')]),
    ])
    r.advance()
    const waiting = internals<Internals>(r).pendingEntry!.promise

    r.getTimeController().tick(1)

    await expect(waiting).resolves.toEqual({ status: 'entered', sceneId: 'b' })
    expect(r.getCurrentSceneId()).toBe('b')
    expect(internals<Internals>(r).pendingEntry).toBeNull()
  })
})
