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
