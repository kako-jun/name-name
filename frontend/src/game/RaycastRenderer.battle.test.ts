/**
 * RaycastRenderer.startBattle の配線 (#736) の単体テスト。
 *
 * Application の init（WebGL）は不要なので、コンストラクタ直後のインスタンスに最小限の
 * internals（`app.stage`）を差し込み、`load()` / `startBattle()` / `buildPartyBattleEntities()` を駆動する。
 * BattleScreen は本物を使い、渡された engine / opts は internals 経由で観測する。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Assets, Container } from 'pixi.js'
import { RaycastRenderer } from './RaycastRenderer'
import type { BattleEngine } from './battleEngine'
import type { BattleEntity } from './spellDsl'
import type { PartyMemberDef } from '../types'
import type { RPGProject } from '../types/rpg'
import {
  buildPartyBattleEntities as buildParty,
  partyDefToBattleEntity as partyDefToEntity,
  type FieldBattleSettings,
} from './fieldBattle'

function member(id: string, over: Partial<PartyMemberDef> = {}): PartyMemberDef {
  return { id, name: id.toUpperCase(), hp: 20, mp: 5, atk: 4, def: 2, agi: 3, ...over }
}

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

interface RendererInternals {
  app: { stage: Container }
  masterParty: Record<string, PartyMemberDef>
  masterPartyOrder: string[]
  battleSettings: FieldBattleSettings
  battleScreen: { engine: BattleEngine; opts: Record<string, unknown> } | null
  startBattle(enemies: BattleEntity[]): void
  ensureWallTextures(): Promise<void>
}

function makeRenderer(): { r: RaycastRenderer; i: RendererInternals } {
  const r = new RaycastRenderer()
  const i = r as unknown as RendererInternals
  i.app = { stage: new Container() }
  return { r, i }
}

function project(over: Partial<RPGProject> = {}): RPGProject {
  return {
    name: 't',
    version: '1.0.0',
    map: {
      width: 2,
      height: 2,
      tileSize: 32,
      tiles: [
        [0, 0],
        [0, 0],
      ],
    },
    player: { x: 0, y: 0, direction: 'up' },
    npcs: [],
    view: 'raycast',
    ...over,
  }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('RaycastRenderer.startBattle の味方組み立て (#736)', () => {
  it('front・masterParty 空 → エンジンの味方は hero 1 人', () => {
    const { i } = makeRenderer()
    i.startBattle([enemy()])
    const party = i.battleScreen!.engine.getState().party
    expect(party.map((p) => p.id)).toEqual(['hero'])
  })

  it('front・3 人定義 → エンジンに渡るのは hero のみ（画面に出ない仲間を戦闘に混ぜない）', () => {
    const { i } = makeRenderer()
    i.masterParty = { hero: member('hero'), mage: member('mage'), priest: member('priest') }
    i.startBattle([enemy()])
    expect(i.battleScreen!.engine.getState().party.map((p) => p.id)).toEqual(['hero'])
  })

  it('side・3 人 → hero 先頭・残りは定義順', () => {
    const { i } = makeRenderer()
    // hero が定義の途中にあっても先頭に来る
    i.masterParty = { mage: member('mage'), hero: member('hero'), priest: member('priest') }
    i.battleSettings.layout = 'side'
    i.startBattle([enemy()])
    expect(i.battleScreen!.engine.getState().party.map((p) => p.id)).toEqual([
      'hero',
      'mage',
      'priest',
    ])
  })

  it('side・hero 定義なし → 定義にない「ゆうしゃ」を混ぜず、定義順の先頭から', () => {
    const { i } = makeRenderer()
    i.masterParty = { mage: member('mage'), priest: member('priest') }
    i.battleSettings.layout = 'side'
    const party = buildParty({ party: i.masterParty, order: i.masterPartyOrder }, i.battleSettings.layout)
    expect(party.map((p) => p.id)).toEqual(['mage', 'priest'])
  })

  it('side・ID が整数風でも masterPartyOrder の定義順になる（Object.entries の並べ替えに負けない）', () => {
    const { i } = makeRenderer()
    i.masterParty = { b: member('b'), '2': member('2'), a: member('a'), '1': member('1') }
    i.masterPartyOrder = ['b', '2', 'a', '1']
    i.battleSettings.layout = 'side'
    expect(buildParty({ party: i.masterParty, order: i.masterPartyOrder }, i.battleSettings.layout).map((p) => p.id)).toEqual(['b', '2', 'a', '1'])
  })

  it('side・hero と整数風 ID → hero 先頭・残りは定義順', () => {
    const { i } = makeRenderer()
    i.masterParty = { '3': member('3'), hero: member('hero'), '1': member('1') }
    i.masterPartyOrder = ['3', 'hero', '1']
    i.battleSettings.layout = 'side'
    expect(buildParty({ party: i.masterParty, order: i.masterPartyOrder }, i.battleSettings.layout).map((p) => p.id)).toEqual(['hero', '3', '1'])
  })

  it('side・masterParty 空 → ハードコード hero 1 人', () => {
    const { i } = makeRenderer()
    i.battleSettings.layout = 'side'
    expect(buildParty({ party: i.masterParty, order: i.masterPartyOrder }, i.battleSettings.layout).map((p) => p.id)).toEqual(['hero'])
  })

  it('partyDefToBattleEntity が sprite と ステータスを写す', () => {
    const { i } = makeRenderer()
    const e = partyDefToEntity(member('mage', { sprite: 'p/mage.webp', mp: 9 }), i.battleSettings.layout)
    expect(e.sprite).toBe('p/mage.webp')
    expect(e.maxHp).toBe(e.hp)
    expect(e.mp).toBe(9)
    expect(e.maxMp).toBe(9)
  })

  it('partyDefToBattleEntity: mp 未定義は 0、sprite 未指定は undefined', () => {
    const { i } = makeRenderer()
    const e = partyDefToEntity({ ...member('x'), mp: undefined }, i.battleSettings.layout)
    expect(e.mp).toBe(0)
    expect(e.maxMp).toBe(0)
    expect(e.sprite).toBeUndefined()
  })

  it('hero 定義の sprite も戦闘 entity に写る', () => {
    const { i } = makeRenderer()
    i.masterParty = { hero: member('hero', { sprite: 'p/hero.webp' }) }
    expect(buildParty({ party: i.masterParty, order: i.masterPartyOrder }, i.battleSettings.layout)[0].sprite).toBe('p/hero.webp')
  })
})

describe('RaycastRenderer.load → BattleScreen opts の流れ (#736)', () => {
  function loaded(p: Partial<RPGProject>) {
    const { r, i } = makeRenderer()
    i.ensureWallTextures = async () => {}
    r.load(project(p))
    return i
  }

  it('load() が battleLayout / battleBackground を保持し BattleScreen の opts に流す', () => {
    vi.spyOn(Assets, 'load').mockResolvedValue({ width: 1, height: 1 } as never)
    const i = loaded({ battleLayout: 'side', battleBackground: 'bg/a.webp' })
    expect(i.battleSettings.layout).toBe('side')
    expect(i.battleSettings.background).toBe('bg/a.webp')
    i.startBattle([enemy()])
    expect(i.battleScreen!.opts.layout).toBe('side')
    expect(i.battleScreen!.opts.background).toBe('bg/a.webp')
    expect(Assets.load).toHaveBeenCalledWith('bg/a.webp')
  })

  it('battleLayout 未指定 → front・背景なし（Assets.load を呼ばない）', () => {
    const load = vi.spyOn(Assets, 'load')
    const i = loaded({})
    expect(i.battleSettings.layout).toBe('front')
    expect(i.battleSettings.background).toBeUndefined()
    i.startBattle([enemy()])
    expect(i.battleScreen!.opts.layout).toBe('front')
    expect(load).not.toHaveBeenCalled()
  })

  it('load() の再呼び出しで前回の side 設定が残らない', () => {
    const { r, i } = makeRenderer()
    i.ensureWallTextures = async () => {}
    vi.spyOn(Assets, 'load').mockResolvedValue({ width: 1, height: 1 } as never)
    r.load(project({ battleLayout: 'side', battleBackground: 'bg/a.webp' }))
    r.load(project({}))
    expect(i.battleSettings.layout).toBe('front')
    expect(i.battleSettings.background).toBeUndefined()
  })

  it('load() の masterParty が side の味方組み立てに使われる', () => {
    const i = loaded({
      battleLayout: 'side',
      party: { hero: member('hero'), mage: member('mage') },
    })
    i.startBattle([enemy()])
    expect(i.battleScreen!.engine.getState().party.map((p) => p.id)).toEqual(['hero', 'mage'])
  })
})

describe('RaycastRenderer.startBattle のガード (#736 で壊していないことの回帰)', () => {
  it('多重起動防止: 戦闘中に再度呼んでも最初の BattleScreen が維持される', () => {
    const { i } = makeRenderer()
    i.startBattle([enemy()])
    const first = i.battleScreen
    i.startBattle([enemy()])
    expect(i.battleScreen).toBe(first)
    expect(i.app.stage.children).toHaveLength(1)
  })

  it('敵が空なら戦闘を始めない', () => {
    const { i } = makeRenderer()
    i.startBattle([])
    expect(i.battleScreen).toBeNull()
  })
})

describe('RaycastRenderer: partyOrder と resize の配線 (#736)', () => {
  it('load() の partyOrder が side の味方順に使われる（整数風 ID）', () => {
    const { r, i } = makeRenderer()
    i.ensureWallTextures = async () => {}
    r.load(
      project({
        battleLayout: 'side',
        party: { b: member('b'), '2': member('2'), a: member('a') },
        partyOrder: ['b', '2', 'a'],
      })
    )
    i.startBattle([enemy()])
    expect(i.battleScreen!.engine.getState().party.map((p) => p.id)).toEqual(['b', '2', 'a'])
  })

  it('戦闘中のリサイズで BattleScreen.redraw が新しい画面サイズで呼ばれる', () => {
    const { i } = makeRenderer()
    const ri = i as unknown as {
      initialized: boolean
      app: Record<string, unknown>
      handleResize(): void
      screenWidth: number
      screenHeight: number
    }
    vi.stubGlobal('requestAnimationFrame', (cb: () => void) => {
      cb()
      return 1
    })
    try {
      ri.initialized = true
      ri.app = {
        stage: new Container(),
        canvas: { parentElement: { getBoundingClientRect: () => ({ width: 640, height: 360 }) } },
        renderer: { resize: vi.fn() },
      }
      i.startBattle([enemy()])
      const redraw = vi.fn()
      ;(i.battleScreen as unknown as { redraw: typeof redraw }).redraw = redraw
      ri.handleResize()
      expect(redraw).toHaveBeenCalledWith(640, 360)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('戦闘中でなければリサイズで例外にならない', () => {
    const { i } = makeRenderer()
    const ri = i as unknown as {
      initialized: boolean
      app: Record<string, unknown>
      handleResize(): void
    }
    vi.stubGlobal('requestAnimationFrame', (cb: () => void) => {
      cb()
      return 1
    })
    try {
      ri.initialized = true
      ri.app = {
        stage: new Container(),
        canvas: { parentElement: { getBoundingClientRect: () => ({ width: 640, height: 360 }) } },
        renderer: { resize: vi.fn() },
      }
      expect(() => ri.handleResize()).not.toThrow()
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

describe('RaycastRenderer.load → spriteStyle の流れ (#737)', () => {
  function loaded(p: Partial<RPGProject>) {
    const { r, i } = makeRenderer()
    i.ensureWallTextures = async () => {}
    r.load(project(p))
    return { r, i }
  }

  it("load() が spriteStyle を保持し BattleScreen の opts に流す（'acrylic' → opts.spriteStyle === 'acrylic'）", () => {
    const { i } = loaded({ battleLayout: 'side', spriteStyle: 'acrylic' })
    expect(i.battleSettings.spriteStyle).toBe('acrylic')
    i.startBattle([enemy()])
    expect(i.battleScreen!.opts.spriteStyle).toBe('acrylic')
  })

  it("spriteStyle 未指定 → 'none' で opts にも 'none' が渡る", () => {
    const { i } = loaded({ battleLayout: 'side' })
    expect(i.battleSettings.spriteStyle).toBe('none')
    i.startBattle([enemy()])
    expect(i.battleScreen!.opts.spriteStyle).toBe('none')
  })

  it("battleLayout:'front' + spriteStyle:'acrylic' でも opts に渡る（無効化は BattleScreen 側の責務）", () => {
    const { i } = loaded({ battleLayout: 'front', spriteStyle: 'acrylic' })
    i.startBattle([enemy()])
    expect(i.battleScreen!.opts.layout).toBe('front')
    expect(i.battleScreen!.opts.spriteStyle).toBe('acrylic')
  })

  it('load() の再呼び出しで前回の acrylic が残らない（acrylic → 未指定で none に戻る）', () => {
    const { r, i } = loaded({ spriteStyle: 'acrylic' })
    expect(i.battleSettings.spriteStyle).toBe('acrylic')
    r.load(project({}))
    expect(i.battleSettings.spriteStyle).toBe('none')
    i.startBattle([enemy()])
    expect(i.battleScreen!.opts.spriteStyle).toBe('none')
  })
})

describe('RaycastRenderer.load → windowStyle の流れ (#744)', () => {
  function loaded(p: Partial<RPGProject>) {
    const { r, i } = makeRenderer()
    i.ensureWallTextures = async () => {}
    r.load(project(p))
    return { r, i }
  }

  it("load() が windowStyle を保持し BattleScreen の opts に流す（'ff-blue' → opts.windowStyle === 'ff-blue'）", () => {
    const { i } = loaded({ windowStyle: 'ff-blue' })
    i.startBattle([enemy()])
    expect(i.battleScreen!.opts.windowStyle).toBe('ff-blue')
  })

  it("windowStyle 未指定 → 'dark' で opts にも 'dark' が渡る", () => {
    const { i } = loaded({})
    i.startBattle([enemy()])
    expect(i.battleScreen!.opts.windowStyle).toBe('dark')
  })

  it('load() の再呼び出しで前回の ff-blue が残らない', () => {
    const { r, i } = loaded({ windowStyle: 'ff-blue' })
    r.load(project({}))
    i.startBattle([enemy()])
    expect(i.battleScreen!.opts.windowStyle).toBe('dark')
  })
})

describe('RaycastRenderer: 隊列・奥行き・前景の配線 (#747)', () => {
  it('side・row: back（別名 後衛 も）→ BattleEntity.row が back', () => {
    const { i } = makeRenderer()
    i.battleSettings.layout = 'side'
    expect(partyDefToEntity(member('a', { row: 'back' }), i.battleSettings.layout).row).toBe('back')
    expect(partyDefToEntity(member('b', { row: '後衛' }), i.battleSettings.layout).row).toBe('back')
  })
  it('side・row 未指定・front・未知値 → row キーなし', () => {
    const { i } = makeRenderer()
    i.battleSettings.layout = 'side'
    expect('row' in partyDefToEntity(member('a'), i.battleSettings.layout)).toBe(false)
    expect('row' in partyDefToEntity(member('b', { row: 'front' }), i.battleSettings.layout)).toBe(false)
    expect('row' in partyDefToEntity(member('c', { row: 'foo' }), i.battleSettings.layout)).toBe(false)
  })
  it('front 配置では row: back でも row キーを載せない', () => {
    const { i } = makeRenderer()
    i.battleSettings.layout = 'front'
    expect('row' in partyDefToEntity(member('a', { row: 'back' }), i.battleSettings.layout)).toBe(false)
  })
  it('load() の battleDepth / battleForeground が BattleScreen の opts に流れる', () => {
    vi.spyOn(Assets, 'load').mockResolvedValue({ width: 1, height: 1 } as never)
    const { r, i } = makeRenderer()
    i.ensureWallTextures = async () => {}
    r.load(
      project({
        battleLayout: 'side',
        battleDepth: { horizon: 0.3, perspective: 0.8 },
        battleForeground: 'fg/a.png',
      })
    )
    i.startBattle([enemy()])
    expect(i.battleScreen!.opts.depth).toEqual({ horizon: 0.3, perspective: 0.8 })
    expect(i.battleScreen!.opts.foreground).toBe('fg/a.png')
  })
  it('未指定: depth は null・foreground は undefined、再 load で前回値が残らない', () => {
    vi.spyOn(Assets, 'load').mockResolvedValue({ width: 1, height: 1 } as never)
    const { r, i } = makeRenderer()
    i.ensureWallTextures = async () => {}
    r.load(
      project({ battleDepth: { horizon: 0.3, perspective: 0.8 }, battleForeground: 'fg/a.png' })
    )
    r.load(project({}))
    i.startBattle([enemy()])
    expect(i.battleScreen!.opts.depth).toBeNull()
    expect(i.battleScreen!.opts.foreground).toBeUndefined()
  })
})

describe('RaycastRenderer.load → battleAtb の流れ (#205)', () => {
  function loaded(p: Partial<RPGProject>) {
    const { r, i } = makeRenderer()
    i.ensureWallTextures = async () => {}
    r.load(project(p))
    return { r, i }
  }

  it("battleAtb: { mode: 'active' } → startBattle のエンジンは ATB（active・atb-running）", () => {
    const { i } = loaded({ battleLayout: 'side', battleAtb: { mode: 'active' } })
    i.startBattle([enemy()])
    const s = i.battleScreen!.engine.getState()
    expect(s.atb?.mode).toBe('active')
    expect(s.phase).toBe('atb-running')
  })

  it('battleAtb 未指定 → 従来ターン制（state.atb なし・party-input）', () => {
    const { i } = loaded({ battleLayout: 'side' })
    i.startBattle([enemy()])
    const s = i.battleScreen!.engine.getState()
    expect(s.atb).toBeUndefined()
    expect(s.phase).toBe('party-input')
  })

  it('front でも ATB が有効（先頭 1 人のゲージ）', () => {
    const { i } = loaded({ battleLayout: 'front', battleAtb: { mode: 'wait' } })
    i.startBattle([enemy()])
    expect(i.battleScreen!.engine.getState().atb?.partyGauge).toHaveLength(1)
  })

  it('load() の再呼び出しで前回の ATB 設定が残らない', () => {
    const { r, i } = loaded({ battleAtb: { mode: 'active' } })
    r.load(project({}))
    i.startBattle([enemy()])
    expect(i.battleScreen!.engine.getState().atb).toBeUndefined()
  })
})

describe('RaycastRenderer.onTick → BattleScreen.tick の配線 (#205)', () => {
  interface TickInternals extends RendererInternals {
    lastTickMs: number
    onTick(): void
    advanceTurnAnim(dt: number): void
    updateMovement(dt: number): void
    updateNpcAnimations(now: number): void
    renderFrame(): void
  }
  function ticking() {
    const { r, i } = makeRenderer()
    const t = i as unknown as TickInternals
    t.advanceTurnAnim = () => {}
    t.updateMovement = () => {}
    t.updateNpcAnimations = () => {}
    t.renderFrame = () => {}
    return { r, t }
  }

  it('戦闘中は経過 ms が BattleScreen.tick に渡り、ATB のゲージが進む', () => {
    const { t } = ticking()
    ;(t as unknown as { battleSettings: FieldBattleSettings }).battleSettings.atb = { mode: 'wait' }
    t.startBattle([enemy()])
    const screen = t.battleScreen as unknown as { tick(ms: number): void }
    const spy = vi.spyOn(screen, 'tick')
    vi.spyOn(performance, 'now').mockReturnValue(1050)
    t.lastTickMs = 1000
    t.onTick()
    expect(spy).toHaveBeenCalledTimes(1)
    expect(spy.mock.calls[0][0]).toBeCloseTo(50, 6)
    expect(t.battleScreen!.engine.getState().atb!.partyGauge[0]).toBeGreaterThan(0)
  })

  it('1 フレームの経過は 100ms に丸められる（タブ復帰で巨大な dt が来ても暴走しない）', () => {
    const { t } = ticking()
    t.startBattle([enemy()])
    const screen = t.battleScreen as unknown as { tick(ms: number): void }
    const spy = vi.spyOn(screen, 'tick')
    vi.spyOn(performance, 'now').mockReturnValue(100000)
    t.lastTickMs = 0
    t.onTick()
    expect(spy.mock.calls[0][0]).toBeCloseTo(100, 6)
  })

  it('戦闘中でなければ例外にならない', () => {
    const { t } = ticking()
    expect(() => t.onTick()).not.toThrow()
  })
})

describe('RaycastRenderer.load → pixelArt の流れ (#760)', () => {
  function loaded(p: Partial<RPGProject>) {
    const { r, i } = makeRenderer()
    i.ensureWallTextures = async () => {}
    r.load(project(p))
    return { r, i }
  }

  it('pixelArt: true → BattleScreen の opts.pixelArt === true', () => {
    const { i } = loaded({ battleLayout: 'side', pixelArt: true })
    i.startBattle([enemy()])
    expect(i.battleScreen!.opts.pixelArt).toBe(true)
  })

  it('pixelArt 未指定 → opts.pixelArt === false（mipmap + linear）', () => {
    const { i } = loaded({ battleLayout: 'side' })
    i.startBattle([enemy()])
    expect(i.battleScreen!.opts.pixelArt).toBe(false)
  })

  it('load() の再呼び出しで前回の pixelArt が残らない', () => {
    const { r, i } = loaded({ pixelArt: true })
    r.load(project({}))
    i.startBattle([enemy()])
    expect(i.battleScreen!.opts.pixelArt).toBe(false)
  })

  it('front でも pixelArt は opts に渡る（無効化は BattleScreen 側の責務）', () => {
    const { i } = loaded({ battleLayout: 'front', pixelArt: true })
    i.startBattle([enemy()])
    expect(i.battleScreen!.opts.pixelArt).toBe(true)
  })
})

describe('RaycastRenderer.load → commandLayout / commandLabels の流れ (#204)', () => {
  function loaded(p: Partial<RPGProject>) {
    const { r, i } = makeRenderer()
    i.ensureWallTextures = async () => {}
    r.load(project(p))
    return { r, i }
  }

  it('load() が battleCommandLayout / battleCommandLabels を保持し BattleScreen の opts に流す', () => {
    const { i } = loaded({
      battleLayout: 'side',
      battleCommandLayout: 'cross',
      battleCommandLabels: { attack: '斬る' },
    })
    i.startBattle([enemy()])
    expect(i.battleScreen!.opts.commandLayout).toBe('cross')
    expect(i.battleScreen!.opts.commandLabels).toEqual({ attack: '斬る' })
  })

  it('キー未設定で再 load() すると grid / undefined に戻る', () => {
    const { r, i } = loaded({
      battleLayout: 'side',
      battleCommandLayout: 'cross',
      battleCommandLabels: { attack: '斬る' },
    })
    r.load(project({}))
    i.startBattle([enemy()])
    expect(i.battleScreen!.opts.commandLayout).toBe('grid')
    expect(i.battleScreen!.opts.commandLabels).toBeUndefined()
  })
})

describe('RaycastRenderer: 戦闘中のキー入力とフィールド移動 (#204)', () => {
  interface KeyInternals extends RendererInternals {
    initialized: boolean
    playerX: number
    playerY: number
    playerAngle: number
    stepCounter: number
    keys: Set<string>
    lastTickMs: number
    handleKeyDown(e: KeyboardEvent): void
    handleKeyUp(e: KeyboardEvent): void
    handleBlur(): void
    inputGate: { heldKeys(): string[] }
    setInputSuspended(v: boolean): void
    onTick(): void
    advanceTurnAnim(dt: number): void
    updateNpcAnimations(now: number): void
    renderFrame(): void
  }
  const key = (type: 'keydown' | 'keyup', k: string) =>
    new KeyboardEvent(type, { key: k, bubbles: true, cancelable: true })

  function field(over: Partial<RPGProject> = {}) {
    const { r, i } = makeRenderer()
    i.ensureWallTextures = async () => {}
    const map = {
      width: 9,
      height: 9,
      tileSize: 32,
      tiles: Array.from({ length: 9 }, () => Array(9).fill(0)),
    }
    r.load(project({ map, player: { x: 4, y: 4, direction: 'up' }, ...over }))
    const t = i as unknown as KeyInternals
    t.initialized = true
    t.advanceTurnAnim = () => {}
    t.updateNpcAnimations = () => {}
    t.renderFrame = () => {}
    return t
  }
  const tick = (t: KeyInternals, ms: number) => {
    vi.spyOn(performance, 'now').mockReturnValue(t.lastTickMs + ms)
    t.onTick()
  }
  const pose = (t: KeyInternals) => [t.playerX, t.playerY, t.playerAngle]

  it('対照: 戦闘していなければ ArrowUp + tick でプレイヤーが動く', () => {
    const t = field()
    const before = pose(t)
    t.handleKeyDown(key('keydown', 'ArrowUp'))
    tick(t, 80)
    expect(pose(t)).not.toEqual(before)
  })

  it('戦闘中に矢印キーを押して tick しても、位置・角度・歩数が変わらない', () => {
    const t = field({ battleLayout: 'side' })
    t.startBattle([enemy()])
    const before = pose(t)
    const steps = t.stepCounter
    for (const k of ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']) {
      t.handleKeyDown(key('keydown', k))
    }
    tick(t, 80)
    expect(pose(t)).toEqual(before)
    expect(t.stepCounter).toBe(steps)
    expect(t.keys.size).toBe(0)
  })

  it('戦闘開始時に押しっぱなしだった移動キーは、戦闘終了後に残って動き続けない', () => {
    const t = field({ battleLayout: 'side' })
    t.handleKeyDown(key('keydown', 'ArrowDown'))
    t.startBattle([enemy()])
    expect(t.keys.size).toBe(0)
    const opts = t.battleScreen!.opts as { onClose(o: string): void }
    opts.onClose('escaped')
    expect(t.battleScreen).toBeNull()
    const before = pose(t)
    tick(t, 80)
    expect(pose(t)).toEqual(before)
  })

  it('戦闘中に keydown した移動キーも、戦闘終了後に残らない', () => {
    const t = field({ battleLayout: 'side' })
    t.startBattle([enemy()])
    t.handleKeyDown(key('keydown', 'ArrowUp'))
    ;(t.battleScreen!.opts as { onClose(o: string): void }).onClose('victory')
    const before = pose(t)
    tick(t, 80)
    expect(pose(t)).toEqual(before)
  })

  it('開始時に押されていた矢印キーが BattleScreen の initialHeldKeys に渡る（keyup 後は渡らない）', () => {
    const t = field({ battleLayout: 'side' })
    t.handleKeyDown(key('keydown', 'ArrowUp'))
    t.handleKeyDown(key('keydown', 'ArrowLeft'))
    t.handleKeyUp(key('keyup', 'ArrowLeft'))
    t.startBattle([enemy()])
    expect(t.battleScreen!.opts.initialHeldKeys).toEqual(['ArrowUp'])
  })

  it('戦闘終了時に押しっぱなしだった矢印キーは repeat の keydown でも動かず、keyup 後の新しい押下では動く', () => {
    const t = field({ battleLayout: 'side' })
    t.handleKeyDown(key('keydown', 'ArrowDown'))
    t.startBattle([enemy()])
    ;(t.battleScreen!.opts as { onClose(o: string): void }).onClose('escaped')
    const before = pose(t)
    t.handleKeyDown(new KeyboardEvent('keydown', { key: 'ArrowDown', repeat: true }))
    tick(t, 80)
    expect(pose(t)).toEqual(before)
    t.handleKeyUp(key('keyup', 'ArrowDown'))
    t.handleKeyDown(key('keydown', 'ArrowDown'))
    tick(t, 80)
    expect(pose(t)).not.toEqual(before)
  })

  it('setInputSuspended(true) の間はフィールドも動かず、押下キーは捨てられ、解除で再び動く', () => {
    const t = field()
    t.handleKeyDown(key('keydown', 'ArrowUp'))
    t.setInputSuspended(true)
    expect(t.keys.size).toBe(0)
    t.handleKeyDown(key('keydown', 'ArrowUp'))
    const before = pose(t)
    tick(t, 80)
    expect(pose(t)).toEqual(before)
    t.setInputSuspended(false)
    t.handleKeyDown(key('keydown', 'ArrowUp'))
    tick(t, 80)
    expect(pose(t)).not.toEqual(before)
  })

  it('戦闘の isInputSuspended は setInputSuspended の状態を返す', () => {
    const t = field({ battleLayout: 'side' })
    t.startBattle([enemy()])
    const f = t.battleScreen!.opts.isInputSuspended as () => boolean
    expect(f()).toBe(false)
    t.setInputSuspended(true)
    expect(f()).toBe(true)
  })

  it('window の blur で keys・押下記録が捨てられる', () => {
    const t = field()
    t.handleKeyDown(key('keydown', 'ArrowUp'))
    expect(t.keys.size).toBe(1)
    t.handleBlur()
    expect(t.keys.size).toBe(0)
    expect(t.inputGate.heldKeys().length).toBe(0)
  })
})
