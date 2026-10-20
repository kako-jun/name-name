/**
 * TopDownRenderer のエンカウント → 戦闘画面 → フィールド復帰の配線 (#784) の単体テスト。
 *
 * Application の init（WebGL）は不要なので、コンストラクタ直後のインスタンスに最小限の internals
 * （`app.stage` など）を差し込み、`load()` / `startBattle()` / キー入力ハンドラを駆動する。
 * BattleScreen は本物を使い、渡された opts は internals 経由で観測する。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Container } from 'pixi.js'
import { TopDownRenderer } from './TopDownRenderer'
import type { BattleEntity } from './spellDsl'
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

interface Internals {
  app: { stage: Container }
  initialized: boolean
  screenWidth: number
  screenHeight: number
  playerGridX: number
  playerGridY: number
  encounterCooldown: number
  battleScreen: {
    opts: Record<string, unknown>
    engine: { getStatusRules(): Record<string, unknown> }
  } | null
  startBattle(enemies: BattleEntity[]): void
  maybeRollEncounter(): boolean
  handleKeyDown(e: KeyboardEvent): void
  handleKeyUp(e: KeyboardEvent): void
  handleBlur(): void
  setInputSuspended(v: boolean): void
  inputGate: { heldKeys(): string[] }
  isMoving: boolean
}

const key = (type: 'keydown' | 'keyup', k: string, repeat = false) =>
  new KeyboardEvent(type, { key: k, repeat, bubbles: true, cancelable: true })

function project(over: Partial<RPGProject> = {}): RPGProject {
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
    view: 'topdown',
    ...over,
  }
}

function field(over: Partial<RPGProject> = {}): Internals {
  const r = new TopDownRenderer()
  const i = r as unknown as Internals
  i.app = { stage: new Container() }
  i.screenWidth = 800
  i.screenHeight = 600
  r.load(project(over))
  i.initialized = true
  return i
}

const pos = (i: Internals) => [i.playerGridX, i.playerGridY]

afterEach(() => {
  vi.restoreAllMocks()
})

describe('TopDownRenderer: エンカウントで戦闘画面に入り、終了でフィールドに戻る (#784)', () => {
  it('startBattle が frontmatter 由来の設定を BattleScreen に流す', () => {
    const i = field({ battleLayout: 'side', windowStyle: 'ff-blue', battleCommandLayout: 'cross' })
    i.startBattle([enemy()])
    expect(i.battleScreen!.opts.layout).toBe('side')
    expect(i.battleScreen!.opts.windowStyle).toBe('ff-blue')
    expect(i.battleScreen!.opts.commandLayout).toBe('cross')
    expect(i.app.stage.children).toContain(i.battleScreen)
  })

  it('[状態] の宣言 (#870) が戦闘エンジンに渡る。宣言の無いプロジェクトは空', () => {
    const i = field({ statuses: { poison: { id: 'poison', name: 'どく', tickDamage: '1/16' } } })
    i.startBattle([enemy()])
    expect(Object.keys(i.battleScreen!.engine.getStatusRules())).toEqual(['poison'])
    const plain = field()
    plain.startBattle([enemy()])
    expect(plain.battleScreen!.engine.getStatusRules()).toEqual({})
  })

  it('エンカウント抽選に当たると戦闘が始まり、クールダウンはまだセットされない', () => {
    const i = field({
      map: {
        width: 9,
        height: 9,
        tileSize: 32,
        tiles: Array.from({ length: 9 }, () => Array(9).fill(0)),
        encounterRate: 1,
        encounterGroups: ['slime'],
      },
      monsters: {
        slime: { id: 'slime', name: 'スライム', hp: 5, atk: 1, def: 0, agi: 1, exp: 1, gold: 1 },
      },
    })
    expect(i.maybeRollEncounter()).toBe(true)
    expect(i.battleScreen).not.toBeNull()
    expect(i.encounterCooldown).toBe(0)
  })

  it('戦闘終了（onClose）で画面が畳まれ、encounterCooldown が 3 になり、戦闘中は再抽選しない', () => {
    const i = field()
    i.startBattle([enemy()])
    const screen = i.battleScreen
    expect(i.maybeRollEncounter()).toBe(false)
    ;(i.battleScreen!.opts.onClose as (o: string) => void)('escaped')
    expect(i.battleScreen).toBeNull()
    expect(i.app.stage.children).not.toContain(screen)
    expect(i.encounterCooldown).toBe(3)
  })
})

describe('TopDownRenderer: 戦闘をまたぐキー入力 (#784)', () => {
  it('対照: 戦闘していなければ矢印キーで 1 マス動く', () => {
    const i = field()
    const before = pos(i)
    i.handleKeyDown(key('keydown', 'ArrowDown'))
    expect(pos(i)).not.toEqual(before)
  })

  it('戦闘中は矢印キーでフィールドのプレイヤーが動かない', () => {
    const i = field()
    i.startBattle([enemy()])
    const before = pos(i)
    for (const k of ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']) {
      i.handleKeyDown(key('keydown', k))
    }
    expect(pos(i)).toEqual(before)
  })

  it('開始時に押されていた矢印キーが initialHeldKeys に渡る（keyup 後は渡らない）', () => {
    const i = field()
    i.handleKeyDown(key('keydown', 'ArrowDown'))
    i.isMoving = false
    i.startBattle([enemy()])
    expect(i.battleScreen!.opts.initialHeldKeys).toEqual(['ArrowDown'])
    ;(i.battleScreen!.opts.onClose as (o: string) => void)('escaped')
    i.handleKeyUp(key('keyup', 'ArrowDown'))
    i.startBattle([enemy()])
    expect(i.battleScreen!.opts.initialHeldKeys).toEqual([])
  })

  it('戦闘終了時に押しっぱなしだった矢印キーは離すまで動かず、離した後の新しい押下では動く', () => {
    const i = field()
    i.handleKeyDown(key('keydown', 'ArrowDown'))
    i.isMoving = false
    i.startBattle([enemy()])
    ;(i.battleScreen!.opts.onClose as (o: string) => void)('escaped')
    const before = pos(i)
    i.handleKeyDown(key('keydown', 'ArrowDown'))
    expect(pos(i)).toEqual(before)
    i.handleKeyUp(key('keyup', 'ArrowDown'))
    i.handleKeyDown(key('keydown', 'ArrowDown'))
    expect(pos(i)).not.toEqual(before)
  })

  it('setInputSuspended(true) の間はフィールドが動かず、戦闘の isInputSuspended も true を返す', () => {
    const i = field()
    i.setInputSuspended(true)
    const before = pos(i)
    i.handleKeyDown(key('keydown', 'ArrowDown'))
    expect(pos(i)).toEqual(before)
    i.startBattle([enemy()])
    expect((i.battleScreen!.opts.isInputSuspended as () => boolean)()).toBe(true)
    i.setInputSuspended(false)
    expect((i.battleScreen!.opts.isInputSuspended as () => boolean)()).toBe(false)
  })

  it('window の blur で押下記録が捨てられる', () => {
    const i = field()
    i.startBattle([enemy()])
    i.handleKeyDown(key('keydown', 'ArrowLeft'))
    expect(i.inputGate.heldKeys()).toEqual(['ArrowLeft'])
    i.handleBlur()
    expect(i.inputGate.heldKeys()).toEqual([])
  })
})
