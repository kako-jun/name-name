/**
 * TransitionState（遷移ゲート・Jump 予約・世代・入力抑制の状態機械）の単体テスト (#825, #735 4/8)。
 *
 * `NovelRenderer` は import しない（Pixi・DOM に依存しないことの確認も兼ねる）。タイマーは virtual モードの
 * TimeController で駆動する。ADR 0003 の契約（予約の取り消しはすべて clear() 経由で superseded 解決・arm は
 * 予約時点で pendingEntry を立てる・advanceGeneration は pendingEntry を下ろす・上限超過は stalled）を
 * 状態機械のテストにする。
 *
 * 切り出し前の `NovelRenderer`（`origin/main`）の `armJump` / `clearJumpTimer` / `stallJump` /
 * `advanceGeneration` / `awaitPendingEntry` / `isTransitionGated`（`sceneEntry.ts` の `gateReason`）を
 * 「リファレンス」としてこのファイルに写し、操作列で突き合わせる（doctrine 規律3）。リファレンスは
 * TransitionState のコードを呼ばない。期待値に定数計算を直書きしない（上限は `JUMP_CHAIN_LIMIT` と独立に
 * 数え直した回数で数える）。
 */
import { describe, it, expect, vi } from 'vitest'
import { TimeController } from './TimeController'
import {
  JUMP_CHAIN_LIMIT,
  TransitionState,
  type JumpFireHandlers,
  type JumpState,
} from './TransitionState'
import {
  createDeferred,
  type GatedOperation,
  type GateReason,
  type SceneEntryResult,
} from './sceneEntry'

// --- fixture ---

const flush = async (): Promise<void> => {
  for (let i = 0; i < 6; i++) await Promise.resolve()
}

interface Rig {
  time: TimeController
  state: TransitionState
  onStall: ReturnType<typeof vi.fn>
}

function rig(): Rig {
  const time = new TimeController()
  time.setMode('virtual')
  const onStall = vi.fn()
  const state = new TransitionState(time, onStall)
  return { time, state, onStall }
}

interface FakeHandlers extends JumpFireHandlers {
  active: boolean
  enters: number
  warns: number
  /** enter() が返す Promise を差し替える（既定は即 entered）。 */
  enterImpl: () => Promise<SceneEntryResult>
}

function handlers(): FakeHandlers {
  const h: FakeHandlers = {
    active: true,
    enters: 0,
    warns: 0,
    enterImpl: () => Promise.resolve({ status: 'entered', sceneId: 'x' }),
    isActive: () => h.active,
    warnChainLimit: () => {
      h.warns++
    },
    enter: () => {
      h.enters++
      return h.enterImpl()
    },
  }
  return h
}

/** Promise の決着を観測する。 */
function watch<T>(p: Promise<T>): { settled: boolean; value: T | undefined } {
  const w: { settled: boolean; value: T | undefined } = { settled: false, value: undefined }
  void p.then((v) => {
    w.settled = true
    w.value = v
  })
  return w
}

const SUPERSEDED: SceneEntryResult = { status: 'superseded' }
const ENTRY_STUB = (generation = 0) => ({
  generation,
  kind: 'progress' as const,
  sceneId: 'z',
  promise: new Promise<SceneEntryResult>(() => {}),
})

// --- ゲート判定: 旧規則を写したオラクル ---

/**
 * 旧 `isTransitionGated` / `gateReason`（`origin/main` の sceneEntry.ts）を写したオラクル。
 * 優先: 入場中 > 予約中の Jump > 停止中の Jump（advance・quickSave・saveMenu のみ）> 選択肢 > 待機。
 * 選択肢・待機で止めるのは advance・quickSave・navigate・autoAdvance だけ。
 */
const OPS: GatedOperation[] = [
  'advance',
  'quickSave',
  'saveMenu',
  'navigate',
  'autoAdvance',
  'loadMenu',
  'confirmChoice',
]
const STALL_BLOCKS = new Set<GatedOperation>(['advance', 'quickSave', 'saveMenu'])
const CHOICE_WAIT_BLOCKS = new Set<GatedOperation>([
  'advance',
  'quickSave',
  'navigate',
  'autoAdvance',
])

function oracleGate(
  op: GatedOperation,
  s: { choice: boolean; wait: boolean; jump: JumpState; entry: boolean }
): GateReason | null {
  if (s.entry) return 'entry'
  if (s.jump === 'pending') return 'jump'
  if (s.jump === 'stalled' && STALL_BLOCKS.has(op)) return 'stalled'
  if (s.choice && CHOICE_WAIT_BLOCKS.has(op)) return 'choice'
  if (s.wait && CHOICE_WAIT_BLOCKS.has(op)) return 'wait'
  return null
}

/** 公開 API だけで目的の組み合わせの状態を作る。 */
function buildState(s: {
  choice: boolean
  wait: boolean
  jump: JumpState
  entry: boolean
}): Rig & { h: FakeHandlers } {
  const r = rig()
  const h = handlers()
  if (s.choice) r.state.enterChoiceWait()
  if (s.wait) r.state.enterWait()
  if (s.jump !== 'idle') {
    r.state.arm('t', h)
    if (s.jump === 'stalled') r.state.stall()
    // arm は pendingEntry も立てるので、入場中の有無は組み合わせの指定どおりに揃える
    r.state.clearPendingEntry()
  }
  if (s.entry) r.state.setPendingEntry(ENTRY_STUB())
  return { ...r, h }
}

describe('ゲート判定（旧規則のオラクルとの全組合せ照合）', () => {
  const bools = [false, true]
  const jumps: JumpState[] = ['idle', 'pending', 'stalled']
  const cases: Array<{ choice: boolean; wait: boolean; jump: JumpState; entry: boolean }> = []
  for (const choice of bools)
    for (const wait of bools)
      for (const jump of jumps) for (const entry of bools) cases.push({ choice, wait, jump, entry })

  it('組合せの件数: 2×2×3×2 = 24 状態 × 7 操作', () => {
    expect(cases).toHaveLength(bools.length * bools.length * jumps.length * bools.length)
    expect(OPS).toHaveLength(7)
  })

  it('gateReason / isGated は全 168 組合せで旧規則と一致する', () => {
    let checked = 0
    let blocked = 0
    const reasonsSeen = new Set<GateReason>()
    for (const c of cases) {
      const { state } = buildState(c)
      // 状態の作り方が意図どおりか（オラクル側の入力と実状態のずれを検出する）
      expect(state.waitingForChoice).toBe(c.choice)
      expect(state.waitingForWait).toBe(c.wait)
      expect(state.jumpState).toBe(c.jump)
      expect(state.hasPendingEntry).toBe(c.entry)
      for (const op of OPS) {
        const expected = oracleGate(op, c)
        expect(state.gateReason(op), JSON.stringify({ op, ...c })).toBe(expected)
        expect(state.isGated(op), JSON.stringify({ op, ...c })).toBe(expected !== null)
        checked++
        if (expected !== null) {
          blocked++
          reasonsSeen.add(expected)
        }
      }
    }
    expect(checked).toBe(cases.length * OPS.length)
    // 非空虚: 止まる組合せ・止まらない組合せの両方があり、5 種の理由がすべて現れる
    expect(blocked).toBeGreaterThan(0)
    expect(blocked).toBeLessThan(checked)
    expect([...reasonsSeen].sort()).toEqual(['choice', 'entry', 'jump', 'stalled', 'wait'])
  })

  it('gateState() は4つの独立フィールドをそのまま返す', () => {
    const { state } = buildState({ choice: true, wait: false, jump: 'stalled', entry: true })
    expect(state.gateState()).toEqual({
      waitingForChoice: true,
      waitingForWait: false,
      jumpState: 'stalled',
      hasPendingEntry: true,
    })
  })
})

// --- arm ---

describe('arm（Jump の予約）', () => {
  it('予約の時点（タイマー発火前）で pendingEntry と jumpState=pending が立ち、世代が +1 される', () => {
    const { state, time } = rig()
    const g0 = state.generation
    state.arm('far', handlers())
    expect(time.getPendingTimerCount()).toBe(1)
    expect(state.jumpState).toBe('pending')
    expect(state.isJumpPending()).toBe(true)
    expect(state.hasPendingEntry).toBe(true)
    expect(state.pendingEntry).toMatchObject({
      generation: state.generation,
      kind: 'progress',
      sceneId: 'far',
    })
    expect(state.generation).toBe(g0 + 1)
  })

  it('予約中は enter も呼ばれない（次の macrotask で発火する）', () => {
    const { state } = rig()
    const h = handlers()
    state.arm('far', h)
    expect(h.enters).toBe(0)
  })

  it('発火すると enter が呼ばれ、その結果で予約の Promise が解決する（pendingEntry は enterScene 側が引き継ぐ）', async () => {
    const { state, time } = rig()
    const h = handlers()
    state.arm('far', h)
    const waiting = state.pendingEntry!.promise
    time.tick(1)
    await flush()
    expect(h.enters).toBe(1)
    await expect(waiting).resolves.toEqual({ status: 'entered', sceneId: 'x' })
  })

  it('再 arm で前の deferred は superseded で解決され、タイマーは1本だけ残る', async () => {
    const { state, time } = rig()
    const h1 = handlers()
    const h2 = handlers()
    state.arm('a', h1)
    const first = state.pendingEntry!.promise
    const g1 = state.generation
    state.arm('b', h2)
    const second = state.pendingEntry!.promise
    expect(second).not.toBe(first)
    expect(state.generation).toBe(g1 + 1)
    expect(time.getPendingTimerCount()).toBe(1)
    await expect(first).resolves.toEqual(SUPERSEDED)
    time.tick(1)
    await flush()
    expect(h1.enters).toBe(0)
    expect(h2.enters).toBe(1)
  })
})

// --- clear ---

describe('clear（予約の取り消し）', () => {
  it('jumpState を触らない（pending のまま）', () => {
    const { state } = rig()
    state.arm('a', handlers())
    state.clear()
    expect(state.jumpState).toBe('pending')
  })

  it('stalled も触らない', () => {
    const { state } = rig()
    state.arm('a', handlers())
    state.stall()
    state.clear()
    expect(state.jumpState).toBe('stalled')
  })

  it('pendingEntry が自分の deferred と一致するときだけ下ろす（別の入場に置き換わっていれば残す）', async () => {
    const { state } = rig()
    state.arm('a', handlers())
    const mine = state.pendingEntry!.promise
    const other = ENTRY_STUB(99)
    state.setPendingEntry(other)
    state.clear()
    expect(state.pendingEntry).toBe(other)
    await expect(mine).resolves.toEqual(SUPERSEDED)
  })

  it('自分の deferred が pendingEntry のときは下ろす', () => {
    const { state } = rig()
    state.arm('a', handlers())
    state.clear()
    expect(state.pendingEntry).toBeNull()
  })

  it('タイマー発火後は deferred を解決しない（enterScene の結果に任せる）', async () => {
    const { state, time } = rig()
    const h = handlers()
    const never = createDeferred<SceneEntryResult>()
    h.enterImpl = () => never.promise
    state.arm('a', h)
    const waiting = watch(state.pendingEntry!.promise)
    time.tick(1)
    await flush()
    state.clear()
    await flush()
    expect(waiting.settled).toBe(false)
    // enterScene の結果が来て初めて解決する
    never.resolve({ status: 'entered', sceneId: 'a' })
    await flush()
    expect(waiting.value).toEqual({ status: 'entered', sceneId: 'a' })
  })

  it('予約が無ければ何も起きない', () => {
    const { state } = rig()
    expect(() => state.clear()).not.toThrow()
    expect(state.jumpState).toBe('idle')
  })
})

describe('予約中の Jump を取り消す経路はすべて clear() を通り superseded で解決する', () => {
  const entrances: Array<[string, (s: TransitionState) => void]> = [
    ['clear()', (s) => s.clear()],
    ['再 arm', (s) => s.arm('other', handlers())],
    ['beginEntry', (s) => void s.beginEntry()],
    ['resetForNewPosition', (s) => s.resetForNewPosition()],
    ['resetJumpForRestore', (s) => s.resetJumpForRestore()],
    ['dispose', (s) => s.dispose()],
  ]

  it.each(entrances)(
    '%s: タイマーが止まり、待っている側が superseded で解決される',
    async (name, act) => {
      const { state, time } = rig()
      const h = handlers()
      state.arm('a', h)
      const waiting = state.pendingEntry!.promise
      const w = watch(waiting)
      expect(time.getPendingTimerCount()).toBe(1)

      act(state)
      await flush()

      expect(w.settled, name).toBe(true)
      expect(w.value, name).toEqual(SUPERSEDED)
      // 取り消した予約は発火しない
      time.tick(10)
      await flush()
      expect(h.enters, name).toBe(0)
      // 再 arm 以外はタイマーが残らない
      if (name !== '再 arm') expect(time.getPendingTimerCount(), name).toBe(0)
    }
  )

  it.each(entrances)(
    '%s: 取り消し後に pendingEntry が予約の Promise のまま残らない',
    (name, act) => {
      const { state } = rig()
      state.arm('a', handlers())
      const mine = state.pendingEntry!.promise
      act(state)
      expect(state.pendingEntry?.promise, name).not.toBe(mine)
    }
  )
})

// --- advanceGeneration / beginEntry / isStale ---

describe('世代', () => {
  it('advanceGeneration は世代を進め、pendingEntry を下ろす', () => {
    const { state } = rig()
    state.setPendingEntry(ENTRY_STUB())
    const g = state.generation
    state.advanceGeneration()
    expect(state.generation).toBe(g + 1)
    expect(state.pendingEntry).toBeNull()
  })

  it('advanceGeneration は jumpState を触らない', () => {
    const { state } = rig()
    state.arm('a', handlers())
    state.advanceGeneration()
    expect(state.jumpState).toBe('pending')
  })

  it('beginEntry は新しい世代を返し、jumpState（pending / stalled）を保ち、pendingEntry を下ろす', () => {
    const a = rig()
    a.state.arm('x', handlers())
    const g = a.state.generation
    expect(a.state.beginEntry()).toBe(g + 1)
    expect(a.state.generation).toBe(g + 1)
    expect(a.state.jumpState).toBe('pending')
    expect(a.state.pendingEntry).toBeNull()

    const b = rig()
    b.state.arm('x', handlers())
    b.state.stall()
    b.state.beginEntry()
    expect(b.state.jumpState).toBe('stalled')
  })

  it('isStale: 捕捉した世代と現在の世代を比較する', () => {
    const { state } = rig()
    const captured = state.beginEntry()
    expect(state.isStale(captured)).toBe(false)
    state.advanceGeneration()
    expect(state.isStale(captured)).toBe(true)
    expect(state.isStale(state.generation)).toBe(false)
    const next = state.beginEntry()
    expect(state.isStale(next)).toBe(false)
    expect(state.isStale(captured)).toBe(true)
  })

  it('arm による世代の進行も古い捕捉を stale にする', () => {
    const { state } = rig()
    const captured = state.beginEntry()
    state.arm('a', handlers())
    expect(state.isStale(captured)).toBe(true)
  })

  it('settlePendingEntry: 世代が一致するときだけ下ろす', () => {
    const { state } = rig()
    state.setPendingEntry(ENTRY_STUB(5))
    state.settlePendingEntry(4)
    expect(state.hasPendingEntry).toBe(true)
    state.settlePendingEntry(5)
    expect(state.hasPendingEntry).toBe(false)
  })
})

// --- stall ---

describe('stall', () => {
  it('pending のときだけ true を返し、onStall を1回呼んで stalled にする', () => {
    const { state, onStall } = rig()
    state.arm('a', handlers())
    expect(state.stall()).toBe(true)
    expect(state.jumpState).toBe('stalled')
    expect(state.isJumpStalled()).toBe(true)
    expect(onStall).toHaveBeenCalledTimes(1)
  })

  it('idle では no-op で false', () => {
    const { state, onStall } = rig()
    expect(state.stall()).toBe(false)
    expect(state.jumpState).toBe('idle')
    expect(onStall).not.toHaveBeenCalled()
  })

  it('stalled では no-op で false（onStall は再度呼ばれない）', () => {
    const { state, onStall } = rig()
    state.arm('a', handlers())
    state.stall()
    expect(state.stall()).toBe(false)
    expect(state.jumpState).toBe('stalled')
    expect(onStall).toHaveBeenCalledTimes(1)
  })

  it('settleJumpIdle: pending だけを idle にする（stalled は触らない）', () => {
    const a = rig()
    a.state.arm('a', handlers())
    a.state.settleJumpIdle()
    expect(a.state.jumpState).toBe('idle')

    const b = rig()
    b.state.arm('a', handlers())
    b.state.stall()
    b.state.settleJumpIdle()
    expect(b.state.jumpState).toBe('stalled')
  })
})

// --- JUMP_CHAIN_LIMIT ---

describe('JUMP_CHAIN_LIMIT（連鎖の上限）', () => {
  /** arm して発火させる（renderer の Jump 連鎖: 発火 → 次の Jump に着いて再 arm）。 */
  async function hop(r: Rig, h: FakeHandlers): Promise<void> {
    r.state.arm('t', h)
    r.time.tick(1)
    await flush()
  }

  it('noteChainHop: 上限回までは ok、上限+1 回目で limit、resetChain で戻る', () => {
    const { state } = rig()
    let oks = 0
    for (let i = 0; i < JUMP_CHAIN_LIMIT; i++) if (state.noteChainHop() === 'ok') oks++
    expect(oks).toBe(JUMP_CHAIN_LIMIT)
    expect(state.noteChainHop()).toBe('limit')
    expect(state.noteChainHop()).toBe('limit')
    state.resetChain()
    expect(state.noteChainHop()).toBe('ok')
  })

  it('JUMP_CHAIN_LIMIT は 100（TUI の RELAY_HOP_LIMIT と同値）', () => {
    expect(JUMP_CHAIN_LIMIT).toBe(100)
  })

  it('上限回の発火までは入場し、次の発火で警告・stalled・pendingEntry 解除・failed(not-found)', async () => {
    const r = rig()
    const h = handlers()
    for (let i = 0; i < JUMP_CHAIN_LIMIT; i++) await hop(r, h)
    expect(h.enters).toBe(JUMP_CHAIN_LIMIT)
    expect(h.warns).toBe(0)
    expect(r.state.jumpState).toBe('pending')

    r.state.arm('t', h)
    const waiting = r.state.pendingEntry!.promise
    r.time.tick(1)
    await flush()
    expect(h.enters).toBe(JUMP_CHAIN_LIMIT)
    expect(h.warns).toBe(1)
    expect(r.state.jumpState).toBe('stalled')
    expect(r.state.pendingEntry).toBeNull()
    expect(r.onStall).toHaveBeenCalledTimes(1)
    await expect(waiting).resolves.toEqual({ status: 'failed', reason: 'not-found' })
  })

  it('resetChain を挟むと上限に達しない', async () => {
    const r = rig()
    const h = handlers()
    for (let i = 0; i < JUMP_CHAIN_LIMIT; i++) await hop(r, h)
    r.state.resetChain()
    await hop(r, h)
    expect(h.warns).toBe(0)
    expect(r.state.jumpState).toBe('pending')
    expect(h.enters).toBe(JUMP_CHAIN_LIMIT + 1)
  })

  it('isActive() が false の発火は superseded で解決し、連鎖を数えない・enter しない・pending のまま', async () => {
    const r = rig()
    const h = handlers()
    h.active = false
    // 上限を超える回数だけ非活性で発火しても、数えないので警告されない
    for (let i = 0; i < JUMP_CHAIN_LIMIT + 5; i++) {
      r.state.arm('t', h)
      const waiting = r.state.pendingEntry!.promise
      r.time.tick(1)
      await flush()
      await expect(waiting).resolves.toEqual(SUPERSEDED)
    }
    expect(h.enters).toBe(0)
    expect(h.warns).toBe(0)
    expect(r.state.jumpState).toBe('pending')
    // その後に活性で発火しても上限扱いにならない
    h.active = true
    await hop(r, h)
    expect(h.enters).toBe(1)
    expect(h.warns).toBe(0)
  })

  it('上限超過の発火で、すでに別の pendingEntry に置き換わっていればそれは下ろさない', async () => {
    const r = rig()
    const h = handlers()
    for (let i = 0; i < JUMP_CHAIN_LIMIT; i++) await hop(r, h)
    r.state.arm('t', h)
    const other = ENTRY_STUB(77)
    r.state.setPendingEntry(other)
    r.time.tick(1)
    await flush()
    expect(h.warns).toBe(1)
    expect(r.state.pendingEntry).toBe(other)
  })
})

// --- awaitPending ---

describe('awaitPending', () => {
  it('入場が無ければ待たずに false', async () => {
    const { state } = rig()
    await expect(state.awaitPending()).resolves.toBe(false)
  })

  it('待っている間に入場が下りれば true（待った）', async () => {
    const { state } = rig()
    const d = createDeferred<SceneEntryResult>()
    state.setPendingEntry({ ...ENTRY_STUB(), promise: d.promise })
    const w = watch(state.awaitPending())
    await flush()
    expect(w.settled).toBe(false)
    state.clearPendingEntry()
    d.resolve({ status: 'entered', sceneId: 'z' })
    await flush()
    expect(w.value).toBe(true)
  })

  it('解決したのに同じ入場が残っていれば false（待ち直さない・防御）', async () => {
    const { state } = rig()
    const d = createDeferred<SceneEntryResult>()
    state.setPendingEntry({ ...ENTRY_STUB(), promise: d.promise })
    const w = watch(state.awaitPending())
    d.resolve({ status: 'entered', sceneId: 'z' })
    await flush()
    expect(w.value).toBe(false)
  })

  it('予約中の Jump の取り消しでも待ちは止まらず true で戻る', async () => {
    const { state } = rig()
    state.arm('a', handlers())
    const w = watch(state.awaitPending())
    await flush()
    expect(w.settled).toBe(false)
    state.clear()
    await flush()
    expect(w.value).toBe(true)
  })
})

// --- resetForNewPosition / resetJumpForRestore ---

describe('resetForNewPosition / resetJumpForRestore', () => {
  function dirty(): Rig & { h: FakeHandlers } {
    const r = rig()
    const h = handlers()
    r.state.enterChoiceWait()
    r.state.enterWait()
    r.state.arm('a', h)
    return { ...r, h }
  }

  it('resetForNewPosition: 選択肢・待機も下ろし、jumpState を idle、世代 +1、deferred を superseded、pendingEntry を下ろす', async () => {
    const { state } = dirty()
    const waiting = state.pendingEntry!.promise
    const g = state.generation
    state.resetForNewPosition()
    expect(state.waitingForChoice).toBe(false)
    expect(state.waitingForWait).toBe(false)
    expect(state.jumpState).toBe('idle')
    expect(state.generation).toBe(g + 1)
    expect(state.pendingEntry).toBeNull()
    await expect(waiting).resolves.toEqual(SUPERSEDED)
  })

  it('resetForNewPosition: 停止中の Jump も持ち越さず idle に戻す', () => {
    const { state } = dirty()
    state.stall()
    state.resetForNewPosition()
    expect(state.jumpState).toBe('idle')
  })

  it('resetJumpForRestore: 選択肢・待機は触らず、jumpState を idle、世代 +1、deferred を superseded', async () => {
    const { state } = dirty()
    const waiting = state.pendingEntry!.promise
    const g = state.generation
    state.resetJumpForRestore()
    expect(state.waitingForChoice).toBe(true)
    expect(state.waitingForWait).toBe(true)
    expect(state.jumpState).toBe('idle')
    expect(state.generation).toBe(g + 1)
    expect(state.pendingEntry).toBeNull()
    await expect(waiting).resolves.toEqual(SUPERSEDED)
  })

  it('resetJumpForRestore: stalled を持ち越さない（復元のたびに再試行できる）', () => {
    const { state } = dirty()
    state.stall()
    expect(state.jumpState).toBe('stalled')
    state.resetJumpForRestore()
    expect(state.jumpState).toBe('idle')
  })

  it('どちらも idle からでも世代を進める', () => {
    const { state } = rig()
    const g = state.generation
    state.resetJumpForRestore()
    state.resetForNewPosition()
    expect(state.generation).toBe(g + 2)
  })
})

// --- 入力抑制 ---

describe('入力抑制', () => {
  it('markChoiceJustSelected: 立ち、setTimeout(0) で自動的に下りる', () => {
    const { state, time } = rig()
    state.markChoiceJustSelected()
    expect(time.getPendingTimerCount()).toBe(1)
    time.tick(1)
    expect(state.consumeJustSelectedChoice()).toBe(false)
  })

  it('markChoiceJustSelected: 立っている間は consume が1回だけ true', () => {
    const { state } = rig()
    state.markChoiceJustSelected()
    expect(state.consumeJustSelectedChoice()).toBe(true)
    expect(state.consumeJustSelectedChoice()).toBe(false)
  })

  it('markChoiceJustSelected: 立てる前は false', () => {
    const { state } = rig()
    expect(state.consumeJustSelectedChoice()).toBe(false)
  })

  it('clearJustSelectedChoice: 消費せずに下ろす', () => {
    const { state } = rig()
    state.markChoiceJustSelected()
    state.clearJustSelectedChoice()
    expect(state.consumeJustSelectedChoice()).toBe(false)
  })

  it('suppressNextAdvance: consume が1回だけ true（自動解除はしない）', () => {
    const { state, time } = rig()
    expect(state.consumeSuppressNextAdvance()).toBe(false)
    state.suppressNextAdvance()
    time.tick(1000)
    expect(state.consumeSuppressNextAdvance()).toBe(true)
    expect(state.consumeSuppressNextAdvance()).toBe(false)
  })

  it('選択肢・待機の出入り', () => {
    const { state } = rig()
    state.enterChoiceWait()
    state.enterWait()
    expect(state.waitingForChoice).toBe(true)
    expect(state.waitingForWait).toBe(true)
    state.leaveChoiceWait()
    state.leaveWait()
    expect(state.waitingForChoice).toBe(false)
    expect(state.waitingForWait).toBe(false)
  })
})

// --- 旧実装との等価性 ---

/**
 * 旧 `NovelRenderer` の `armJump` / `clearJumpTimer` / `stallJump` / `advanceGeneration`（`origin/main`）を
 * 写したリファレンス。TransitionState のコードは使わない（`createDeferred` の純粋ユーティリティのみ共有）。
 */
class OldJumpModel {
  jumpState: JumpState = 'idle'
  transitionGeneration = 0
  pendingEntry: { promise: Promise<SceneEntryResult> } | null = null
  private jumpTimerFn: (() => void) | null = null
  private jumpDeferred: ReturnType<typeof createDeferred<SceneEntryResult>> | null = null
  consecutiveJumps = 0
  stalls = 0

  constructor(
    private readonly log: string[],
    private readonly env: { active: boolean }
  ) {}

  armJump(id: number): void {
    this.clearJumpTimer()
    this.transitionGeneration++
    this.jumpState = 'pending'
    const deferred = createDeferred<SceneEntryResult>()
    this.jumpDeferred = deferred
    this.pendingEntry = { promise: deferred.promise }
    this.jumpTimerFn = () => {
      this.jumpTimerFn = null
      this.jumpDeferred = null
      if (!this.env.active) {
        deferred.resolve({ status: 'superseded' })
        return
      }
      this.consecutiveJumps++
      if (this.consecutiveJumps > 100) {
        this.log.push(`warn${id}`)
        if (this.pendingEntry?.promise === deferred.promise) this.pendingEntry = null
        this.stallJump()
        deferred.resolve({ status: 'failed', reason: 'not-found' })
        return
      }
      this.log.push(`enter${id}`)
      void Promise.resolve({ status: 'entered', sceneId: 'x' } as SceneEntryResult).then(
        deferred.resolve
      )
    }
    void deferred.promise.then((v) => this.log.push(`resolve${id}:${v.status}`))
  }

  fire(): void {
    this.jumpTimerFn?.()
  }

  clearJumpTimer(): void {
    this.jumpTimerFn = null
    const deferred = this.jumpDeferred
    if (deferred) {
      this.jumpDeferred = null
      if (this.pendingEntry?.promise === deferred.promise) this.pendingEntry = null
      deferred.resolve({ status: 'superseded' })
    }
  }

  stallJump(): void {
    if (this.jumpState === 'pending') {
      this.jumpState = 'stalled'
      this.stalls++
    }
  }

  advanceGeneration(): void {
    this.transitionGeneration++
    this.pendingEntry = null
  }

  beginEntry(): void {
    this.transitionGeneration++
    this.clearJumpTimer()
    this.pendingEntry = null
  }

  /** 旧 `resetAndStartEvents` / `applyState` の重複ブロック。 */
  resetJumpForRestore(): void {
    this.jumpState = 'idle'
    this.advanceGeneration()
    this.clearJumpTimer()
  }

  dispose(): void {
    this.clearJumpTimer()
    this.pendingEntry = null
  }
}

type Op =
  | 'arm'
  | 'fire'
  | 'clear'
  | 'advance'
  | 'begin'
  | 'resetChain'
  | 'resetRestore'
  | 'stall'
  | 'dispose'
  | 'toggleActive'
  | 'setPending'
  | 'clearPending'

/** 固定シードの擬似乱数（mulberry32）。 */
function prng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// 連鎖が上限に届くよう arm / fire を厚く、resetChain を薄くする
const WEIGHTED: Array<[Op, number]> = [
  ['arm', 40],
  ['fire', 40],
  ['clear', 2],
  ['advance', 2],
  ['begin', 2],
  ['resetChain', 1],
  ['resetRestore', 2],
  ['stall', 2],
  ['dispose', 1],
  ['toggleActive', 2],
  ['setPending', 2],
  ['clearPending', 2],
]

// 連鎖を途切れさせる操作（resetChain・取り消し系）をほぼ除き、上限に届く列を作る
const QUIET_OPS = new Set<Op>([
  'clear',
  'advance',
  'begin',
  'resetChain',
  'dispose',
  'toggleActive',
])

/** 固定シード 4 以降は連鎖が上限へ届きやすい重みで引く。 */
function pickOp(rand: () => number, quiet = false): Op {
  const weights = WEIGHTED.map(([op, w]) => [op, quiet && QUIET_OPS.has(op) ? 0 : w] as const)
  const total = weights.reduce((n, [, w]) => n + w, 0)
  let x = rand() * total
  for (const [op, w] of weights) {
    x -= w
    if (x < 0) return op
  }
  return 'arm'
}

describe('旧実装との等価性（操作列の突き合わせ）', () => {
  it('arm → 発火 → 連鎖: 上限を含む遷移列が旧 armJump と一致する', async () => {
    const sutLog: string[] = []
    const env = { active: true }
    const r = rig()
    const sutHandlers = (id: number): JumpFireHandlers => ({
      isActive: () => env.active,
      warnChainLimit: () => sutLog.push(`warn${id}`),
      enter: () => {
        sutLog.push(`enter${id}`)
        return Promise.resolve({ status: 'entered', sceneId: 'x' })
      },
    })
    const modelLog: string[] = []
    const model = new OldJumpModel(modelLog, env)

    const HOPS = 110
    for (let i = 0; i < HOPS; i++) {
      r.state.arm('t', sutHandlers(i))
      void r.state.pendingEntry!.promise.then((v) => sutLog.push(`resolve${i}:${v.status}`))
      model.armJump(i)
      r.time.tick(1)
      model.fire()
      await flush()
      expect(r.state.jumpState).toBe(model.jumpState)
      expect(r.state.hasPendingEntry).toBe(model.pendingEntry !== null)
      expect(r.state.generation).toBe(model.transitionGeneration)
    }
    expect(sutLog).toEqual(modelLog)
    // 非空虚: 入場・上限の両方が起きている（件数は独立に数え直す）
    expect(sutLog.filter((l) => l.startsWith('enter'))).toHaveLength(100)
    expect(sutLog.filter((l) => l.startsWith('warn'))).toHaveLength(HOPS - 100)
    expect(sutLog.filter((l) => l.endsWith('failed'))).toHaveLength(HOPS - 100)
    expect(r.onStall).toHaveBeenCalledTimes(model.stalls)
    expect(model.stalls).toBeGreaterThan(0)
  })

  it.each([1, 2, 3, 4, 5, 6])(
    '固定シード %i のランダム操作列で、観測できる状態・ログが旧実装と一致する',
    async (seed) => {
      const rand = prng(seed)
      const env = { active: true }
      const sutLog: string[] = []
      const modelLog: string[] = []
      const r = rig()
      const model = new OldJumpModel(modelLog, env)
      let armId = 0
      let stub: ReturnType<typeof ENTRY_STUB> | null = null
      const counts: Record<string, number> = {}
      const bump = (k: string): void => {
        counts[k] = (counts[k] ?? 0) + 1
      }

      const STEPS = 600
      for (let step = 0; step < STEPS; step++) {
        const op = pickOp(rand, seed >= 4)
        bump(op)
        switch (op) {
          case 'arm': {
            const id = armId++
            r.state.arm('t', {
              isActive: () => env.active,
              warnChainLimit: () => sutLog.push(`warn${id}`),
              enter: () => {
                sutLog.push(`enter${id}`)
                return Promise.resolve({ status: 'entered', sceneId: 'x' })
              },
            })
            void r.state.pendingEntry!.promise.then((v) => sutLog.push(`resolve${id}:${v.status}`))
            model.armJump(id)
            break
          }
          case 'fire':
            r.time.tick(1)
            model.fire()
            break
          case 'clear':
            r.state.clear()
            model.clearJumpTimer()
            break
          case 'advance':
            r.state.advanceGeneration()
            model.advanceGeneration()
            break
          case 'begin':
            r.state.beginEntry()
            model.beginEntry()
            break
          case 'resetChain':
            r.state.resetChain()
            model.consecutiveJumps = 0
            break
          case 'resetRestore':
            r.state.resetJumpForRestore()
            model.resetJumpForRestore()
            break
          case 'stall':
            r.state.stall()
            model.stallJump()
            break
          case 'dispose':
            r.state.dispose()
            model.dispose()
            break
          case 'toggleActive':
            env.active = !env.active
            break
          case 'setPending':
            stub = ENTRY_STUB(step)
            r.state.setPendingEntry(stub)
            model.pendingEntry = stub
            break
          case 'clearPending':
            r.state.clearPendingEntry()
            model.pendingEntry = null
            break
        }
        await flush()
        const where = `seed ${seed} step ${step} op ${op}`
        expect(r.state.jumpState, where).toBe(model.jumpState)
        expect(r.state.hasPendingEntry, where).toBe(model.pendingEntry !== null)
        expect(r.state.generation, where).toBe(model.transitionGeneration)
        expect(r.onStall.mock.calls.length, where).toBe(model.stalls)
        expect(sutLog, where).toEqual(modelLog)
      }

      // 非空虚: 主要な分岐に実際に入っている
      expect(sutLog.filter((l) => l.startsWith('enter')).length).toBeGreaterThan(0)
      expect(sutLog.filter((l) => l.endsWith('superseded')).length).toBeGreaterThan(0)
      expect(counts.arm).toBeGreaterThan(0)
      expect(counts.fire).toBeGreaterThan(0)
    }
  )

  it('ランダム操作列の全シード合計で、上限(warn)と stall が実際に発生している', async () => {
    let warns = 0
    let stalls = 0
    for (const seed of [1, 2, 3, 4, 5, 6]) {
      const rand = prng(seed)
      const env = { active: true }
      const log: string[] = []
      const r = rig()
      let id = 0
      for (let step = 0; step < 600; step++) {
        const op = pickOp(rand, seed >= 4)
        if (op === 'arm') {
          const n = id++
          r.state.arm('t', {
            isActive: () => env.active,
            warnChainLimit: () => log.push(`warn${n}`),
            enter: () => Promise.resolve({ status: 'entered', sceneId: 'x' }),
          })
        } else if (op === 'fire') r.time.tick(1)
        else if (op === 'resetChain') r.state.resetChain()
        else if (op === 'toggleActive') env.active = !env.active
        await flush()
      }
      warns += log.length
      stalls += r.onStall.mock.calls.length
    }
    expect(warns).toBeGreaterThan(0)
    expect(stalls).toBeGreaterThan(0)
  })
})
