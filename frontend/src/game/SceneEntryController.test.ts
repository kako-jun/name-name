/**
 * SceneEntryController（シーン入場の単一入口）の単体テスト (#826, #735 5/8)。
 *
 * `NovelRenderer` は import しない（Pixi・DOM に依存しないことの確認も兼ねる）。Host は軽いモック1つで、
 * `SceneIndex` / `TransitionState` / `PlaybackCursor` は実物を使う。ADR 0003 §3 の手順（世代捕捉 → Jump タイマー停止 →
 * confinement 判定 → 解決 → 適用前の文脈確定 → 適用 → 後処理）は、Host・TransitionState・SceneIndex の呼び出し順を
 * 記録して固定する。
 *
 * 切り出し前の `NovelRenderer`（`origin/main`）の `enterScene` / `runEntry` / `failApply` / `handleApplyError` /
 * `finishEntry` / `failEntry` / `restoreEntryStream` の分岐を、文面でなく「種類 × 解決結果 × 例外の有無 × 再生開始済みか」の
 * 表として写した数行を「リファレンス」として末尾に置き、多入力で突き合わせる（doctrine 規律3）。リファレンスは
 * Controller のコードを呼ばない。
 */
import { afterEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import type { Event, EventScene, FlagValue } from '../types'
import { resolveEvents, GameState, type NovelGameState } from './GameState'
import { PlaybackCursor } from './PlaybackCursor'
import { SceneEntryController, type EntryHost, type EntryNotice } from './SceneEntryController'
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
const cond = (name: string, events: Event[]): Event => ({ Condition: { flag: name, events } })
const scene = (id: string, events: Event[]): EventScene => ({
  id,
  title: id,
  view: 'TopDown',
  events,
})
function flatten(scenes: EventScene[]): Event[] {
  const events: Event[] = []
  scenes.forEach((s, i) => {
    if (i > 0) events.push('SceneTransition')
    events.push(...s.events)
  })
  return events
}

const A = scene('a', [bg('a.png'), narr('a1')])
const B = scene('b', [bg('b.png'), narr('b1'), narr('b2')])

type Call = [string, ...unknown[]]

interface Setup {
  ctrl: SceneEntryController
  sceneIndex: SceneIndex
  transition: TransitionState
  cursor: PlaybackCursor
  onStall: ReturnType<typeof vi.fn>
  /** Host へ届いた操作（isActive / isTextPaginated は含めない）。 */
  calls: Call[]
  /** Host・TransitionState・SceneIndex・console.warn の呼び出しを時系列で並べたもの。 */
  order: string[]
  host: { active: boolean; paginated: boolean; throwIn: Set<string> }
  warn: MockInstance<typeof console.warn>
  error: MockInstance<typeof console.error>
  names(): string[]
  /** 準備のための呼び出しを記録から消す。 */
  reset(): void
  /** Jump を予約して pending にする（stall が観測できるように）。 */
  armJump(): void
}

function trace<T extends object>(obj: T, label: string, methods: string[], order: string[]): void {
  for (const m of methods) {
    const original = (obj as Record<string, unknown>)[m] as (...a: unknown[]) => unknown
    vi.spyOn(obj, m as never).mockImplementation(((...a: unknown[]) => {
      order.push(`${label}.${m}`)
      return original.apply(obj, a)
    }) as never)
  }
}

function setup(): Setup {
  const time = new TimeController()
  time.setMode('virtual')
  const onStall = vi.fn()
  const transition = new TransitionState(time, onStall)
  const sceneIndex = new SceneIndex()
  const cursor = new PlaybackCursor()
  const calls: Call[] = []
  const order: string[] = []
  const host = { active: true, paginated: false, throwIn: new Set<string>() }
  const rec = (name: string, ...args: unknown[]): void => {
    calls.push([name, ...args])
    order.push(`host.${name}`)
    if (host.throwIn.has(name)) throw new Error(`boom:${name}`)
  }
  const holder = { ctrl: null as unknown as SceneEntryController }
  const hostImpl: EntryHost = {
    isActive: () => {
      order.push('host.isActive')
      return host.active
    },
    endStory: () => rec('endStory'),
    // 呼ばれた時点の confinedSceneIds を記録する（確定が Host 呼び出しより前であることの検証用）。
    applyFreshContext: (flags) => rec('applyFreshContext', flags, holder.ctrl.confinedSceneIds),
    startEvents: (sceneId, events, opts) => rec('startEvents', sceneId, events, opts),
    restoreToScene: (sc, state, preset) => rec('restoreToScene', sc, state, preset),
    notify: (n: EntryNotice) => rec('notify', n),
    rederiveTransition: () => rec('rederive'),
    isTextPaginated: () => host.paginated,
  }
  const ctrl = new SceneEntryController(hostImpl, sceneIndex, transition, cursor)
  holder.ctrl = ctrl
  trace(
    transition,
    'transition',
    [
      'beginEntry',
      'isStale',
      'settlePendingEntry',
      'setPendingEntry',
      'clearPendingEntry',
      'resetChain',
      'stall',
    ],
    order
  )
  trace(sceneIndex, 'sceneIndex', ['resolve', 'indexLoaded', 'findScene', 'linearStart'], order)
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {
    order.push('console.warn')
  })
  const error = vi.spyOn(console, 'error').mockImplementation(() => {
    order.push('console.error')
  })
  return {
    ctrl,
    sceneIndex,
    transition,
    cursor,
    onStall,
    calls,
    order,
    host,
    warn,
    error,
    names: () => calls.map((c) => c[0]),
    reset: () => {
      calls.length = 0
      order.length = 0
      warn.mockClear()
      error.mockClear()
      onStall.mockClear()
    },
    armJump: () =>
      transition.arm('zz', {
        isActive: () => true,
        warnChainLimit: () => {},
        enter: () => Promise.resolve({ status: 'superseded' }),
      }),
  }
}

afterEach(() => {
  vi.restoreAllMocks()
})

const progress = (sceneId: string, origin: 'choice' | 'jump' = 'choice'): SceneEntryRequest => ({
  kind: 'progress',
  sceneId,
  origin,
})
function stateAt(
  sceneId: string | null,
  eventIndex = 0,
  textIndex = 0,
  flags: Record<string, FlagValue> = {}
): NovelGameState {
  return {
    ...buildFreshPositionState('x', { eventIndex, textIndex }, flags),
    sceneId,
  }
}
const saveReq = (
  state: NovelGameState,
  origin: LoadOrigin = 'quick'
): Extract<SceneEntryRequest, { kind: 'restore' }> => ({
  kind: 'restore',
  state,
  source: 'save',
  origin,
})
const snapReq = (state: NovelGameState): SceneEntryRequest => ({
  kind: 'restore',
  state,
  source: 'snapshot',
})
const freshReq = (
  sceneId: string | 'entry',
  extra: Partial<Extract<SceneEntryRequest, { kind: 'fresh' }>> = {}
): SceneEntryRequest => ({
  kind: 'fresh',
  target: sceneId === 'entry' ? 'entry' : { sceneId },
  ...extra,
})

/** 解決を手動で完了できる resolver。 */
function gate() {
  let resolve!: (v: EventScene[] | null) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<EventScene[] | null>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

// ---------------------------------------------------------------------------
// 同期で適用される（ADR 0003 §3）
// ---------------------------------------------------------------------------
describe('読み込み済みの入場は enter が戻る前に適用が済む（同期）', () => {
  it('進行: startEvents と sceneChange 通知が、await を挟まず済んでいる', async () => {
    const s = setup()
    s.sceneIndex.setJumpSceneIndex([A, B])
    const p = s.ctrl.enter(progress('b'))
    // 戻り値を await する前の時点で適用が終わっている
    expect(s.names()).toEqual(['startEvents', 'notify'])
    expect(s.calls[0].slice(1)).toEqual([
      'b',
      B.events,
      { preserveBackgroundForTransition: true, carryBgm: true, startIndex: undefined },
    ])
    expect(s.calls[1][1]).toEqual({ kind: 'sceneChange', sceneId: 'b' })
    expect(await p).toEqual({ status: 'entered', sceneId: 'b' })
    expect(s.transition.pendingEntry).toBeNull()
  })

  it('jumpTo は choice 由来の進行として同期に適用される', async () => {
    const s = setup()
    s.sceneIndex.setJumpSceneIndex([A, B])
    const p = s.ctrl.jumpTo('a')
    expect(s.names()).toEqual(['startEvents', 'notify'])
    expect(await p).toEqual({ status: 'entered', sceneId: 'a' })
  })

  it('新規開始（シーン指定）: 文脈の確定 → 適用が同期に済み、持ち越さない方針で流す', async () => {
    const s = setup()
    s.sceneIndex.setJumpSceneIndex([A, B])
    const p = s.ctrl.enter(freshReq('b', { flags: { f: { Bool: true } } }))
    expect(s.names()).toEqual(['applyFreshContext', 'startEvents', 'notify'])
    expect(s.calls[0][1]).toEqual({ f: { Bool: true } })
    expect((s.calls[1][3] as { carryBgm: boolean }).carryBgm).toBe(false)
    expect(
      (s.calls[1][3] as { preserveBackgroundForTransition: boolean })
        .preserveBackgroundForTransition
    ).toBe(false)
    expect(await p).toEqual({ status: 'entered', sceneId: 'b' })
  })

  it('復元（セーブ）: restoreToScene と loadSuccess 通知が同期に済む。presetStoryEnded は false', async () => {
    const s = setup()
    s.sceneIndex.setJumpSceneIndex([A, B])
    const state = stateAt('b')
    const p = s.ctrl.enter(saveReq(state, 'menu'))
    expect(s.names()).toEqual(['restoreToScene', 'notify'])
    expect(s.calls[0].slice(1)).toEqual([B, state, false])
    expect(s.calls[1][1]).toEqual({ kind: 'loadSuccess', origin: 'menu' })
    expect(await p).toEqual({ status: 'entered', sceneId: 'b' })
  })

  it('復元（スナップショット）: presetStoryEnded は true で、成功通知は出さない', async () => {
    const s = setup()
    s.sceneIndex.setJumpSceneIndex([A, B])
    const p = s.ctrl.enter(snapReq(stateAt('b')))
    expect(s.names()).toEqual(['restoreToScene'])
    expect(s.calls[0][3]).toBe(true)
    expect(await p).toEqual({ status: 'entered', sceneId: 'b' })
  })

  it('新規開始（エントリ）と sceneId null の復元も同期に適用される', async () => {
    const s = setup()
    s.sceneIndex.setEntry([narr('e1')], 'doc')
    const p1 = s.ctrl.enter(freshReq('entry'))
    expect(s.names()).toEqual(['applyFreshContext', 'startEvents', 'notify'])
    expect(await p1).toEqual({ status: 'entered', sceneId: 'doc' })
    s.reset()
    const p2 = s.ctrl.enter(saveReq(stateAt(null)))
    expect(s.names()).toEqual(['restoreToScene', 'notify'])
    expect(await p2).toEqual({ status: 'entered', sceneId: 'doc' })
  })

  it('見つからない入場（resolver 無し）も、戻る前に失敗として処理が済んでいる', async () => {
    const s = setup()
    s.cursor.markStarted()
    const p = s.ctrl.enter(progress('nope'))
    expect(s.names()).toEqual(['rederive'])
    expect(s.warn).toHaveBeenCalledTimes(1)
    expect(await p).toEqual({ status: 'failed', reason: 'not-found' })
  })
})

// ---------------------------------------------------------------------------
// 手順の順序（ADR 0003 §3）
// ---------------------------------------------------------------------------
describe('手順の順序', () => {
  it('進行（読み込み済み）: 世代捕捉 → 解決 → 適用 → 通知', async () => {
    const s = setup()
    s.sceneIndex.setJumpSceneIndex([B])
    await s.ctrl.enter(progress('b'))
    expect(s.order).toEqual([
      'transition.beginEntry',
      'sceneIndex.resolve',
      'host.startEvents',
      'host.notify',
    ])
  })

  it('進行（未ロード）: 世代捕捉 → 解決 → ゲートを立てる → await → 世代判定 → isActive → ゲートを下ろす → 索引へ反映 → 適用', async () => {
    const s = setup()
    s.sceneIndex.setMissingSceneResolver(() => Promise.resolve([B]))
    await s.ctrl.enter(progress('b'))
    expect(s.order).toEqual([
      'transition.beginEntry',
      'sceneIndex.resolve',
      'transition.setPendingEntry',
      'transition.isStale',
      'host.isActive',
      'transition.settlePendingEntry',
      'sceneIndex.indexLoaded',
      'host.startEvents',
      'host.notify',
    ])
  })

  it('新規開始: 世代捕捉 → 解決 → 文脈の確定（confinement → Host の flags/終劇）→ 連鎖リセット → 適用', async () => {
    const s = setup()
    s.sceneIndex.setJumpSceneIndex([A, B])
    await s.ctrl.enter(freshReq('b', { confinedSceneIds: ['a', 'b'] }))
    expect(s.order).toEqual([
      'transition.beginEntry',
      'sceneIndex.resolve',
      'host.applyFreshContext',
      'transition.resetChain',
      'host.startEvents',
      'host.notify',
    ])
    // Host の applyFreshContext が呼ばれた時点で、confinedSceneIds は新しい値に確定している
    expect(s.calls[0][2]).toEqual(['a', 'b'])
  })

  it('新規開始（エントリ）: 世代捕捉の次に解決を経ず文脈の確定へ進む', async () => {
    const s = setup()
    s.sceneIndex.setEntry([narr('e')], 'doc')
    await s.ctrl.enter(freshReq('entry'))
    expect(s.order).toEqual([
      'transition.beginEntry',
      'host.applyFreshContext',
      'transition.resetChain',
      'host.startEvents',
      'host.notify',
    ])
  })

  it('復元: 世代捕捉 → 解決 → 適用 → 成功通知', async () => {
    const s = setup()
    s.sceneIndex.setJumpSceneIndex([B])
    await s.ctrl.enter(saveReq(stateAt('b')))
    expect(s.order).toEqual([
      'transition.beginEntry',
      'sceneIndex.resolve',
      'host.restoreToScene',
      'host.notify',
    ])
  })

  it('失敗（再生開始済み）: 警告 → セーブ由来なら失敗通知 → 遷移の再導出', async () => {
    const s = setup()
    s.cursor.markStarted()
    await s.ctrl.enter(saveReq(stateAt('nope')))
    expect(s.order).toEqual([
      'transition.beginEntry',
      'sceneIndex.resolve',
      'console.warn',
      'host.notify',
      'host.rederive',
    ])
    expect(s.calls[0][1]).toEqual({ kind: 'loadFailure' })
  })

  it('confinement 圏外の進行: 世代捕捉の後、解決を呼ばず終劇する', async () => {
    const s = setup()
    s.sceneIndex.setJumpSceneIndex([A, B])
    await s.ctrl.enter(freshReq('a', { confinedSceneIds: ['a'] }))
    s.reset()
    const r = await s.ctrl.enter(progress('b'))
    expect(r).toEqual({ status: 'ended' })
    expect(s.order).toEqual(['transition.beginEntry', 'sceneIndex.findScene', 'host.endStory'])
  })

  it('Jump の予約は世代捕捉で取り消され、待っていた側は superseded で解決する（後勝ち）', async () => {
    const s = setup()
    s.sceneIndex.setJumpSceneIndex([A, B])
    s.armJump()
    const pending = s.transition.pendingEntry?.promise
    expect(pending).toBeDefined()
    const generationBefore = s.transition.generation
    await s.ctrl.enter(progress('a'))
    expect(await pending).toEqual({ status: 'superseded' })
    expect(s.transition.generation).toBe(generationBefore + 1)
    // 取り消しは beginEntry（enter の最初）で起きた。適用はその後
    expect(s.order[0]).toBe('transition.beginEntry')
  })
})

// ---------------------------------------------------------------------------
// 解決の結果（未ロード / 見つからない / resolver 失敗）
// ---------------------------------------------------------------------------
describe('未ロード・見つからない・resolver 失敗', () => {
  it('未ロード: 入場中ゲートが立ち、解決後に索引へ反映して適用し、ゲートが下りる', async () => {
    const s = setup()
    const g = gate()
    const resolver = vi.fn(() => g.promise)
    s.sceneIndex.setMissingSceneResolver(resolver)
    const p = s.ctrl.enter(progress('b'))
    expect(s.names()).toEqual([])
    expect(s.transition.pendingEntry).toMatchObject({ kind: 'progress', sceneId: 'b' })
    g.resolve([B])
    expect(await p).toEqual({ status: 'entered', sceneId: 'b' })
    expect(s.names()).toEqual(['startEvents', 'notify'])
    expect(s.transition.pendingEntry).toBeNull()
    expect(s.sceneIndex.findScene('b')).toBe(B)
  })

  it('同じ sceneId の未ロードは resolver を共有し、後の入場が勝つ', async () => {
    const s = setup()
    const g = gate()
    const resolver = vi.fn(() => g.promise)
    s.sceneIndex.setMissingSceneResolver(resolver)
    const first = s.ctrl.enter(progress('b'))
    const second = s.ctrl.enter(progress('b'))
    g.resolve([B])
    expect(await first).toEqual({ status: 'superseded' })
    expect(await second).toEqual({ status: 'entered', sceneId: 'b' })
    expect(resolver).toHaveBeenCalledTimes(1)
    expect(s.names()).toEqual(['startEvents', 'notify'])
  })

  it('見つからない（resolver 無し）: not-found。適用せず、警告に詳細が残る', async () => {
    const s = setup()
    const r = await s.ctrl.enter(progress('nope'))
    expect(r).toEqual({ status: 'failed', reason: 'not-found' })
    expect(s.names()).toEqual([])
    expect(s.warn).toHaveBeenCalledTimes(1)
    expect(String(s.warn.mock.calls[0][0])).toContain('nope')
  })

  it('見つからない（resolver が null）: not-found', async () => {
    const s = setup()
    s.sceneIndex.setMissingSceneResolver(() => Promise.resolve(null))
    expect(await s.ctrl.enter(progress('nope'))).toEqual({ status: 'failed', reason: 'not-found' })
    expect(s.names()).toEqual([])
  })

  it('遅延ロード後も目的のシーンが無い: not-found', async () => {
    const s = setup()
    s.sceneIndex.setMissingSceneResolver(() => Promise.resolve([A]))
    expect(await s.ctrl.enter(progress('b'))).toEqual({ status: 'failed', reason: 'not-found' })
    expect(s.names()).toEqual([])
  })

  it('resolver の失敗: resolver-error。警告に原因の error が渡る', async () => {
    const s = setup()
    const cause = new Error('network')
    s.sceneIndex.setMissingSceneResolver(() => Promise.reject(cause))
    expect(await s.ctrl.enter(progress('b'))).toEqual({
      status: 'failed',
      reason: 'resolver-error',
    })
    expect(s.warn.mock.calls[0][1]).toBe(cause)
    expect(s.transition.pendingEntry).toBeNull()
  })

  it('警告の文言は種類で分かれる（進行は無印、新規開始は startFrom:、復元は loadFromSaveData: / restoreSnapshot:）', async () => {
    const s = setup()
    await s.ctrl.enter(progress('n1'))
    await s.ctrl.enter(freshReq('n2'))
    await s.ctrl.enter(saveReq(stateAt('n3')))
    await s.ctrl.enter(snapReq(stateAt('n4')))
    const msgs = s.warn.mock.calls.map((c) => String(c[0]))
    expect(msgs[0].startsWith('[name-name] シーン')).toBe(true)
    expect(msgs[1].startsWith('[name-name] startFrom: ')).toBe(true)
    expect(msgs[2].startsWith('[name-name] loadFromSaveData: ')).toBe(true)
    expect(msgs[3].startsWith('[name-name] restoreSnapshot: ')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 待っている間の後続入場 / superseded / isActive の判定が1か所
// ---------------------------------------------------------------------------
describe('await 後の superseded / isActive 判定', () => {
  it('待っている間の後続入場: 古い方は superseded、後の方だけが適用される（後勝ち）', async () => {
    const s = setup()
    const gb = gate()
    s.sceneIndex.setJumpSceneIndex([A])
    s.sceneIndex.setMissingSceneResolver(() => gb.promise)
    const old = s.ctrl.enter(progress('b'))
    const latest = s.ctrl.enter(progress('a'))
    gb.resolve([B])
    expect(await latest).toEqual({ status: 'entered', sceneId: 'a' })
    expect(await old).toEqual({ status: 'superseded' })
    expect(s.calls.filter((c) => c[0] === 'startEvents')).toHaveLength(1)
    expect(s.calls[0][1]).toBe('a')
    // 古い解決は索引を書き換えない
    expect(s.sceneIndex.findScene('b')).toBeUndefined()
  })

  it('世代が別経路で進んだ（advanceGeneration）場合も、解決後の適用は捨てられる', async () => {
    const s = setup()
    const g = gate()
    s.sceneIndex.setMissingSceneResolver(() => g.promise)
    const p = s.ctrl.enter(progress('b'))
    s.transition.advanceGeneration()
    g.resolve([B])
    expect(await p).toEqual({ status: 'superseded' })
    expect(s.names()).toEqual([])
    expect(s.sceneIndex.findScene('b')).toBeUndefined()
  })

  it('isActive=false（destroy 後）: 解決が成功でも適用せず superseded。索引も書き換えない', async () => {
    const s = setup()
    const g = gate()
    s.sceneIndex.setMissingSceneResolver(() => g.promise)
    const p = s.ctrl.enter(progress('b'))
    s.host.active = false
    g.resolve([B])
    expect(await p).toEqual({ status: 'superseded' })
    expect(s.names()).toEqual([])
    expect(s.sceneIndex.findScene('b')).toBeUndefined()
  })

  it('isActive=false の失敗: 警告だけ残し、再導出も通知もしない', async () => {
    const s = setup()
    s.cursor.markStarted()
    const g = gate()
    s.sceneIndex.setMissingSceneResolver(() => g.promise)
    const p = s.ctrl.enter(saveReq(stateAt('b')))
    s.host.active = false
    g.resolve(null)
    expect(await p).toEqual({ status: 'superseded' })
    expect(s.warn).toHaveBeenCalledTimes(1)
    expect(s.names()).toEqual([])
  })

  it('世代が古い失敗: 警告も残さず、再導出もしない（後始末は新しい側が担う）', async () => {
    const s = setup()
    s.cursor.markStarted()
    const g = gate()
    s.sceneIndex.setMissingSceneResolver(() => g.promise)
    const p = s.ctrl.enter(progress('b'))
    s.transition.advanceGeneration()
    g.resolve(null)
    expect(await p).toEqual({ status: 'superseded' })
    expect(s.warn).not.toHaveBeenCalled()
    expect(s.names()).toEqual([])
  })

  it('世代が古く、かつ isActive=false でも superseded 1回。失敗の警告は残らない', async () => {
    const s = setup()
    const g = gate()
    s.sceneIndex.setMissingSceneResolver(() => g.promise)
    const p = s.ctrl.enter(progress('b'))
    s.transition.advanceGeneration()
    s.host.active = false
    g.resolve(null)
    expect(await p).toEqual({ status: 'superseded' })
    expect(s.warn).not.toHaveBeenCalled()
  })

  it('適用中に待っていた入場の結果が出ても、後続の入場のゲートは下ろさない', async () => {
    const s = setup()
    const gb = gate()
    s.sceneIndex.setJumpSceneIndex([A])
    s.sceneIndex.setMissingSceneResolver(() => gb.promise)
    const old = s.ctrl.enter(progress('b'))
    const latestGate = gate()
    s.sceneIndex.setMissingSceneResolver(() => latestGate.promise)
    const latest = s.ctrl.enter(progress('c'))
    gb.resolve([B])
    await old
    // 古い側の解決後も、最新の入場のゲートは立ったまま
    expect(s.transition.pendingEntry).toMatchObject({ sceneId: 'c' })
    latestGate.resolve([scene('c', [narr('c')])])
    expect(await latest).toEqual({ status: 'entered', sceneId: 'c' })
    expect(s.transition.pendingEntry).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// confinement
// ---------------------------------------------------------------------------
describe('confinement', () => {
  async function confined(s: Setup, ids: string[] | null): Promise<void> {
    s.sceneIndex.setJumpSceneIndex([A, B])
    await s.ctrl.enter(freshReq('a', { confinedSceneIds: ids }))
    s.reset()
  }

  it('圏外への進行は resolve を呼ばず、endStory して ended を返す（遅延ロードも試みない）', async () => {
    const s = setup()
    await confined(s, ['a'])
    const resolver = vi.fn(() => Promise.resolve([B]))
    s.sceneIndex.setMissingSceneResolver(resolver)
    const r = await s.ctrl.enter(progress('zzz'))
    expect(r).toEqual({ status: 'ended' })
    expect(s.names()).toEqual(['endStory'])
    expect(s.order).not.toContain('sceneIndex.resolve')
    expect(resolver).not.toHaveBeenCalled()
    expect(s.transition.pendingEntry).toBeNull()
  })

  it('圏外でも実在するシーンなら、DEV の typo 警告は出さない', async () => {
    const s = setup()
    await confined(s, ['a'])
    await s.ctrl.enter(progress('b'))
    expect(s.warn).not.toHaveBeenCalled()
  })

  it('圏外で、どこにも存在しない sceneId は DEV の typo 警告を残す', async () => {
    const s = setup()
    await confined(s, ['a'])
    await s.ctrl.enter(progress('typo-id'))
    expect(s.warn).toHaveBeenCalledTimes(1)
    expect(String(s.warn.mock.calls[0][0])).toContain('"typo-id"')
    expect(String(s.warn.mock.calls[0][0])).toContain('confinement')
  })

  it('圏内への進行は通常どおり適用する。圏外判定は進行にだけ効く（新規開始・復元は対象外）', async () => {
    const s = setup()
    await confined(s, ['a'])
    expect(await s.ctrl.enter(progress('a'))).toEqual({ status: 'entered', sceneId: 'a' })
    expect(await s.ctrl.enter(snapReq(stateAt('b')))).toEqual({ status: 'entered', sceneId: 'b' })
    expect(await s.ctrl.enter(freshReq('b'))).toEqual({ status: 'entered', sceneId: 'b' })
    expect(s.names()).not.toContain('endStory')
  })

  it('confinement 無し（null）なら、どのシーンへも進行できる', async () => {
    const s = setup()
    await confined(s, null)
    expect(await s.ctrl.enter(progress('b'))).toEqual({ status: 'entered', sceneId: 'b' })
  })

  it('圏外の進行でも世代は進み、予約中の Jump は取り消される', async () => {
    const s = setup()
    await confined(s, ['a'])
    s.armJump()
    const pending = s.transition.pendingEntry?.promise
    await s.ctrl.enter(progress('b'))
    expect(await pending).toEqual({ status: 'superseded' })
  })
})

// ---------------------------------------------------------------------------
// applyFresh
// ---------------------------------------------------------------------------
describe('applyFresh（新規開始）', () => {
  it('範囲外 position: confinement・flags とも不変で out-of-range の失敗にする (#789)', async () => {
    const s = setup()
    s.sceneIndex.setJumpSceneIndex([A, B])
    await s.ctrl.enter(freshReq('a', { confinedSceneIds: ['keep'] }))
    s.reset()
    const r = await s.ctrl.enter(
      freshReq('b', {
        position: { eventIndex: 99 },
        flags: { f: { Bool: true } },
        confinedSceneIds: ['new'],
      })
    )
    expect(r).toEqual({ status: 'failed', reason: 'out-of-range' })
    expect(s.ctrl.confinedSceneIds).toEqual(['keep'])
    expect(s.names()).toEqual([])
    expect(String(s.warn.mock.calls[0][0])).toContain('startFrom: ')
  })

  it('範囲外の textIndex も失敗にする（上限は本文の長さ）', async () => {
    const s = setup()
    s.sceneIndex.setJumpSceneIndex([B])
    // B の events[1] は 1 行の本文 → textIndex の上限は 1（行数）なので 1 は範囲外
    const r = await s.ctrl.enter(freshReq('b', { position: { eventIndex: 1, textIndex: 1 } }))
    expect(r).toEqual({ status: 'failed', reason: 'out-of-range' })
    expect(s.names()).toEqual([])
  })

  it('ノベル等で改頁数が幅に依存するとき（isTextPaginated）は textIndex の上限を見ない', async () => {
    const s = setup()
    s.sceneIndex.setJumpSceneIndex([B])
    s.host.paginated = true
    const r = await s.ctrl.enter(freshReq('b', { position: { eventIndex: 1, textIndex: 9 } }))
    expect(r).toEqual({ status: 'entered', sceneId: 'b' })
  })

  it('[条件:] の展開後の長さで範囲を判定する（flags が真なら範囲内、偽なら範囲外）', async () => {
    const s = setup()
    const c = scene('c', [cond('f', [narr('x'), narr('y'), narr('z')])])
    s.sceneIndex.setJumpSceneIndex([c])
    const inRange = await s.ctrl.enter(
      freshReq('c', { position: { eventIndex: 2 }, flags: { f: { Bool: true } } })
    )
    expect(inRange).toEqual({ status: 'entered', sceneId: 'c' })
    const outOfRange = await s.ctrl.enter(freshReq('c', { position: { eventIndex: 2 } }))
    expect(outOfRange).toEqual({ status: 'failed', reason: 'out-of-range' })
  })

  it('位置指定の成功: 文脈の確定 → 宣言的復元（持ち越さない）→ sceneChange。confinement は置き換わる', async () => {
    const s = setup()
    const M = scene('b', [bg('m.png'), narr('l1', 'l2')])
    s.sceneIndex.setJumpSceneIndex([M])
    const r = await s.ctrl.enter(
      freshReq('b', {
        position: { eventIndex: 1, textIndex: 1 },
        flags: { f: { Bool: true } },
        confinedSceneIds: ['b'],
      })
    )
    expect(r).toEqual({ status: 'entered', sceneId: 'b' })
    expect(s.names()).toEqual(['applyFreshContext', 'restoreToScene', 'notify'])
    expect(s.calls[0].slice(1)).toEqual([{ f: { Bool: true } }, ['b']])
    const [, sc, state, preset] = s.calls[1] as [string, EventScene, NovelGameState, boolean]
    expect(sc).toBe(M)
    expect(state).toMatchObject({
      sceneId: 'b',
      eventIndex: 1,
      textIndex: 1,
      sentenceIndex: 0,
      flags: { f: { Bool: true } },
    })
    expect(preset).toBe(false)
    expect(s.calls[2][1]).toEqual({ kind: 'sceneChange', sceneId: 'b' })
    expect(s.ctrl.confinedSceneIds).toEqual(['b'])
  })

  it('confinedSceneIds を省略した新規開始は confinement を解除する（null）', async () => {
    const s = setup()
    s.sceneIndex.setJumpSceneIndex([A, B])
    await s.ctrl.enter(freshReq('a', { confinedSceneIds: ['a'] }))
    expect(s.ctrl.confinedSceneIds).toEqual(['a'])
    await s.ctrl.enter(freshReq('b'))
    expect(s.ctrl.confinedSceneIds).toBeNull()
  })

  it('解決できなかった新規開始は confinement を変えない', async () => {
    const s = setup()
    s.sceneIndex.setJumpSceneIndex([A])
    await s.ctrl.enter(freshReq('a', { confinedSceneIds: ['a'] }))
    s.reset()
    const r = await s.ctrl.enter(freshReq('nope', { confinedSceneIds: ['x'] }))
    expect(r).toEqual({ status: 'failed', reason: 'not-found' })
    expect(s.ctrl.confinedSceneIds).toEqual(['a'])
    expect(s.names()).not.toContain('applyFreshContext')
  })

  it('未ロードの新規開始も、解決後に confinement を置き換え、文脈 → 適用の順で済む', async () => {
    const s = setup()
    s.sceneIndex.setMissingSceneResolver(() => Promise.resolve([B]))
    const p = s.ctrl.enter(freshReq('b', { confinedSceneIds: ['b'] }))
    expect(s.ctrl.confinedSceneIds).toBeNull() // 解決前は変えない
    await p
    expect(s.names()).toEqual(['applyFreshContext', 'startEvents', 'notify'])
    expect(s.ctrl.confinedSceneIds).toEqual(['b'])
  })

  it('途中で例外（startEvents）: failed(apply-error)。ゲートは下り、confinement は適用前に確定済み', async () => {
    const s = setup()
    s.sceneIndex.setJumpSceneIndex([B])
    s.host.throwIn.add('startEvents')
    const r = await s.ctrl.enter(freshReq('b', { confinedSceneIds: ['b'] }))
    expect(r).toEqual({ status: 'failed', reason: 'apply-error' })
    expect(s.error).toHaveBeenCalledTimes(1)
    expect(s.ctrl.confinedSceneIds).toEqual(['b'])
  })

  describe('エントリ文書の線形ストリーム (#777/#817)', () => {
    const X = scene('x', [bg('x.png'), narr('x1')])
    const Y = scene('y', [bg('y.png'), cond('f', [narr('y1'), narr('y2')]), narr('y3')])
    const Z = scene('z', [bg('z.png'), narr('z1')])
    function withEntry(): Setup {
      const s = setup()
      s.sceneIndex.setEntry(flatten([X, Y, Z]), 'doc')
      s.sceneIndex.setJumpSceneIndex([X, Y, Z])
      return s
    }

    it('linear: true でエントリ上のシーンを指すと、ストリーム全体をそのシーン先頭から流し、入ったシーンを知らせる', async () => {
      const s = withEntry()
      const r = await s.ctrl.enter(freshReq('y', { linear: true, flags: { f: { Bool: true } } }))
      expect(r).toEqual({ status: 'entered', sceneId: 'y' })
      const start = s.calls.find((c) => c[0] === 'startEvents')!
      expect(start[1]).toBe('doc') // 持ち主はエントリのまま
      expect(start[2]).toBe(s.sceneIndex.getEntryEvents()) // ストリーム全体
      // X は 2 件 + SceneTransition 1 件 → Y は展開後 3 件目から
      const resolvedX = resolveEvents(X.events, new GameState()).length
      expect((start[3] as { startIndex: number }).startIndex).toBe(resolvedX + 1)
      expect(s.calls.find((c) => c[0] === 'notify')![1]).toEqual({
        kind: 'sceneChange',
        sceneId: 'y',
      })
    })

    it('linear の開始位置は新規開始の flags で展開した値になる', async () => {
      const gs = new GameState()
      gs.fromJSON({ f: { Bool: true } })
      const xLen = resolveEvents(X.events, gs).length
      const yLen = resolveEvents(Y.events, gs).length
      const s1 = withEntry()
      await s1.ctrl.enter(freshReq('z', { linear: true, flags: { f: { Bool: true } } }))
      const withF = (s1.calls.find((c) => c[0] === 'startEvents')![3] as { startIndex: number })
        .startIndex
      expect(withF).toBe(xLen + 1 + yLen + 1)
      const s2 = withEntry()
      await s2.ctrl.enter(freshReq('z', { linear: true }))
      const withoutF = (s2.calls.find((c) => c[0] === 'startEvents')![3] as { startIndex: number })
        .startIndex
      expect(withoutF).toBe(withF - 2)
    })

    it('linear 無し（既定）: 指定シーンの events だけを流す', async () => {
      const s = withEntry()
      await s.ctrl.enter(freshReq('y'))
      const start = s.calls.find((c) => c[0] === 'startEvents')!
      expect(start[1]).toBe('y')
      expect(start[2]).toBe(Y.events)
      expect((start[3] as { startIndex?: number }).startIndex).toBeUndefined()
    })

    it('linear: true でも、エントリの線形ストリーム上に無いシーンは指定シーンだけを流す', async () => {
      const s = withEntry()
      const W = scene('w', [bg('w.png'), narr('w1')])
      s.sceneIndex.setJumpSceneIndex([W])
      await s.ctrl.enter(freshReq('w', { linear: true }))
      const start = s.calls.find((c) => c[0] === 'startEvents')!
      expect(start[1]).toBe('w')
      expect(start[2]).toBe(W.events)
    })

    it('linear: true でもエントリ自身の sceneId を指す場合は通常どおり', async () => {
      const s = withEntry()
      const E = scene('doc', [bg('d.png'), narr('d')])
      s.sceneIndex.setJumpSceneIndex([E])
      await s.ctrl.enter(freshReq('doc', { linear: true }))
      const start = s.calls.find((c) => c[0] === 'startEvents')!
      expect(start[2]).toBe(E.events)
    })
  })

  describe('DEV 警告（冒頭の背景無し）', () => {
    it('対象シーンが最初のテキストまでに背景を持たないと警告する', async () => {
      const s = setup()
      s.sceneIndex.setJumpSceneIndex([scene('nobg', [narr('t')])])
      await s.ctrl.enter(freshReq('nobg'))
      expect(s.warn).toHaveBeenCalledTimes(1)
      expect(String(s.warn.mock.calls[0][0])).toContain('"nobg"')
    })

    it('背景があれば警告しない。エントリ（target entry）は背景が無くても警告しない', async () => {
      const s = setup()
      s.sceneIndex.setJumpSceneIndex([A])
      s.sceneIndex.setEntry([narr('t')], 'doc')
      await s.ctrl.enter(freshReq('a'))
      await s.ctrl.enter(freshReq('entry'))
      expect(s.warn).not.toHaveBeenCalled()
    })
  })

  it('sceneId の無いエントリの新規開始は sceneChange を出さない', async () => {
    const s = setup()
    s.sceneIndex.setEntry([narr('t')], null)
    const r = await s.ctrl.enter(freshReq('entry'))
    expect(r).toEqual({ status: 'entered', sceneId: null })
    expect(s.names()).toEqual(['applyFreshContext', 'startEvents'])
  })
})

// ---------------------------------------------------------------------------
// startFrom / jumpTo の要求整形
// ---------------------------------------------------------------------------
describe('startFrom の要求整形', () => {
  function capture() {
    const s = setup()
    const enter = vi
      .spyOn(s.ctrl, 'enter')
      .mockImplementation(() => Promise.resolve({ status: 'superseded' } as SceneEntryResult))
    const last = (): Extract<SceneEntryRequest, { kind: 'fresh' }> =>
      enter.mock.calls[enter.mock.calls.length - 1][0] as Extract<
        SceneEntryRequest,
        { kind: 'fresh' }
      >
    return { s, last }
  }

  it('引数なし: エントリの先頭から（position 無し）', () => {
    const { s, last } = capture()
    void s.ctrl.startFrom()
    expect(last()).toMatchObject({ kind: 'fresh', target: 'entry', position: undefined })
  })

  it('sceneId だけ: シーン指定・position 無し', () => {
    const { s, last } = capture()
    void s.ctrl.startFrom({ sceneId: 'a' })
    expect(last().target).toEqual({ sceneId: 'a' })
    expect(last().position).toBeUndefined()
  })

  it('index がすべて 0 なら position は無し', () => {
    const { s, last } = capture()
    void s.ctrl.startFrom({ sceneId: 'a', eventIndex: 0, textIndex: 0, sentenceIndex: 0 })
    expect(last().position).toBeUndefined()
  })

  it.each([
    [{ eventIndex: 2 }, { eventIndex: 2, textIndex: 0, sentenceIndex: 0 }],
    [{ textIndex: 1 }, { eventIndex: 0, textIndex: 1, sentenceIndex: 0 }],
    [{ sentenceIndex: 3 }, { eventIndex: 0, textIndex: 0, sentenceIndex: 3 }],
    [
      { eventIndex: 1, textIndex: 2, sentenceIndex: 3 },
      { eventIndex: 1, textIndex: 2, sentenceIndex: 3 },
    ],
  ])('sceneId あり・%j のいずれかが非 0: position に整形する', (extra, expected) => {
    const { s, last } = capture()
    void s.ctrl.startFrom({ sceneId: 'a', ...extra })
    expect(last().position).toEqual(expected)
  })

  it('sceneId が無ければ、index があっても position 無し（target はエントリ）', () => {
    const { s, last } = capture()
    void s.ctrl.startFrom({ eventIndex: 3, textIndex: 1 })
    expect(last().target).toBe('entry')
    expect(last().position).toBeUndefined()
  })

  it('flags / confinedSceneIds / linear はそのまま渡す', () => {
    const { s, last } = capture()
    const flags = { f: { Bool: true } } as Record<string, FlagValue>
    void s.ctrl.startFrom({ sceneId: 'a', flags, confinedSceneIds: ['a'], linear: true })
    expect(last()).toMatchObject({ flags, confinedSceneIds: ['a'], linear: true })
  })

  it('jumpTo は choice 由来の進行要求になる', () => {
    const { s } = capture()
    const enter = vi.mocked(s.ctrl.enter)
    void s.ctrl.jumpTo('b')
    expect(enter.mock.calls[0][0]).toEqual({ kind: 'progress', sceneId: 'b', origin: 'choice' })
  })
})

// ---------------------------------------------------------------------------
// failEntry
// ---------------------------------------------------------------------------
describe('failEntry（解決できなかった入場）', () => {
  it('Jump 由来: 停止だけ。再導出も失敗通知もしない（再生開始済みでも）', async () => {
    const s = setup()
    s.cursor.markStarted()
    s.armJump()
    const r = await s.ctrl.enter(progress('nope', 'jump'))
    expect(r).toEqual({ status: 'failed', reason: 'not-found' })
    expect(s.transition.jumpState).toBe('stalled')
    expect(s.onStall).toHaveBeenCalledTimes(1)
    expect(s.names()).toEqual([])
  })

  it('選択肢由来: 再生開始済みなら再導出する。停止はしない', async () => {
    const s = setup()
    s.cursor.markStarted()
    s.armJump()
    await s.ctrl.enter(progress('nope'))
    expect(s.names()).toEqual(['rederive'])
    expect(s.transition.jumpState).toBe('pending')
  })

  it('再生が始まっていなければ（loadEvents 直後）再導出しない', async () => {
    const s = setup()
    await s.ctrl.enter(progress('nope'))
    await s.ctrl.enter(freshReq('nope'))
    await s.ctrl.enter(snapReq(stateAt('nope')))
    expect(s.names()).toEqual([])
  })

  it('新規開始・スナップショット復元の失敗: 再生開始済みなら再導出、失敗通知は無い', async () => {
    const s = setup()
    s.cursor.markStarted()
    await s.ctrl.enter(freshReq('nope'))
    await s.ctrl.enter(snapReq(stateAt('nope')))
    expect(s.names()).toEqual(['rederive', 'rederive'])
  })

  it('セーブ由来の復元失敗: 再生が始まっていなくても loadFailure を通知する', async () => {
    const s = setup()
    await s.ctrl.enter(saveReq(stateAt('nope')))
    expect(s.names()).toEqual(['notify'])
    expect(s.calls[0][1]).toEqual({ kind: 'loadFailure' })
  })

  it('範囲外の復元（#789）: out-of-range で失敗し、restoreToScene を呼ばない。セーブなら loadFailure', async () => {
    const s = setup()
    s.sceneIndex.setJumpSceneIndex([B])
    s.cursor.markStarted()
    const r = await s.ctrl.enter(saveReq(stateAt('b', 99)))
    expect(r).toEqual({ status: 'failed', reason: 'out-of-range' })
    expect(s.names()).toEqual(['notify', 'rederive'])
  })

  it('終端（eventIndex === 展開後の長さ）の復元は範囲内', async () => {
    const s = setup()
    s.sceneIndex.setJumpSceneIndex([B])
    const r = await s.ctrl.enter(snapReq(stateAt('b', B.events.length)))
    expect(r).toEqual({ status: 'entered', sceneId: 'b' })
  })

  it('復元の範囲判定は flags で [条件:] を展開した長さで行う', async () => {
    const s = setup()
    const c = scene('c', [cond('f', [narr('x'), narr('y')])])
    s.sceneIndex.setJumpSceneIndex([c])
    expect(await s.ctrl.enter(snapReq(stateAt('c', 1, 0, { f: { Bool: true } })))).toEqual({
      status: 'entered',
      sceneId: 'c',
    })
    expect(await s.ctrl.enter(snapReq(stateAt('c', 2, 0, {})))).toEqual({
      status: 'failed',
      reason: 'out-of-range',
    })
  })
})

// ---------------------------------------------------------------------------
// handleApplyError / failApply / run
// ---------------------------------------------------------------------------
describe('適用中の例外（handleApplyError / failApply）', () => {
  it('Jump 由来の進行: apply-error。ログを残し、停止する（再導出しない）', async () => {
    const s = setup()
    s.sceneIndex.setJumpSceneIndex([B])
    s.cursor.markStarted()
    s.armJump()
    s.host.throwIn.add('startEvents')
    const r = await s.ctrl.enter(progress('b', 'jump'))
    expect(r).toEqual({ status: 'failed', reason: 'apply-error' })
    expect(s.error).toHaveBeenCalledTimes(1)
    expect(s.transition.jumpState).toBe('stalled')
    expect(s.names()).toEqual(['startEvents'])
  })

  it('選択肢由来の進行: apply-error。再生開始の有無によらず再導出し、停止しない', async () => {
    const s = setup()
    s.sceneIndex.setJumpSceneIndex([B])
    s.armJump()
    s.host.throwIn.add('startEvents')
    const r = await s.ctrl.enter(progress('b'))
    expect(r).toEqual({ status: 'failed', reason: 'apply-error' })
    expect(s.names()).toEqual(['startEvents', 'rederive'])
    expect(s.transition.jumpState).toBe('pending')
  })

  it.each([
    ['新規開始', () => freshReq('b'), 'startEvents'],
    ['セーブ復元', () => saveReq(stateAt('b')), 'restoreToScene'],
    ['スナップショット復元', () => snapReq(stateAt('b')), 'restoreToScene'],
  ])('%s の例外: 停止する（再導出しない）', async (_label, make, throwing) => {
    const s = setup()
    s.sceneIndex.setJumpSceneIndex([B])
    s.cursor.markStarted()
    s.armJump()
    s.host.throwIn.add(throwing)
    const r = await s.ctrl.enter(make())
    expect(r).toEqual({ status: 'failed', reason: 'apply-error' })
    expect(s.transition.jumpState).toBe('stalled')
    expect(s.names()).not.toContain('rederive')
  })

  it('failApply は入場中ゲートを無条件に下ろす', async () => {
    const s = setup()
    s.sceneIndex.setJumpSceneIndex([B])
    const original = s.host.throwIn
    original.add('startEvents')
    // 適用の途中でゲートが立っている状態を作る
    const spy = vi.spyOn(s.transition, 'beginEntry')
    spy.mockImplementation(() => {
      const g = TransitionState.prototype.beginEntry.call(s.transition)
      s.transition.setPendingEntry({
        generation: g,
        kind: 'progress',
        sceneId: 'b',
        promise: new Promise(() => {}),
      })
      return g
    })
    expect(s.transition.hasPendingEntry).toBe(false)
    const r = await s.ctrl.enter(progress('b'))
    expect(r).toEqual({ status: 'failed', reason: 'apply-error' })
    expect(s.transition.hasPendingEntry).toBe(false)
  })

  it('未ロード後の適用の例外も reject せず failed で解決し、ゲートが残らない', async () => {
    const s = setup()
    s.sceneIndex.setMissingSceneResolver(() => Promise.resolve([B]))
    s.host.throwIn.add('startEvents')
    const r = await s.ctrl.enter(progress('b'))
    expect(r).toEqual({ status: 'failed', reason: 'apply-error' })
    expect(s.transition.pendingEntry).toBeNull()
    expect(s.names()).toEqual(['startEvents', 'rederive'])
  })

  it('例外がログに渡る（原因のエラーそのもの）', async () => {
    const s = setup()
    s.sceneIndex.setJumpSceneIndex([B])
    s.host.throwIn.add('startEvents')
    await s.ctrl.enter(progress('b'))
    expect((s.error.mock.calls[0][1] as Error).message).toBe('boom:startEvents')
  })

  it('run: enter の前段が投げても reject せず failed(apply-error) で解決する', async () => {
    const s = setup()
    vi.spyOn(s.transition, 'beginEntry').mockImplementation(() => {
      throw new Error('unexpected')
    })
    const r = await s.ctrl.run(progress('b'))
    expect(r).toEqual({ status: 'failed', reason: 'apply-error' })
    expect(s.error).toHaveBeenCalledTimes(1)
  })

  it('run: 通常は enter と同じ結果を返す', async () => {
    const s = setup()
    s.sceneIndex.setJumpSceneIndex([B])
    expect(await s.ctrl.run(progress('b', 'jump'))).toEqual({ status: 'entered', sceneId: 'b' })
  })
})

// ---------------------------------------------------------------------------
// restoreEntryStream（sceneId が null の復元, #768）
// ---------------------------------------------------------------------------
describe('restoreEntryStream', () => {
  it('エントリ未読み込み: not-found。位置・flags とも変えない（restoreToScene を呼ばない）', async () => {
    const s = setup()
    s.cursor.markStarted()
    const r = await s.ctrl.enter(saveReq(stateAt(null)))
    expect(r).toEqual({ status: 'failed', reason: 'not-found' })
    expect(s.names()).toEqual(['notify', 'rederive'])
    expect(s.calls[0][1]).toEqual({ kind: 'loadFailure' })
    expect(String(s.warn.mock.calls[0][0])).toContain('loadFromSaveData: ')
  })

  it('スナップショットで未読み込み: 失敗通知は無し', async () => {
    const s = setup()
    const r = await s.ctrl.enter(snapReq(stateAt(null)))
    expect(r).toEqual({ status: 'failed', reason: 'not-found' })
    expect(s.names()).toEqual([])
  })

  it('範囲外の復元は拒否する (#789)', async () => {
    const s = setup()
    s.sceneIndex.setEntry([narr('e1')], 'doc')
    const r = await s.ctrl.enter(saveReq(stateAt(null, 5)))
    expect(r).toEqual({ status: 'failed', reason: 'out-of-range' })
    expect(s.names()).toEqual(['notify'])
    expect(s.calls[0][1]).toEqual({ kind: 'loadFailure' })
  })

  it('sceneId はエントリの識別子に正規化する（null / 空文字 → エントリ ID）', async () => {
    const s = setup()
    s.sceneIndex.setEntry([narr('e1')], 'doc')
    await s.ctrl.enter(snapReq(stateAt(null)))
    await s.ctrl.enter(snapReq(stateAt('')))
    for (const call of s.calls) {
      const [, entry, state] = call as [string, EventScene, NovelGameState, boolean]
      expect(state.sceneId).toBe('doc')
      expect(entry.id).toBe('doc')
      expect(entry.events).toEqual(s.sceneIndex.getEntryEvents())
      // 渡す events は複製（Host が書き換えてもエントリを壊さない）
      expect(entry.events).not.toBe(s.sceneIndex.getEntryEvents())
    }
  })

  it('エントリに ID が無ければ sceneId は null、シーンの id は空文字', async () => {
    const s = setup()
    s.sceneIndex.setEntry([narr('e1')], null)
    const r = await s.ctrl.enter(saveReq(stateAt('')))
    expect(r).toEqual({ status: 'entered', sceneId: null })
    const [, entry, state] = s.calls[0] as [string, EventScene, NovelGameState, boolean]
    expect(entry.id).toBe('')
    expect(state.sceneId).toBeNull()
  })

  it('presetStoryEnded は snapshot のときだけ true', async () => {
    const s = setup()
    s.sceneIndex.setEntry([narr('e1')], 'doc')
    await s.ctrl.enter(saveReq(stateAt(null)))
    await s.ctrl.enter(snapReq(stateAt(null)))
    const presets = s.calls.filter((c) => c[0] === 'restoreToScene').map((c) => c[3])
    expect(presets).toEqual([false, true])
  })

  it('loadSuccess 通知はセーブ由来のときだけ（origin を引き継ぐ）', async () => {
    const s = setup()
    s.sceneIndex.setEntry([narr('e1')], 'doc')
    await s.ctrl.enter(saveReq(stateAt(null), 'auto'))
    await s.ctrl.enter(snapReq(stateAt(null)))
    const notices = s.calls.filter((c) => c[0] === 'notify').map((c) => c[1])
    expect(notices).toEqual([{ kind: 'loadSuccess', origin: 'auto' }])
  })

  it('同期の適用の例外は apply-error で解決する', async () => {
    const s = setup()
    s.sceneIndex.setEntry([narr('e1')], 'doc')
    s.host.throwIn.add('restoreToScene')
    expect(await s.ctrl.enter(saveReq(stateAt(null)))).toEqual({
      status: 'failed',
      reason: 'apply-error',
    })
  })
})

// ---------------------------------------------------------------------------
// リファレンス（切り出し前の分岐を写したもの）との突き合わせ
// ---------------------------------------------------------------------------
type Kind = 'choice' | 'jump' | 'fresh' | 'restoreSave' | 'restoreSnap'
type Res = 'sync' | 'none' | 'lazy' | 'lazyNull' | 'lazyReject'

interface Observed {
  result: SceneEntryResult
  calls: string[]
  stalled: boolean
}

/** 観測した Host 呼び出しを、リファレンスと同じ文字列に直す。 */
function describeCalls(calls: Call[]): string[] {
  return calls.map(([name, ...args]) => {
    if (name === 'notify') {
      const n = args[0] as EntryNotice
      return n.kind === 'sceneChange' ? 'notify:sceneChange' : `notify:${n.kind}`
    }
    if (name === 'restoreToScene') return `restoreToScene:preset=${String(args[2])}`
    return name
  })
}

/**
 * 切り出し前の `enterScene` → `finishEntry` / `failEntry` / `handleApplyError` の分岐を表にしたもの。
 * 旧実装の文面（`origin/main` の NovelRenderer）を読んで書いており、Controller は呼ばない。
 */
function referenceScene(c: { kind: Kind; res: Res; throws: boolean; started: boolean }): Observed {
  const calls: string[] = []
  const found = c.res === 'sync' || c.res === 'lazy'
  if (!found) {
    // failEntry
    const reason = c.res === 'lazyReject' ? 'resolver-error' : 'not-found'
    if (c.kind === 'jump') {
      return { result: { status: 'failed', reason }, calls, stalled: true }
    }
    if (c.kind === 'restoreSave') calls.push('notify:loadFailure')
    if (c.started) calls.push('rederive')
    return { result: { status: 'failed', reason }, calls, stalled: false }
  }
  // finishEntry
  if (c.kind === 'choice' || c.kind === 'jump') {
    calls.push('startEvents')
    if (!c.throws) calls.push('notify:sceneChange')
  } else if (c.kind === 'fresh') {
    calls.push('applyFreshContext', 'startEvents')
    if (!c.throws) calls.push('notify:sceneChange')
  } else {
    calls.push(`restoreToScene:preset=${c.kind === 'restoreSnap'}`)
    if (!c.throws && c.kind === 'restoreSave') calls.push('notify:loadSuccess')
  }
  if (c.throws) {
    // handleApplyError: 選択肢由来の進行だけ再表示し、それ以外は停止
    if (c.kind === 'choice') calls.push('rederive')
    return {
      result: { status: 'failed', reason: 'apply-error' },
      calls,
      stalled: c.kind !== 'choice',
    }
  }
  return { result: { status: 'entered', sceneId: 'b' }, calls, stalled: false }
}

async function runScene(c: {
  kind: Kind
  res: Res
  throws: boolean
  started: boolean
}): Promise<Observed> {
  const s = setup()
  if (c.res === 'sync') s.sceneIndex.setJumpSceneIndex([B])
  if (c.res === 'lazy') s.sceneIndex.setMissingSceneResolver(() => Promise.resolve([B]))
  if (c.res === 'lazyNull') s.sceneIndex.setMissingSceneResolver(() => Promise.resolve(null))
  if (c.res === 'lazyReject')
    s.sceneIndex.setMissingSceneResolver(() => Promise.reject(new Error('x')))
  if (c.started) s.cursor.markStarted()
  if (c.throws)
    s.host.throwIn.add(
      c.kind === 'restoreSave' || c.kind === 'restoreSnap' ? 'restoreToScene' : 'startEvents'
    )
  s.armJump()
  const req: SceneEntryRequest =
    c.kind === 'choice'
      ? progress('b')
      : c.kind === 'jump'
        ? progress('b', 'jump')
        : c.kind === 'fresh'
          ? freshReq('b')
          : c.kind === 'restoreSave'
            ? saveReq(stateAt('b'))
            : snapReq(stateAt('b'))
  const result = await s.ctrl.enter(req)
  return { result, calls: describeCalls(s.calls), stalled: s.transition.jumpState === 'stalled' }
}

describe('旧実装の分岐との突き合わせ', () => {
  it('種類 × 解決結果 × 例外 × 再生開始済み（100通り）で、結果・Host 呼び出し列・停止が旧分岐の表と一致する', async () => {
    const kinds: Kind[] = ['choice', 'jump', 'fresh', 'restoreSave', 'restoreSnap']
    const resolutions: Res[] = ['sync', 'none', 'lazy', 'lazyNull', 'lazyReject']
    const seen = {
      entered: 0,
      notFound: 0,
      resolverError: 0,
      applyError: 0,
      rederive: 0,
      stalled: 0,
    }
    let total = 0
    for (const kind of kinds) {
      for (const res of resolutions) {
        for (const throws of [false, true]) {
          for (const started of [false, true]) {
            const c = { kind, res, throws, started }
            const actual = await runScene(c)
            const expected = referenceScene(c)
            expect(actual, JSON.stringify(c)).toEqual(expected)
            total++
            const r = actual.result
            if (r.status === 'entered') seen.entered++
            if (r.status === 'failed' && r.reason === 'not-found') seen.notFound++
            if (r.status === 'failed' && r.reason === 'resolver-error') seen.resolverError++
            if (r.status === 'failed' && r.reason === 'apply-error') seen.applyError++
            if (actual.calls.includes('rederive')) seen.rederive++
            if (actual.stalled) seen.stalled++
          }
        }
      }
    }
    // 非空虚性: 各分岐に実際に到達している
    expect(total).toBe(100)
    expect(seen.entered).toBeGreaterThanOrEqual(10)
    expect(seen.notFound).toBeGreaterThanOrEqual(20)
    expect(seen.resolverError).toBeGreaterThanOrEqual(10)
    expect(seen.applyError).toBeGreaterThanOrEqual(10)
    expect(seen.rederive).toBeGreaterThanOrEqual(10)
    expect(seen.stalled).toBeGreaterThanOrEqual(10)
  })

  it('エントリ・sceneId null の復元・confinement 圏外の進行（64通り）が旧分岐の表と一致する', async () => {
    type K2 = 'freshEntry' | 'restoreNullSave' | 'restoreNullSnap' | 'progressOutside'
    const kinds: K2[] = ['freshEntry', 'restoreNullSave', 'restoreNullSnap', 'progressOutside']
    let total = 0
    const kindsSeen = new Set<string>()
    for (const kind of kinds) {
      for (const hasEntry of [false, true]) {
        for (const entryId of [null, 'doc'] as const) {
          for (const throws of [false, true]) {
            for (const started of [false, true]) {
              const s = setup()
              s.sceneIndex.setJumpSceneIndex([A])
              if (hasEntry) s.sceneIndex.setEntry([narr('e')], entryId)
              else s.sceneIndex.setEntry([], entryId)
              if (kind === 'progressOutside') {
                await s.ctrl.enter(freshReq('a', { confinedSceneIds: ['a'] }))
                s.reset()
              }
              if (started) s.cursor.markStarted()
              if (throws)
                s.host.throwIn.add(kind === 'freshEntry' ? 'startEvents' : 'restoreToScene')
              s.armJump()
              const req: SceneEntryRequest =
                kind === 'freshEntry'
                  ? freshReq('entry')
                  : kind === 'restoreNullSave'
                    ? saveReq(stateAt(null))
                    : kind === 'restoreNullSnap'
                      ? snapReq(stateAt(null))
                      : progress('elsewhere')
              const result = await s.ctrl.enter(req)
              const actual: Observed = {
                result,
                calls: describeCalls(s.calls),
                stalled: s.transition.jumpState === 'stalled',
              }

              // リファレンス（旧 enterScene の分岐）
              const calls: string[] = []
              let expected: Observed
              if (kind === 'progressOutside') {
                calls.push('endStory')
                expected = { result: { status: 'ended' }, calls, stalled: false }
              } else if (kind === 'freshEntry') {
                calls.push('applyFreshContext', 'startEvents')
                if (throws) {
                  expected = {
                    result: { status: 'failed', reason: 'apply-error' },
                    calls,
                    stalled: true,
                  }
                } else {
                  if (entryId !== null) calls.push('notify:sceneChange')
                  expected = {
                    result: { status: 'entered', sceneId: entryId },
                    calls,
                    stalled: false,
                  }
                }
              } else if (!hasEntry) {
                if (kind === 'restoreNullSave') calls.push('notify:loadFailure')
                if (started) calls.push('rederive')
                expected = {
                  result: { status: 'failed', reason: 'not-found' },
                  calls,
                  stalled: false,
                }
              } else {
                calls.push(`restoreToScene:preset=${kind === 'restoreNullSnap'}`)
                if (throws) {
                  expected = {
                    result: { status: 'failed', reason: 'apply-error' },
                    calls,
                    stalled: true,
                  }
                } else {
                  if (kind === 'restoreNullSave') calls.push('notify:loadSuccess')
                  expected = {
                    result: { status: 'entered', sceneId: entryId },
                    calls,
                    stalled: false,
                  }
                }
              }
              expect(actual, JSON.stringify({ kind, hasEntry, entryId, throws, started })).toEqual(
                expected
              )
              total++
              kindsSeen.add(`${kind}:${actual.result.status}`)
            }
          }
        }
      }
    }
    expect(total).toBe(64)
    // 非空虚性: 種類ごとに成功・失敗の両方（progressOutside は ended のみ）に到達している
    expect(kindsSeen).toEqual(
      new Set([
        'freshEntry:entered',
        'freshEntry:failed',
        'restoreNullSave:entered',
        'restoreNullSave:failed',
        'restoreNullSnap:entered',
        'restoreNullSnap:failed',
        'progressOutside:ended',
      ])
    )
  })
})
