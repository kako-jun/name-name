/** BattleScreen の `motion` (#956) の配線: ff の再生・サンプリングが選んだ時間の組 (default / snappy) で動く */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Container } from 'pixi.js'
import { BattleScreen, type BattleScreenOptions } from './BattleScreen'
import { BattleEngine } from './battleEngine'
import type { BattleEntity } from './spellDsl'
import { DEFAULT_MOTION_TIMING, SNAPPY_MOTION_TIMING } from './battleMotion'
import type { BattleActionEvent, BattleHit } from './battleEngine'

function entity(id: string, over: Partial<BattleEntity> = {}): BattleEntity {
  return {
    id,
    name: id.toUpperCase(),
    hp: 999,
    maxHp: 999,
    mp: 9,
    maxMp: 9,
    atk: 8,
    def: 1,
    agi: 2,
    exp: 1,
    gold: 1,
    ...over,
  }
}

interface Internals {
  partyViews: { container: Container }[]
  enemyViews: { container: Container }[]
  playback: { active: { event: { seq: number }; elapsed: number } | null }
}
const I = (s: BattleScreen): Internals => s as unknown as Internals

const created: BattleScreen[] = []
function setup(opts: BattleScreenOptions = {}) {
  const engine = new BattleEngine([entity('hero')], [entity('boss', { atk: 0 })], {
    rng: () => 0.5,
    skills: {},
  })
  const s = new BattleScreen(engine, 800, 450, { layout: 'side', presentation: 'ff', ...opts })
  created.push(s)
  engine.selectAttack()
  ;(s as unknown as { refresh(): void }).refresh()
  return { s, engine, restX: I(s).partyViews[0].container.x }
}
afterEach(() => {
  for (const s of created.splice(0)) s.destroy({ children: true })
})

const S = SNAPPY_MOTION_TIMING
const D = DEFAULT_MOTION_TIMING
const SNAPPY_END = S.attackStepMs + S.attackSlashMs + S.attackReturnMs

/** 1ms 刻みで ms まで進め、味方の前進量（絶対値）を返す */
function advanceTo(h: ReturnType<typeof setup>, ms: number): number {
  for (let t = 0; t < ms; t++) h.s.tick(1)
  return Math.abs(I(h.s).partyViews[0].container.x - h.restX)
}

describe('BattleScreen: motion の配線 (#956)', () => {
  it('snappy: 味方の攻撃のずれは snappy の踏み出し端で最大になり、戻り端で 0 に戻る', () => {
    const h = setup({ motion: 'snappy' })
    const peak = advanceTo(h, S.attackStepMs)
    expect(peak).toBeGreaterThan(0)
    const end = advanceTo(h, SNAPPY_END - S.attackStepMs)
    expect(end).toBeCloseTo(0, 6)
  })

  it('default（未指定も同じ）: 同じ時刻ではまだ戻りきっていない', () => {
    for (const opts of [{ motion: 'default' as const }, {}]) {
      const h = setup(opts)
      expect(advanceTo(h, SNAPPY_END)).toBeGreaterThan(1)
    }
  })

  it('snappy の踏み出しは default より距離が短い（同じ踏み出し端でなく各端の最大で比べる）', () => {
    const sn = advanceTo(setup({ motion: 'snappy' }), S.attackStepMs)
    const df = advanceTo(setup({ motion: 'default' }), D.attackStepMs)
    expect(sn).toBeLessThan(df)
  })

  it('再生の進行も snappy の長さ: 行動の終わり（+行動間）で次の行動へ移る。default はまだ同じ行動', () => {
    const firstSeq = (h: ReturnType<typeof setup>) => h.engine.getState().events[0].seq
    const sn = setup({ motion: 'snappy' })
    const seq = firstSeq(sn)
    sn.s.tick(1)
    expect(I(sn.s).playback.active?.event.seq).toBe(seq)
    const dur = SNAPPY_END + S.actionGapMs
    advanceTo(sn, dur + 20)
    const a = I(sn.s).playback.active
    expect(a === null || a.event.seq !== seq).toBe(true)

    const df = setup({ motion: 'default' })
    advanceTo(df, dur + 20)
    expect(I(df.s).playback.active?.event.seq).toBe(firstSeq(df))
  })
})

describe('BattleScreen: 味方の被弾にモザイクは掛けない・敵の自己モザイクは出る (#953)', () => {
  type Mv = { container: Container & { filters: unknown } }
  // 味方（被弾側）にはモザイクが掛からない。フィルタを持つのは攻撃した敵自身だけ
  const partyFilt = (h: ReturnType<typeof setup>, i = 0) =>
    (I(h.s).partyViews[i] as unknown as Mv).container.filters
  const filt = (h: ReturnType<typeof setup>, i = 0) => {
    const f = (I(h.s).enemyViews[i] as unknown as Mv).container.filters as unknown as
      | { sizeX: number; destroy: () => void }[]
      | null
    return f && f.length ? f[0] : null
  }
  function runUntilFilter(h: ReturnType<typeof setup>, limit = 4000): number[] {
    const sizes: number[] = []
    for (let t = 0; t < limit; t++) {
      h.s.tick(1)
      expect(partyFilt(h)).toBeFalsy()
      const f = filt(h)
      if (f) sizes.push(f.sizeX)
    }
    return sizes
  }
  function enemyAttackSetup(motion: 'snappy' | 'default') {
    const engine = new BattleEngine(
      [entity('hero', { agi: 1 })],
      [entity('boss', { atk: 5, agi: 99 })],
      {
        rng: () => 0.5,
        skills: {},
      }
    )
    const s = new BattleScreen(engine, 800, 450, { layout: 'side', presentation: 'ff', motion })
    created.push(s)
    engine.selectAttack()
    ;(s as unknown as { refresh(): void }).refresh()
    return { s, engine, restX: I(s).partyViews[0].container.x }
  }

  it('snappy: 敵の攻撃で、味方には付かず攻撃した敵自身に size が 1→最大→1 と動いて終わると外れる', () => {
    const h = enemyAttackSetup('snappy')
    const sizes = runUntilFilter(h)
    expect(sizes.length).toBeGreaterThan(50)
    const max = Math.max(...sizes)
    expect(max).toBe(S.selfMosaicMaxSize)
    expect(sizes[0]).toBeLessThan(max)
    expect(filt(h)).toBeNull()
  })

  it('default: 付かない', () => {
    const h = enemyAttackSetup('default')
    expect(runUntilFilter(h)).toEqual([])
  })

  it('味方の攻撃だけの間は敵側にも味方側にも付かない（敵の攻撃前）', () => {
    const h = setup({ motion: 'snappy' })
    for (let t = 0; t < SNAPPY_END; t++) {
      h.s.tick(1)
      expect(filt(h)).toBeNull()
    }
  })

  it('破棄: 付いている最中に destroy してもフィルタが destroy される', () => {
    const h = enemyAttackSetup('snappy')
    let f: { destroy: () => void } | null = null
    for (let t = 0; t < 4000 && !f; t++) {
      h.s.tick(1)
      f = filt(h)
    }
    expect(f).not.toBeNull()
    const spy = vi.spyOn(f!, 'destroy')
    h.s.destroy({ children: true })
    expect(spy).toHaveBeenCalledTimes(1)
  })

  // ---- 合成イベントで再生して、味方・敵 両側の filters を 1ms ごとに記録する ----
  interface Rec {
    party: (number | null)[]
    enemy: (number | null)[]
  }
  const sizeOf = (c: Container) => {
    const f = c.filters as unknown as { sizeX: number }[] | null
    return f && f.length ? f[0].sizeX : null
  }
  function playSynthetic(events: BattleActionEvent[], ms = 1500): Rec {
    const engine = new BattleEngine([entity('hero')], [entity('boss', { atk: 0 })], {
      rng: () => 0.5,
      skills: {},
    })
    const s = new BattleScreen(engine, 800, 450, {
      layout: 'side',
      presentation: 'ff',
      motion: 'snappy',
    })
    created.push(s)
    ;(s as unknown as { playback: unknown }).playback = { queue: events, active: null }
    const v = s as unknown as {
      partyViews: { container: Container }[]
      enemyViews: { container: Container }[]
    }
    const rec: Rec = { party: [], enemy: [] }
    for (let t = 0; t < ms; t++) {
      s.tick(1)
      rec.party.push(sizeOf(v.partyViews[0].container))
      rec.enemy.push(sizeOf(v.enemyViews[0].container))
    }
    return rec
  }
  const hit = (over: Partial<BattleHit> = {}): BattleHit => ({
    target: { side: 'party', index: 0 },
    kind: 'damage',
    amount: 10,
    hpBefore: 999,
    hpAfter: 989,
    ...over,
  })
  const ev = (actorSide: 'party' | 'enemy', hits: BattleHit[]): BattleActionEvent => ({
    seq: 0,
    actor: { side: actorSide, index: 0 },
    kind: 'attack',
    hits,
  })
  const attached = (a: (number | null)[]) => a.filter((x): x is number => x !== null)

  it('敵の damage 命中（単発・倒れる・4 連撃）でも、被弾した味方にモザイクは一度も付かない', () => {
    for (const hits of [
      [hit()],
      [hit({ hpAfter: 0 })],
      [0, 1, 2, 3].map((round) => hit({ round })),
    ]) {
      const r = playSynthetic([ev('enemy', hits)])
      expect(attached(r.party)).toEqual([])
      // 攻撃した敵自身の自己モザイクは従来どおり（最大まで上がり、終わりに外れる）
      const e = attached(r.enemy)
      expect(Math.max(...e)).toBe(S.selfMosaicMaxSize)
      expect(r.enemy[r.enemy.length - 1]).toBeNull()
    }
  })

  it('miss・回復でも味方には付かない', () => {
    for (const h of [
      hit({ kind: 'miss', amount: 0, hpAfter: 999 }),
      hit({ kind: 'heal', hpBefore: 500, hpAfter: 510 }),
    ]) {
      const r = playSynthetic([ev('enemy', [h])])
      expect(attached(r.party)).toEqual([])
    }
  })

  it('味方の行動では、味方にも敵にも付かない（味方→味方・味方→敵）', () => {
    const r1 = playSynthetic([ev('party', [hit()])])
    expect(attached(r1.party)).toEqual([])
    expect(attached(r1.enemy)).toEqual([])
    const r2 = playSynthetic([ev('party', [hit({ target: { side: 'enemy', index: 0 } })])])
    expect(attached(r2.party)).toEqual([])
    expect(attached(r2.enemy)).toEqual([])
  })

  it('敵0→敵1 のダメージでは、被弾側の敵1にも味方にも付かない（付くのは攻撃した敵0の通知モザイクだけ）', () => {
    const engine = new BattleEngine(
      [entity('hero')],
      [entity('a', { atk: 0 }), entity('b', { atk: 0 })],
      {
        rng: () => 0.5,
        skills: {},
      }
    )
    const sc = new BattleScreen(engine, 800, 450, {
      layout: 'side',
      presentation: 'ff',
      motion: 'snappy',
    })
    created.push(sc)
    ;(sc as unknown as { playback: unknown }).playback = {
      queue: [ev('enemy', [hit({ target: { side: 'enemy', index: 1 } })])],
      active: null,
    }
    const v = sc as unknown as {
      enemyViews: { container: Container }[]
      partyViews: { container: Container }[]
    }
    let e0 = 0
    for (let t = 0; t < 1500; t++) {
      sc.tick(1)
      if (sizeOf(v.enemyViews[0].container) !== null) e0++
      expect(sizeOf(v.enemyViews[1].container)).toBeNull()
      expect(sizeOf(v.partyViews[0].container)).toBeNull()
    }
    expect(e0).toBeGreaterThan(50)
  })

  it('敵0→味方の攻撃で、攻撃していない敵1にはモザイクが付かない', () => {
    const engine = new BattleEngine(
      [entity('hero')],
      [entity('a', { atk: 0 }), entity('b', { atk: 0 })],
      {
        rng: () => 0.5,
        skills: {},
      }
    )
    const sc = new BattleScreen(engine, 800, 450, {
      layout: 'side',
      presentation: 'ff',
      motion: 'snappy',
    })
    created.push(sc)
    ;(sc as unknown as { playback: unknown }).playback = {
      queue: [ev('enemy', [hit()])],
      active: null,
    }
    const v = sc as unknown as { enemyViews: { container: Container }[] }
    let e0 = 0
    for (let t = 0; t < 1500; t++) {
      sc.tick(1)
      if (sizeOf(v.enemyViews[0].container) !== null) e0++
      expect(sizeOf(v.enemyViews[1].container)).toBeNull()
    }
    expect(e0).toBeGreaterThan(50)
  })
})

describe('BattleScreen: 敵の攻撃は踏み出さず自己モザイク (sit-by-me #63 #64)', () => {
  const sizeOf = (c: Container) => {
    const f = c.filters as unknown as { sizeX: number }[] | null
    return f && f.length ? f[0].sizeX : null
  }
  function playEnemyAttack(
    motion: 'snappy' | 'default',
    kind: 'attack' | 'spell' = 'attack',
    bossHp = 999
  ) {
    const engine = new BattleEngine([entity('hero')], [entity('boss', { atk: 0, hp: bossHp })], {
      rng: () => 0.5,
      skills: {},
    })
    const s = new BattleScreen(engine, 800, 450, { layout: 'side', presentation: 'ff', motion })
    created.push(s)
    // snappy の登場スライド (#1037) を済ませる（読み込み待ちの見切り 1500ms + 登場 200ms）。登場中は入力が塞がるため
    s.tick(1500)
    s.tick(200)
    const v = s as unknown as {
      enemyViews: { container: Container; baseX: number }[]
      sampleEntity(side: 'enemy', i: number): { pose: string }
    }
    const event: BattleActionEvent = {
      seq: 0,
      actor: { side: 'enemy', index: 0 },
      kind,
      hits: [
        {
          target: { side: 'party', index: 0 },
          kind: 'damage',
          amount: 10,
          hpBefore: 999,
          hpAfter: 989,
        },
      ],
    }
    ;(s as unknown as { playback: unknown }).playback = { queue: [event], active: null }
    const ex: number[] = []
    const esize: (number | null)[] = []
    const poses = new Set<string>()
    for (let t = 0; t < 1500; t++) {
      s.tick(1)
      ex.push(v.enemyViews[0].container.x - v.enemyViews[0].baseX)
      esize.push(sizeOf(v.enemyViews[0].container))
      poses.add(v.sampleEntity('enemy', 0).pose)
    }
    return { ex, esize, poses }
  }

  it('snappy: 敵は一度も横にずれず攻撃ポーズにも替わらず、自己モザイクが最大まで上がって外れる', () => {
    const r = playEnemyAttack('snappy')
    expect(r.ex.every((x) => x === 0)).toBe(true)
    expect([...r.poses]).toEqual(['idle'])
    const a = r.esize.filter((x): x is number => x !== null)
    expect(a.length).toBeGreaterThan(50)
    expect(Math.max(...a)).toBe(S.selfMosaicMaxSize)
    expect(Math.min(...a)).toBeGreaterThanOrEqual(2)
    expect(r.esize[r.esize.length - 1]).toBeNull()
  })

  it('default（モザイク無効）: 従来どおり敵が踏み出し、攻撃ポーズも再生し、モザイクは付かない', () => {
    const r = playEnemyAttack('default')
    expect(Math.max(...r.ex.map(Math.abs))).toBeGreaterThan(1)
    expect(r.poses.has('step')).toBe(true)
    expect(r.poses.has('slash')).toBe(true)
    expect(r.esize.every((x) => x === null)).toBe(true)
  })

  it('攻撃以外（spell）の敵は自己モザイクにならない', () => {
    const r = playEnemyAttack('snappy', 'spell')
    expect(r.esize.every((x) => x === null)).toBe(true)
  })

  it('倒れた敵の行動（死亡時の行動）では自己モザイクを出さない', () => {
    const r = playEnemyAttack('snappy', 'attack', 0)
    expect(r.esize.every((x) => x === null)).toBe(true)
  })

  it('味方の踏み出しの間（命中まで）、味方は従来どおり踏み出し、敵にモザイクは付かない', () => {
    const engine = new BattleEngine([entity('hero')], [entity('boss', { atk: 0 })], {
      rng: () => 0.5,
      skills: {},
    })
    const s = new BattleScreen(engine, 800, 450, {
      layout: 'side',
      presentation: 'ff',
      motion: 'snappy',
    })
    created.push(s)
    engine.selectAttack()
    ;(s as unknown as { refresh(): void }).refresh()
    const v = s as unknown as {
      partyViews: { container: Container }[]
      enemyViews: { container: Container }[]
    }
    const x0 = v.partyViews[0].container.x
    let maxStep = 0
    for (let t = 0; t < S.attackStepMs; t++) {
      s.tick(1)
      maxStep = Math.max(maxStep, Math.abs(v.partyViews[0].container.x - x0))
      expect(sizeOf(v.enemyViews[0].container)).toBeNull()
    }
    expect(maxStep).toBeGreaterThan(0)
  })
})

describe('BattleScreen: 登場スライド (#1037)', () => {
  function entranceSetup(motion: 'snappy' | 'default', presentation: 'ff' | 'dq' = 'ff') {
    const engine = new BattleEngine([entity('hero')], [entity('boss', { atk: 0 })], {
      rng: () => 0.5,
      skills: {},
    })
    const s = new BattleScreen(engine, 800, 450, { layout: 'side', presentation, motion })
    created.push(s)
    return { s, engine }
  }
  const dxOf = (s: BattleScreen) => ({
    party: I(s).partyViews[0].container.x,
    enemy: I(s).enemyViews[0].container.x,
  })

  it('snappy: 開始前は画面外、登場後に元の位置へ。入力は登場中ずっと塞がる', async () => {
    const { s } = entranceSetup('snappy')
    const rest = entranceSetup('default')
    const restPos = dxOf(rest.s)
    expect(dxOf(s).enemy).toBeLessThan(0)
    expect(dxOf(s).party).toBeGreaterThanOrEqual(800)
    expect(
      (s as unknown as { isInputBlockedByPresentation(): boolean }).isInputBlockedByPresentation()
    ).toBe(true)
    await Promise.resolve()
    await Promise.resolve()
    s.tick(1) // 読み込み済みなので開始
    s.tick(S.entranceMs / 2)
    expect(dxOf(s).enemy).toBeLessThan(restPos.enemy)
    s.tick(S.entranceMs)
    expect(dxOf(s)).toEqual(restPos)
    expect(
      (s as unknown as { isInputBlockedByPresentation(): boolean }).isInputBlockedByPresentation()
    ).toBe(false)
  })

  it('default と dq では登場しない', () => {
    const d = entranceSetup('default')
    expect(
      (d.s as unknown as { isInputBlockedByPresentation(): boolean }).isInputBlockedByPresentation()
    ).toBe(false)
    const q = entranceSetup('snappy', 'dq')
    expect(
      (q.s as unknown as { isInputBlockedByPresentation(): boolean }).isInputBlockedByPresentation()
    ).toBe(false)
  })
})
