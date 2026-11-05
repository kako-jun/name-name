/** BattleScreen の `motion` (#956) の配線: ff の再生・サンプリングが選んだ時間の組 (default / snappy) で動く */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Assets, Texture, TextureSource, type Container } from 'pixi.js'
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
  // snappy の登場スライド (#1037) を済ませる（登場中は演出キューが再生されない）
  s.tick(1500)
  s.tick(200)
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
    // snappy の登場スライド (#1037) を済ませる（登場中は演出キューが再生されない）
    s.tick(1500)
    s.tick(200)
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
    // snappy の登場スライド (#1037) を済ませる（登場中は演出キューが再生されない）
    s.tick(1500)
    s.tick(200)
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
    // snappy の登場スライド (#1037) を済ませる（登場中は演出キューが再生されない）
    sc.tick(1500)
    sc.tick(200)
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
    // snappy の登場スライド (#1037) を済ませる（登場中は演出キューが再生されない）
    sc.tick(1500)
    sc.tick(200)
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
    // snappy の登場スライド (#1037) を済ませる（登場中は演出キューが再生されない）
    s.tick(1500)
    s.tick(200)
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
  function entranceSetup(
    motion: 'snappy' | 'default',
    presentation: 'ff' | 'dq' = 'ff',
    layout: 'side' | 'front' = 'side'
  ) {
    const engine = new BattleEngine([entity('hero')], [entity('boss', { atk: 0 })], {
      rng: () => 0.5,
      skills: {},
    })
    const s = new BattleScreen(engine, 800, 450, { layout, presentation, motion })
    created.push(s)
    return { s, engine }
  }
  const dxOf = (s: BattleScreen) => ({
    party: I(s).partyViews[0].container.x,
    enemy: I(s).enemyViews[0].container.x,
  })

  it.each(['snappy', 'default'] as const)(
    '%s: 開始前は画面外、登場後に元の位置へ。入力は登場中ずっと塞がる',
    async (motion) => {
      const { s } = entranceSetup(motion)
      const rest = entranceSetup(motion, 'dq') // 登場なしの基準位置（dq は登場しない）
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
    }
  )

  it.each(['snappy', 'default'] as const)('%s でも dq・front では登場しない', (motion) => {
    for (const [presentation, layout] of [
      ['dq', 'side'],
      ['ff', 'front'],
    ] as const) {
      const x = entranceSetup(motion, presentation, layout)
      expect(
        (
          x.s as unknown as { isInputBlockedByPresentation(): boolean }
        ).isInputBlockedByPresentation()
      ).toBe(false)
    }
  })
})

describe('BattleScreen: 登場スライドの詳細 (#1037)', () => {
  const sized = (w: number, h: number): Texture =>
    new Texture({ source: new TextureSource({ width: w, height: h }) })
  const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0))
  const total = S.entranceMs + S.entrancePartyDelayMs

  /** Assets.load を手で解決できるようにする（解決しない・失敗する読み込みも作れる） */
  let pending: { resolve: () => void; reject: () => void }[] = []
  type LoadMode = 'manual' | 'instant'
  function mockLoad(mode: LoadMode = 'manual') {
    pending = []
    vi.spyOn(Assets, 'load').mockImplementation(((): Promise<Texture> => {
      if (mode === 'instant') return Promise.resolve(sized(40, 80))
      return new Promise<Texture>((resolve, reject) => {
        pending.push({
          resolve: () => resolve(sized(40, 80)),
          reject: () => reject(new Error('x')),
        })
      })
    }) as never)
    vi.spyOn(BattleScreen.prototype as never, 'makeAcrylicPlate').mockImplementation(((
      tex: Texture
    ) => ({
      texture: sized(tex.width + 16, tex.height + 16),
      pad: 8,
      shadow: sized(64, 32),
      foot: { x: 32, y: 16 },
    })) as never)
  }
  afterEach(() => {
    vi.restoreAllMocks()
    document.body.innerHTML = ''
  })

  interface V {
    container: Container
    baseX: number
    baseY: number
    label: Container | null
    labelBaseX: number
    acrylicShadow: Container | null
    shadowBaseX: number
  }
  const views = (s: BattleScreen) =>
    s as unknown as { partyViews: V[]; enemyViews: V[]; entranceActive: boolean }
  const blocked = (s: BattleScreen) =>
    (s as unknown as { isInputBlockedByPresentation(): boolean }).isInputBlockedByPresentation()

  function build(
    over: Partial<BattleEntity> = {},
    opts: BattleScreenOptions = {},
    engineOpts: ConstructorParameters<typeof BattleEngine>[2] = { rng: () => 0.5, skills: {} }
  ) {
    const engine = new BattleEngine(
      [entity('hero', { sprite: 'img/h.webp', ...over })],
      [entity('boss', { atk: 0, sprite: 'img/b.webp' })],
      engineOpts
    )
    const s = new BattleScreen(engine, 800, 450, {
      layout: 'side',
      presentation: 'ff',
      motion: 'snappy',
      ...opts,
    })
    created.push(s)
    return { s, engine }
  }
  const press = (key: string) =>
    globalThis.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))

  it('読み込みが settled しない: 1499ms は開始待ちで出発位置のまま、1500ms で見切って開始、+登場時間で終了', async () => {
    mockLoad('manual')
    const { s } = build()
    const v = views(s)
    await flush()
    const startE = v.enemyViews[0].container.x
    const startP = v.partyViews[0].container.x
    expect(pending.length).toBeGreaterThan(0)
    s.tick(1499)
    expect(v.enemyViews[0].container.x).toBe(startE)
    expect(v.partyViews[0].container.x).toBe(startP)
    expect(blocked(s)).toBe(true)
    s.tick(1) // 見切り: 時計は 0 から
    expect(blocked(s)).toBe(true)
    s.tick(total / 2)
    expect(v.enemyViews[0].container.x).toBeGreaterThan(startE)
    expect(blocked(s)).toBe(true)
    s.tick(total)
    expect(blocked(s)).toBe(false)
    expect(v.entranceActive).toBe(false)
  })

  it('読み込みが全部済めば 1500ms を待たず、次の tick から開始する（失敗した読み込みも settled 扱い）', async () => {
    mockLoad('manual')
    const { s } = build()
    const v = views(s)
    await flush()
    const startE = v.enemyViews[0].container.x
    pending[0].resolve()
    pending.slice(1).forEach((p) => p.reject())
    await flush()
    await flush()
    s.tick(1) // 開始待ちの最後の tick（elapsed 0 で開始）
    s.tick(total / 2)
    expect(v.enemyViews[0].container.x).toBeGreaterThan(startE)
    s.tick(total)
    expect(blocked(s)).toBe(false)
  })

  it('一部だけ settled・残りは未解決なら、まだ開始しない', async () => {
    mockLoad('manual')
    const { s } = build()
    const v = views(s)
    await flush()
    pending[0].resolve()
    await flush()
    await flush()
    const startE = v.enemyViews[0].container.x // 絵の読み込みで再配置されるので、解決のあとで取る
    s.tick(500)
    expect(v.enemyViews[0].container.x).toBe(startE)
    expect(blocked(s)).toBe(true)
  })

  it('destroy のあとで読み込み Promise が解決・失敗しても例外が出ない', async () => {
    mockLoad('manual')
    const { s } = build()
    await flush()
    s.destroy({ children: true })
    expect(() => {
      pending.forEach((p, i) => (i % 2 ? p.reject() : p.resolve()))
    }).not.toThrow()
    await flush()
    await flush()
    expect(() => s.tick(16)).not.toThrow()
  })

  it('全員同時に着く（遅れ 0）: 終了の 1ms 前は敵も味方も途中、終了の tick で同時に元の位置', async () => {
    mockLoad('instant')
    // 登場なしの基準位置は dq（default も ff+side では登場する #1110）
    const rest = build({}, { presentation: 'dq' })
    await flush()
    const restE = views(rest.s).enemyViews[0].container.x
    const restP = views(rest.s).partyViews[0].container.x
    const { s } = build()
    const v = views(s)
    await flush()
    s.tick(1)
    s.tick(total - 1)
    expect(v.enemyViews[0].container.x).not.toBe(restE)
    expect(v.partyViews[0].container.x).not.toBe(restP)
    s.tick(1)
    expect(v.enemyViews[0].container.x).toBe(restE)
    expect(v.partyViews[0].container.x).toBe(restP)
  })

  it('水平のみ: 登場中の全 tick で y・回転・フィルタ（モザイク）は動かない（アクスタ表示）', async () => {
    mockLoad('instant')
    const { s } = build({}, { spriteStyle: 'acrylic' })
    const v = views(s)
    await flush()
    await flush()
    for (let t = 0; t <= total + 20; t += 10) {
      for (const view of [...v.enemyViews, ...v.partyViews]) {
        expect(view.container.y).toBe(view.baseY)
        expect(view.container.rotation).toBe(0)
        expect(view.container.filters ?? []).toHaveLength(0)
        expect(view.container.alpha).toBe(1)
      }
      s.tick(10)
    }
    expect(blocked(s)).toBe(false)
  })

  it('名前ラベルと影は本体と同じ dx で動き、終了後は基準位置に戻る', async () => {
    mockLoad('instant')
    const { s } = build({}, { spriteStyle: 'acrylic' })
    const v = views(s)
    await flush()
    await flush()
    s.tick(1)
    s.tick(total / 2)
    const e = v.enemyViews[0]
    const dx = e.container.x - e.baseX
    expect(Math.abs(dx)).toBeGreaterThan(1)
    expect(e.label).not.toBeNull()
    expect(e.label!.x - e.labelBaseX).toBeCloseTo(dx, 6)
    expect(e.acrylicShadow).not.toBeNull()
    expect(e.acrylicShadow!.x - e.shadowBaseX).toBeCloseTo(dx, 6)
    const p = v.partyViews[0]
    const pdx = p.container.x - p.baseX
    expect(Math.abs(pdx)).toBeGreaterThan(1)
    expect(p.acrylicShadow).not.toBeNull()
    expect(p.acrylicShadow!.x - p.shadowBaseX).toBeCloseTo(pdx, 6)
    s.tick(total)
    expect(e.label!.x).toBeCloseTo(e.labelBaseX, 6)
    expect(e.acrylicShadow!.x).toBeCloseTo(e.shadowBaseX, 6)
    expect(p.acrylicShadow!.x).toBeCloseTo(p.shadowBaseX, 6)
  })

  it('登場中は演出キューの再生（advancePresentation）を進めず、登場後に始まる。位置は毎フレーム更新される', async () => {
    mockLoad('instant')
    const spy = vi.spyOn(BattleScreen.prototype as never, 'advancePresentation')
    const { s } = build()
    const v = views(s)
    await flush()
    await flush()
    s.tick(1)
    const e = v.enemyViews[0]
    const x1 = e.container.x
    s.tick(total / 4)
    expect(e.container.x).not.toBe(x1)
    s.tick(total / 4)
    expect(spy).not.toHaveBeenCalled()
    s.tick(total) // 終了フレーム
    expect(v.entranceActive).toBe(false)
    s.tick(10)
    expect(spy).toHaveBeenCalled()
  })

  it('編隊保持: 敵 2 体・味方 2 体で、全 tick で隣り合う x の差が最終位置と一致し、同時到着・始点は全員画面外', async () => {
    mockLoad('instant')
    const engine = new BattleEngine(
      [entity('h1', { sprite: 'img/h.webp' }), entity('h2', { sprite: 'img/h.webp' })],
      [
        entity('b1', { atk: 0, sprite: 'img/b.webp' }),
        entity('b2', { atk: 0, sprite: 'img/b.webp' }),
      ],
      { rng: () => 0.5, skills: {} }
    )
    const s = new BattleScreen(engine, 800, 450, {
      layout: 'side',
      presentation: 'ff',
      motion: 'snappy',
    })
    created.push(s)
    const v = views(s)
    await flush()
    await flush()
    // 開始前（出発位置）: 全員が画面の外
    const [e1, e2] = v.enemyViews
    const [p1, p2] = v.partyViews
    const w = (view: V) => view.container.width
    expect(e1.container.x + w(e1)).toBeLessThanOrEqual(0.5)
    expect(e2.container.x + w(e2)).toBeLessThanOrEqual(0.5)
    expect(p1.container.x).toBeGreaterThanOrEqual(799.5)
    expect(p2.container.x).toBeGreaterThanOrEqual(799.5)
    for (let t = 0; t <= total + 20; t += 10) {
      const finalDiffE = e2.baseX - e1.baseX
      const finalDiffP = p2.baseX - p1.baseX
      if (v.entranceActive) {
        expect(e2.container.x - e1.container.x).toBeCloseTo(finalDiffE, 6)
        expect(p2.container.x - p1.container.x).toBeCloseTo(finalDiffP, 6)
      }
      s.tick(10)
    }
    expect(v.entranceActive).toBe(false)
    for (const view of [e1, e2, p1, p2]) expect(view.container.x).toBeCloseTo(view.baseX, 6)
  })

  describe('ATB と入力', () => {
    const ATB = {
      atb: { mode: 'wait' as const, initialGauges: { party: [1000], enemies: [1000] } },
      rng: () => 0.5,
    }
    const MENU = {
      spells: {
        hero: [{ id: 'fire', name: 'ほのお', mp: 3, target: '敵単体', effect: 'damage 8..14' }],
      },
      items: [],
    }

    it('登場中は engine.tick が止まる（ゲージが進まず・敵も行動しない）。登場後は動き出す', async () => {
      mockLoad('instant')
      const { s, engine } = build(
        {},
        {},
        { ...ATB, atb: { mode: 'wait', initialGauges: { party: [0], enemies: [1000] } } }
      )
      await flush()
      const snap = () => JSON.stringify([engine.getState().atb, engine.getState().eventTotal])
      const before = snap()
      s.tick(1)
      s.tick(total / 2)
      s.tick(total / 4)
      expect(snap()).toBe(before)
      s.tick(total) // 登場終了
      expect(blocked(s)).toBe(false)
      s.tick(500)
      expect(snap()).not.toBe(before)
    })

    it('開始待ち（読み込み未了）の間も ATB は止まったまま', async () => {
      mockLoad('manual')
      const { s, engine } = build({}, {}, ATB)
      await flush()
      const before = JSON.stringify(engine.getState().atb)
      s.tick(1400)
      expect(JSON.stringify(engine.getState().atb)).toBe(before)
    })

    it('登場中は handleCommand / isCommandEnabled / 十字キー / confirmMenu が塞がり、登場後に解禁される', async () => {
      mockLoad('instant')
      const { s, engine } = build(
        {},
        { commandLayout: 'cross', menu: structuredClone(MENU) as never },
        ATB
      )
      await flush()
      const I2 = s as unknown as {
        isCommandEnabled(id: string): boolean
        handleCommand(id: string): void
        confirmMenu(): void
        menuContext(): unknown
        menuStack: unknown[]
      }
      const ctxSpy = vi.spyOn(I2 as never, 'menuContext')
      s.tick(1)
      s.tick(total / 2)
      expect(blocked(s)).toBe(true)
      expect(I2.isCommandEnabled('attack')).toBe(false)
      expect(I2.isCommandEnabled('escape')).toBe(false)
      const logBefore = engine.getState().logTotal
      I2.handleCommand('attack')
      I2.handleCommand('escape')
      press('ArrowLeft') // じゅもん窓
      press('ArrowRight')
      press('ArrowUp')
      press('ArrowDown')
      I2.confirmMenu()
      expect(I2.menuStack).toHaveLength(0)
      expect(engine.getState().logTotal).toBe(logBefore)
      expect(ctxSpy).not.toHaveBeenCalled()
      s.tick(total)
      expect(I2.isCommandEnabled('attack')).toBe(true)
      expect(I2.isCommandEnabled('escape')).toBe(true)
      press('ArrowLeft')
      expect(I2.menuStack).toHaveLength(1)
      I2.confirmMenu()
      expect(ctxSpy).toHaveBeenCalled()
    })
  })

  describe('登場しない構成', () => {
    it('dq・front（default でも）: 位置は従来どおり（基準位置と一致）、入力は塞がらず ATB も動く', async () => {
      mockLoad('instant')
      const ATB = {
        atb: { mode: 'wait' as const, initialGauges: { party: [0], enemies: [0] } },
        rng: () => 0.5,
      }
      const cases: BattleScreenOptions[] = [
        { motion: 'default', presentation: 'dq' },
        { presentation: 'dq' },
        { layout: 'front' },
      ]
      for (const opts of cases) {
        const { s, engine } = build({}, opts, ATB)
        const v = views(s)
        await flush()
        expect(v.entranceActive).toBe(false)
        expect(blocked(s)).toBe(false)
        for (const view of [...v.enemyViews, ...v.partyViews]) {
          expect(view.container.x).toBe(view.baseX)
        }
        const g0 = JSON.stringify(engine.getState().atb)
        s.tick(200)
        expect(JSON.stringify(engine.getState().atb)).not.toBe(g0)
        for (const view of [...v.enemyViews, ...v.partyViews]) {
          expect(view.container.x).toBe(view.baseX)
        }
      }
    })
  })
})
