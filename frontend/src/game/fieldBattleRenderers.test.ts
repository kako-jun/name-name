/**
 * TopDownRenderer / RaycastRenderer が fieldBattle.ts を同じ配線で使うことの確認 (#784)。
 * openFieldBattle への引数、戦闘中の load() / destroy()、設定オーバーレイ中の ATB 停止を両レンダラーで検証する。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Container } from 'pixi.js'

vi.mock('./fieldBattle', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./fieldBattle')>()
  return { ...actual, openFieldBattle: vi.fn(actual.openFieldBattle) }
})

import { FieldInputGate, openFieldBattle, readFieldBattleSettings } from './fieldBattle'
import { RaycastRenderer } from './RaycastRenderer'
import { TopDownRenderer } from './TopDownRenderer'
import type { BattleEntity } from './spellDsl'
import type { FieldBattleTransition } from './fieldBattleTransition'
import type { PartyMemberDef } from '../types'
import type { RPGProject } from '../types/rpg'

const enemy = (): BattleEntity => ({
  id: 'slime',
  name: 'スライム',
  hp: 5,
  maxHp: 5,
  mp: 0,
  maxMp: 0,
  atk: 1,
  def: 0,
  agi: 1,
})

const member = (id: string): PartyMemberDef => ({
  id,
  name: id,
  hp: 20,
  mp: 5,
  atk: 4,
  def: 2,
  agi: 3,
})

function project(view: 'topdown' | 'raycast', over: Partial<RPGProject> = {}): RPGProject {
  return {
    name: 't',
    version: '1.0.0',
    map: {
      width: 9,
      height: 9,
      tileSize: 32,
      tiles: Array.from({ length: 9 }, () => Array(9).fill(0)),
    },
    player: { x: 4, y: 4, direction: 'down' },
    npcs: [],
    view,
    battleLayout: 'side',
    windowStyle: 'ff-blue',
    battleAtb: { mode: 'active' },
    party: { hero: member('hero'), mage: member('mage') },
    partyOrder: ['hero', 'mage'],
    ...over,
  }
}

interface Field {
  app: { stage: Container }
  initialized: boolean
  encounterCooldown: number
  lastTickMs: number
  inputGate: FieldInputGate
  battleScreen: {
    opts: Record<string, unknown>
    destroyed: boolean
    tick(ms: number): void
  } | null
  startBattle(enemies: BattleEntity[]): unknown
  transition: FieldBattleTransition
  deferredStepTrigger: { x: number; y: number } | null
  keys?: Set<string>
  handleKeyDown(e: KeyboardEvent): void
  handleTap(): void
  handleSwipe(d: 'up' | 'down' | 'left' | 'right'): void
  menuOverlay: { showMenu(): void } | null
  setBattleTransitionHooks(h: { onTransitionBeat?: (n: number) => void }): void
  setInputSuspended(v: boolean): void
  onTick(): void
  destroy(): void
  load(p: RPGProject): void
}

function topDown(over: Partial<RPGProject> = {}): Field {
  const r = new TopDownRenderer()
  const f = r as unknown as Field & { screenWidth: number; screenHeight: number }
  f.app = { stage: new Container() }
  f.screenWidth = 800
  f.screenHeight = 600
  r.load(project('topdown', over))
  f.initialized = true
  return f
}

function raycast(over: Partial<RPGProject> = {}): Field {
  const r = new RaycastRenderer()
  const f = r as unknown as Field & { ensureWallTextures(): Promise<void> }
  f.app = { stage: new Container() }
  f.ensureWallTextures = async () => {}
  r.load(project('raycast', over))
  const g = f as unknown as Record<string, unknown>
  g.advanceTurnAnim = () => {}
  g.updateMovement = () => {}
  g.updateNpcAnimations = () => {}
  g.renderFrame = () => {}
  return f
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe.each([
  ['TopDownRenderer', topDown, 'topdown' as const],
  ['RaycastRenderer', raycast, 'raycast' as const],
])('%s の戦闘配線 (#784)', (_name, make, view) => {
  it('openFieldBattle に load() 済みの settings・roster と、毎回同じ gate を渡す', () => {
    const f = make()
    const mock = vi.mocked(openFieldBattle)
    mock.mockClear()
    f.startBattle([enemy()])
    const first = mock.mock.calls[0][0]
    expect(first.settings).toEqual(readFieldBattleSettings(project(view)))
    expect(Object.keys(first.roster.party)).toEqual(['hero', 'mage'])
    expect(first.roster.order).toEqual(['hero', 'mage'])
    expect(first.gate).toBeInstanceOf(FieldInputGate)
    expect(first.stage).toBe(f.app.stage)
    ;(f.battleScreen!.opts.onClose as (o: string) => void)('escaped')
    f.startBattle([enemy()])
    expect(mock.mock.calls[1][0].gate).toBe(first.gate)
  })

  it('battle_presentation が BattleScreen の opts に届く（未指定は dq） (#745)', () => {
    const ff = make({ battlePresentation: 'ff' })
    ff.startBattle([enemy()])
    expect(ff.battleScreen!.opts.presentation).toBe('ff')
    const dq = make()
    dq.startBattle([enemy()])
    expect(dq.battleScreen!.opts.presentation).toBe('dq')
  })

  describe('battle_effects の読み込みと配線 (#941)', () => {
    const json = (name: string) =>
      JSON.stringify({ impact: { image: `${name}.png`, frames: 2, frameMs: 100 } })
    const resp = (body: string) => Promise.resolve(new Response(body, { status: 200 }))
    const flush = async () => {
      for (let i = 0; i < 5; i++) await Promise.resolve()
      await new Promise((r) => setTimeout(r, 0))
    }
    const imageOf = (f: Field): string | undefined =>
      (f.battleScreen!.opts.effects as { impact?: { image: string } } | undefined)?.impact?.image
    afterEach(() => vi.unstubAllGlobals())

    it('宣言があれば読み込み後の戦闘の opts.effects に届き、宣言なしは載らない', async () => {
      vi.stubGlobal('fetch', () => resp(json('a')))
      const f = make({ battleEffects: 'e.json' })
      await flush()
      f.startBattle([enemy()])
      expect(imageOf(f)).toBe('a.png')
      const none = make()
      none.startBattle([enemy()])
      expect('effects' in none.battleScreen!.opts).toBe(false)
    })

    it('読み込みが終わる前に load() し直すと、古い結果は捨てて新しい方を使う', async () => {
      let release: (r: Response) => void = () => {}
      const slow = new Promise<Response>((r) => (release = r))
      const calls = [slow, resp(json('b'))]
      vi.stubGlobal('fetch', () => calls.shift())
      const f = make({ battleEffects: 'old.json' })
      f.load(project(view, { battleEffects: 'new.json' }))
      await flush()
      release(new Response(json('a'), { status: 200 }))
      await flush()
      f.startBattle([enemy()])
      expect(imageOf(f)).toBe('b.png')
    })

    it('destroy() 後に届いた結果は反映しない', async () => {
      let release: (r: Response) => void = () => {}
      vi.stubGlobal('fetch', () => new Promise<Response>((r) => (release = r)))
      const f = make({ battleEffects: 'e.json' })
      f.initialized = false // PixiJS Application の実体は無いので app.destroy 側は通さない
      f.destroy()
      release(new Response(json('a'), { status: 200 }))
      await flush()
      expect((f as unknown as { battleEffects: unknown }).battleEffects).toBeUndefined()
    })
  })

  it('戦闘中に load() し直すと戦闘画面が畳まれ、古い onClose が新しいマップのクールダウンを上書きしない', () => {
    const f = make()
    f.startBattle([enemy()])
    const screen = f.battleScreen!
    f.load(project(view))
    expect(f.battleScreen).toBeNull()
    expect(screen.destroyed).toBe(true)
    expect(f.app.stage.children).not.toContain(screen)
    ;(screen.opts.onClose as (o: string) => void)('victory')
    expect(f.encounterCooldown).toBe(0)
  })

  it('戦闘中の destroy() で BattleScreen が破棄され、cross のキー待ち受け（globalThis keydown）が外れる', () => {
    const f = make({ battleCommandLayout: 'cross' })
    const remove = vi.spyOn(globalThis, 'removeEventListener')
    f.startBattle([enemy()])
    const screen = f.battleScreen!
    f.initialized = false // PixiJS Application の実体は無いので app.destroy 側は通さない
    f.destroy()
    expect(screen.destroyed).toBe(true)
    expect(f.battleScreen).toBeNull()
    expect(remove.mock.calls.map((c) => c[0])).toContain('keydown')
  })

  it('設定オーバーレイ中（setInputSuspended）は ATB の進行（BattleScreen.tick）も止まり、解除で再開する', () => {
    const f = make()
    f.startBattle([enemy()])
    const spy = vi.spyOn(f.battleScreen!, 'tick')
    const tickAt = (from: number, to: number) => {
      f.lastTickMs = from
      vi.spyOn(performance, 'now').mockReturnValue(to)
      f.onTick()
    }
    f.setInputSuspended(true)
    tickAt(1000, 1050)
    expect(spy).not.toHaveBeenCalled()
    f.setInputSuspended(false)
    tickAt(2000, 2050)
    expect(spy).toHaveBeenCalledWith(50)
  })
})

describe.each([
  ['TopDownRenderer', topDown],
  ['RaycastRenderer', raycast],
])('%s の戦闘の画面遷移 battle_transition: ff (#830)', (_name, make) => {
  const advance = (f: Field, ms: number): void => {
    for (let e = 0; e < ms; e += 16) f.transition.tick(16)
  }

  it('ff-mosaic でも ff と同様に演出が先に走り、モザイクの size が付いて終わると外れる (#953)', () => {
    const f = make({ battleTransition: 'ff-mosaic' })
    f.startBattle([enemy()])
    expect(f.battleScreen).toBeNull()
    expect(f.transition.active).toBe(true)
    let max = 1
    for (let e = 0; e < 3000 && f.transition.active; e += 16) {
      f.transition.tick(16)
      const pf = (f.app.stage.filters ?? [])[0] as { sizeX?: number } | undefined
      if (pf?.sizeX) max = Math.max(max, pf.sizeX)
    }
    expect(max).toBeGreaterThan(5)
    expect(f.battleScreen).not.toBeNull()
    expect(f.app.stage.scale.x).toBe(1)
    expect(f.app.stage.filters ?? []).toHaveLength(0)
  })

  it('同じレンダラーで ff-mosaic → load(ff) の順に戦っても、ff の戦闘にモザイクを持ち越さない (#953)', () => {
    const f = make({ battleTransition: 'ff-mosaic' })
    f.startBattle([enemy()])
    let max = 1
    for (let e = 0; e < 3000 && f.transition.active; e += 16) {
      f.transition.tick(16)
      const pf = (f.app.stage.filters ?? [])[0] as { sizeX?: number } | undefined
      if (pf?.sizeX) max = Math.max(max, pf.sizeX)
    }
    expect(max).toBeGreaterThan(5)
    f.load(
      project(f instanceof TopDownRenderer ? 'topdown' : 'raycast', { battleTransition: 'ff' })
    )
    f.startBattle([enemy()])
    expect(f.transition.active).toBe(true)
    for (let e = 0; e < 3000 && f.transition.active; e += 16) {
      f.transition.tick(16)
      expect(f.app.stage.filters ?? []).toHaveLength(0)
    }
  })

  it('ff ではモザイクは付かない (#953)', () => {
    const f = make({ battleTransition: 'ff' })
    f.startBattle([enemy()])
    for (let e = 0; e < 3000 && f.transition.active; e += 16) {
      f.transition.tick(16)
      expect(f.app.stage.filters ?? []).toHaveLength(0)
    }
  })

  it('既定（none）は演出なしで即座に戦闘画面が開く', () => {
    const f = make()
    f.startBattle([enemy()])
    expect(f.transition.active).toBe(false)
    expect(f.battleScreen).not.toBeNull()
  })

  it('ff: 開始は演出が先 → 真っ暗で戦闘画面が開き、演出中は多重起動しない。見た目は等倍に戻る', () => {
    const f = make({ battleTransition: 'ff' })
    const mock = vi.mocked(openFieldBattle)
    mock.mockClear()
    const beats: number[] = []
    f.setBattleTransitionHooks({ onTransitionBeat: (n) => beats.push(n) })
    f.startBattle([enemy()])
    expect(f.battleScreen).toBeNull()
    expect(mock).not.toHaveBeenCalled()
    expect(f.transition.active).toBe(true)
    advance(f, 500)
    expect(f.app.stage.scale.x).toBeGreaterThan(1)
    f.startBattle([enemy()]) // 演出中の再発火は無視
    advance(f, 3000)
    expect(mock).toHaveBeenCalledTimes(1)
    expect(f.battleScreen).not.toBeNull()
    expect(f.transition.active).toBe(false)
    expect(f.app.stage.scale.x).toBe(1)
    expect(beats).toEqual([1, 2])
  })

  it('ff: 終了は勝敗待機の後、黒を経由して畳まれる。畳むのは真っ暗の間で、戻った後のクールダウンも張られる', () => {
    const f = make({ battleTransition: 'ff' })
    f.startBattle([enemy()])
    advance(f, 3000)
    const screen = f.battleScreen!
    ;(screen.opts.onClose as (o: string) => void)('victory')
    // まだ畳まれていない（フェードアウト中）
    expect(f.battleScreen).toBe(screen)
    expect(screen.destroyed).toBe(false)
    expect(f.transition.active).toBe(true)
    advance(f, 400)
    expect(screen.destroyed).toBe(true)
    expect(f.battleScreen).toBeNull()
    expect(f.encounterCooldown).toBe(3)
    expect(f.transition.active).toBe(true) // フェードイン中もまだ入力は止まる
    f.inputGate.trackKeyDown('ArrowUp')
    advance(f, 3000)
    expect(f.transition.active).toBe(false)
    // フェードイン中に押された矢印キーは離すまで無視 (#779)
    expect(f.inputGate.isReleaseGated('ArrowUp')).toBe(true)
    expect(f.app.stage.children).not.toContain(screen)
  })

  it('ff: 開始の演出中に load() し直すと演出が捨てられ、戦闘は開かない', () => {
    const f = make({ battleTransition: 'ff' })
    const mock = vi.mocked(openFieldBattle)
    mock.mockClear()
    f.startBattle([enemy()])
    advance(f, 300)
    f.load(project('topdown', { battleTransition: 'ff' }))
    expect(f.transition.active).toBe(false)
    expect(f.app.stage.scale.x).toBe(1)
    advance(f, 3000)
    expect(mock).not.toHaveBeenCalled()
  })

  it('ff: 終了の演出中に destroy() しても演出が捨てられ、あとで戦闘が畳まれない', () => {
    const f = make({ battleTransition: 'ff' })
    f.startBattle([enemy()])
    advance(f, 3000)
    ;(f.battleScreen!.opts.onClose as (o: string) => void)('defeat')
    f.initialized = false
    f.destroy()
    expect(f.transition.active).toBe(false)
    expect(f.encounterCooldown).toBe(0)
  })

  it('ff: onTick が演出を進める', () => {
    const f = make({ battleTransition: 'ff' })
    f.startBattle([enemy()])
    let now = 10_000
    f.lastTickMs = now
    vi.spyOn(performance, 'now').mockImplementation(() => now)
    for (let i = 0; i < 80; i++) {
      now += 50
      f.onTick()
    }
    expect(f.battleScreen).not.toBeNull()
  })
})

describe.each([
  ['TopDownRenderer', topDown],
  ['RaycastRenderer', raycast],
])('%s: 画面遷移中の入力・停止・順序 (#830)', (name, make) => {
  const advance = (f: Field, ms: number): void => {
    for (let e = 0; e < ms; e += 16) f.transition.tick(16)
  }
  const isTop = name === 'TopDownRenderer'

  function spyInputs(f: Field) {
    const g = f as unknown as Record<string, unknown>
    const tryMove = vi.fn()
    const snapStep = vi.fn()
    const queueTurn = vi.fn()
    if (isTop) g.tryMove = tryMove
    g.snapStep = snapStep
    g.queueTurn = queueTurn
    const show = f.menuOverlay ? vi.spyOn(f.menuOverlay, 'showMenu') : vi.fn()
    return { tryMove, snapStep, queueTurn, show }
  }
  const key = (k: string) =>
    ({ key: k, repeat: false, preventDefault() {}, target: null }) as unknown as KeyboardEvent

  function expectIgnored(f: Field, spies: ReturnType<typeof spyInputs>) {
    f.handleKeyDown(key('ArrowUp'))
    f.handleTap()
    f.handleSwipe('up')
    f.handleSwipe('left')
    expect(spies.tryMove).not.toHaveBeenCalled()
    expect(spies.snapStep).not.toHaveBeenCalled()
    expect(spies.queueTurn).not.toHaveBeenCalled()
    expect(spies.show).not.toHaveBeenCalled()
    if (f.keys) expect(f.keys.has('ArrowUp')).toBe(false)
  }

  it('開始の演出中・終了の演出中（フェードアウト／フェードイン）は キー・タップ・スワイプ を無視する', () => {
    const f = make({ battleTransition: 'ff' })
    const spies = spyInputs(f)
    f.startBattle([enemy()])
    advance(f, 300)
    expectIgnored(f, spies) // 開始の演出中
    advance(f, 3000)
    ;(f.battleScreen!.opts.onClose as (o: string) => void)('victory')
    advance(f, 100)
    expectIgnored(f, spies) // フェードアウト中
    advance(f, 300)
    expect(f.battleScreen).toBeNull()
    expect(f.transition.active).toBe(true)
    expectIgnored(f, spies) // フェードイン中（戦闘画面は既に無い）
  })

  it('設定オーバーレイ中は onTick から演出が止まり、解除で再開する', () => {
    const f = make({ battleTransition: 'ff' })
    const spy = vi.spyOn(f.transition, 'tick')
    f.startBattle([enemy()])
    let now = 50_000
    vi.spyOn(performance, 'now').mockImplementation(() => now)
    f.setInputSuspended(true)
    f.lastTickMs = now
    now += 50
    f.onTick()
    expect(spy).not.toHaveBeenCalled()
    f.setInputSuspended(false)
    f.lastTickMs = now
    now += 50
    f.onTick()
    expect(spy).toHaveBeenCalledWith(50)
  })

  it('interlude は黒の間に幕より手前へ載り、フェードインに入ると stage から外れる', () => {
    const f = make({ battleTransition: 'ff' })
    const extra = new Container()
    ;(f as unknown as { transition: FieldBattleTransition }).transition.hooks = {
      interlude: () => ({ container: extra, durationMs: 400 }),
    }
    f.startBattle([enemy()])
    advance(f, 3000)
    ;(f.battleScreen!.opts.onClose as (o: string) => void)('victory')
    advance(f, 400)
    const ch = f.app.stage.children
    expect(ch).toContain(extra)
    expect(ch.indexOf(extra)).toBe(ch.length - 1)
    advance(f, 1500)
    expect(f.app.stage.children).not.toContain(extra)
  })
})

describe('TopDownRenderer: 終了演出の黒の間に踏み込みトリガーが発火する (#830)', () => {
  it('deferredStepTrigger は onBlack（戦闘画面が畳まれた瞬間）で発火し、それより前には発火しない', () => {
    const f = topDown({ battleTransition: 'ff' })
    const check = vi.fn()
    ;(f as unknown as Record<string, unknown>).checkStepTriggers = check
    f.startBattle([enemy()])
    f.deferredStepTrigger = { x: 3, y: 4 }
    for (let e = 0; e < 3000; e += 16) f.transition.tick(16)
    ;(f.battleScreen!.opts.onClose as (o: string) => void)('victory')
    for (let e = 0; e < 100; e += 16) f.transition.tick(16)
    expect(check).not.toHaveBeenCalled()
    for (let e = 0; e < 300; e += 16) f.transition.tick(16)
    expect(check).toHaveBeenCalledWith(3, 4)
    expect(f.transition.active).toBe(true) // まだフェードイン中
  })
})
