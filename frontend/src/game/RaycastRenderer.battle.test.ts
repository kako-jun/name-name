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
  battleLayout: 'front' | 'side'
  battleBackground: string | undefined
  spriteStyle: 'none' | 'acrylic'
  battleScreen: { engine: BattleEngine; opts: Record<string, unknown> } | null
  startBattle(enemies: BattleEntity[]): void
  buildPartyBattleEntities(): BattleEntity[]
  partyDefToBattleEntity(def: PartyMemberDef): BattleEntity
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
    i.battleLayout = 'side'
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
    i.battleLayout = 'side'
    const party = i.buildPartyBattleEntities()
    expect(party.map((p) => p.id)).toEqual(['mage', 'priest'])
  })

  it('side・ID が整数風でも masterPartyOrder の定義順になる（Object.entries の並べ替えに負けない）', () => {
    const { i } = makeRenderer()
    i.masterParty = { b: member('b'), '2': member('2'), a: member('a'), '1': member('1') }
    i.masterPartyOrder = ['b', '2', 'a', '1']
    i.battleLayout = 'side'
    expect(i.buildPartyBattleEntities().map((p) => p.id)).toEqual(['b', '2', 'a', '1'])
  })

  it('side・hero と整数風 ID → hero 先頭・残りは定義順', () => {
    const { i } = makeRenderer()
    i.masterParty = { '3': member('3'), hero: member('hero'), '1': member('1') }
    i.masterPartyOrder = ['3', 'hero', '1']
    i.battleLayout = 'side'
    expect(i.buildPartyBattleEntities().map((p) => p.id)).toEqual(['hero', '3', '1'])
  })

  it('side・masterParty 空 → ハードコード hero 1 人', () => {
    const { i } = makeRenderer()
    i.battleLayout = 'side'
    expect(i.buildPartyBattleEntities().map((p) => p.id)).toEqual(['hero'])
  })

  it('partyDefToBattleEntity が sprite と ステータスを写す', () => {
    const { i } = makeRenderer()
    const e = i.partyDefToBattleEntity(member('mage', { sprite: 'p/mage.webp', mp: 9 }))
    expect(e.sprite).toBe('p/mage.webp')
    expect(e.maxHp).toBe(e.hp)
    expect(e.mp).toBe(9)
    expect(e.maxMp).toBe(9)
  })

  it('partyDefToBattleEntity: mp 未定義は 0、sprite 未指定は undefined', () => {
    const { i } = makeRenderer()
    const e = i.partyDefToBattleEntity({ ...member('x'), mp: undefined })
    expect(e.mp).toBe(0)
    expect(e.maxMp).toBe(0)
    expect(e.sprite).toBeUndefined()
  })

  it('hero 定義の sprite も戦闘 entity に写る', () => {
    const { i } = makeRenderer()
    i.masterParty = { hero: member('hero', { sprite: 'p/hero.webp' }) }
    expect(i.buildPartyBattleEntities()[0].sprite).toBe('p/hero.webp')
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
    expect(i.battleLayout).toBe('side')
    expect(i.battleBackground).toBe('bg/a.webp')
    i.startBattle([enemy()])
    expect(i.battleScreen!.opts.layout).toBe('side')
    expect(i.battleScreen!.opts.background).toBe('bg/a.webp')
    expect(Assets.load).toHaveBeenCalledWith('bg/a.webp')
  })

  it('battleLayout 未指定 → front・背景なし（Assets.load を呼ばない）', () => {
    const load = vi.spyOn(Assets, 'load')
    const i = loaded({})
    expect(i.battleLayout).toBe('front')
    expect(i.battleBackground).toBeUndefined()
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
    expect(i.battleLayout).toBe('front')
    expect(i.battleBackground).toBeUndefined()
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
    expect(i.spriteStyle).toBe('acrylic')
    i.startBattle([enemy()])
    expect(i.battleScreen!.opts.spriteStyle).toBe('acrylic')
  })

  it("spriteStyle 未指定 → 'none' で opts にも 'none' が渡る", () => {
    const { i } = loaded({ battleLayout: 'side' })
    expect(i.spriteStyle).toBe('none')
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
    expect(i.spriteStyle).toBe('acrylic')
    r.load(project({}))
    expect(i.spriteStyle).toBe('none')
    i.startBattle([enemy()])
    expect(i.battleScreen!.opts.spriteStyle).toBe('none')
  })
})
