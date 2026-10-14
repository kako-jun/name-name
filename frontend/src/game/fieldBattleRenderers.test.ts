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
