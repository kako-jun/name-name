/**
 * fieldBattle.ts（フィールド共通の戦闘起動・終了・キー入力状態）の単体テスト (#784)。
 * RaycastRenderer / TopDownRenderer 経由の結合は各 *.battle.test.ts が担当し、ここは共通部品を直接検証する。
 */
import { describe, expect, it, vi } from 'vitest'
import { Container } from 'pixi.js'
import {
  DEFAULT_FIELD_BATTLE_SETTINGS,
  FieldInputGate,
  buildHeroBattleEntity,
  buildPartyBattleEntities,
  openFieldBattle,
  orderedPartyKeys,
  partyDefToBattleEntity,
  readFieldBattleSettings,
  type FieldBattleSettings,
} from './fieldBattle'
import type { PartyMemberDef } from '../types'
import type { RPGProject } from '../types/rpg'
import type { BattleEntity } from './spellDsl'

function member(id: string, over: Partial<PartyMemberDef> = {}): PartyMemberDef {
  return { id, name: id.toUpperCase(), hp: 20, mp: 5, atk: 4, def: 2, agi: 3, ...over }
}

function roster(ids: string[], over: Record<string, Partial<PartyMemberDef>> = {}) {
  return {
    party: Object.fromEntries(ids.map((id) => [id, member(id, over[id])])),
    order: ids,
  }
}

function minimalProject(over: Partial<RPGProject> = {}): RPGProject {
  return {
    name: 't',
    version: '1.0.0',
    map: { width: 1, height: 1, tileSize: 32, tiles: [[0]] },
    player: { x: 0, y: 0, direction: 'down' },
    npcs: [],
    view: 'topdown',
    ...over,
  }
}

const enemy = (over: Partial<BattleEntity> = {}): BattleEntity => ({
  id: 'slime',
  name: 'スライム',
  hp: 1,
  maxHp: 1,
  mp: 0,
  maxMp: 0,
  atk: 1,
  def: 0,
  agi: 1,
  ...over,
})

describe('readFieldBattleSettings', () => {
  it('戦闘設定がすべて未指定なら既定値に倒れる', () => {
    expect(readFieldBattleSettings(minimalProject())).toEqual(DEFAULT_FIELD_BATTLE_SETTINGS)
  })

  it('指定した値は既定値より優先される', () => {
    const s = readFieldBattleSettings(
      minimalProject({
        battleLayout: 'side',
        battleBackground: 'bg/a.webp',
        spriteStyle: 'acrylic',
        windowStyle: 'ff-blue',
        battleBackgroundTone: 'off',
        battleBackgroundDof: 'on',
        battleLogTypewriter: 'on',
        battleForeground: 'fg/a.webp',
        battleAtb: { mode: 'active' },
        battleCommandLayout: 'cross',
      })
    )
    expect(s).toMatchObject({
      layout: 'side',
      background: 'bg/a.webp',
      spriteStyle: 'acrylic',
      windowStyle: 'ff-blue',
      backgroundTone: 'off',
      backgroundDof: 'on',
      logTypewriter: 'on',
      foreground: 'fg/a.webp',
      atb: { mode: 'active' },
      commandLayout: 'cross',
    })
  })

  it('pixelArt は true のときだけ true（false / 未指定は false）', () => {
    expect(readFieldBattleSettings(minimalProject({ pixelArt: true })).pixelArt).toBe(true)
    expect(readFieldBattleSettings(minimalProject({ pixelArt: false })).pixelArt).toBe(false)
    expect(readFieldBattleSettings(minimalProject()).pixelArt).toBe(false)
  })

  it('ATB 未指定は undefined（従来ターン制）', () => {
    expect(readFieldBattleSettings(minimalProject()).atb).toBeUndefined()
  })

  it('返す設定は既定値オブジェクトと別物（呼び出し側の書き換えが既定値を汚さない）', () => {
    const s = readFieldBattleSettings(minimalProject())
    s.layout = 'side'
    expect(DEFAULT_FIELD_BATTLE_SETTINGS.layout).toBe('front')
  })
})

describe('buildPartyBattleEntities: パーティ人数の境界（0 / 1 / 4 / 5）', () => {
  it('0 人 → ハードコード hero 1 人', () => {
    const p = buildPartyBattleEntities({ party: {}, order: [] }, 'side')
    expect(p.map((e) => e.id)).toEqual(['hero'])
    expect(p[0].name).toBe('ゆうしゃ')
  })

  it('1 人（hero 以外）→ その 1 人だけ', () => {
    expect(buildPartyBattleEntities(roster(['mage']), 'side').map((e) => e.id)).toEqual(['mage'])
  })

  it('4 人 → 4 人すべて', () => {
    expect(buildPartyBattleEntities(roster(['a', 'b', 'c', 'd']), 'side')).toHaveLength(4)
  })

  it('5 人 → 切り捨てず 5 人すべて', () => {
    expect(buildPartyBattleEntities(roster(['a', 'b', 'c', 'd', 'e']), 'side')).toHaveLength(5)
  })

  it('order に無い party キーは Object.keys 順で後ろに足される', () => {
    const r = { party: { a: member('a'), b: member('b') }, order: ['a'] }
    expect(orderedPartyKeys(r)).toEqual(['a', 'b'])
  })

  it('order にあっても party に無いキーは捨てられる', () => {
    const r = { party: { a: member('a') }, order: ['ghost', 'a'] }
    expect(orderedPartyKeys(r)).toEqual(['a'])
  })
})

describe('partyDefToBattleEntity: 隊列は side のときだけ反映', () => {
  it.each([
    ['side', 'back', 'back'],
    ['side', 'front', undefined],
    ['front', 'back', undefined],
  ] as const)('layout=%s・row=%s → row=%s', (layout, row, expected) => {
    expect(partyDefToBattleEntity(member('x', { row }), layout).row).toBe(expected)
  })

  it('hero 未定義の buildHeroBattleEntity はハードコード値（HP20 / MP4）', () => {
    const e = buildHeroBattleEntity({ party: {}, order: [] }, 'front')
    expect([e.hp, e.maxHp, e.mp, e.maxMp]).toEqual([20, 20, 4, 4])
  })
})

describe('FieldInputGate', () => {
  it('矢印キーだけを押下中として覚える（それ以外のキーは覚えない）', () => {
    const g = new FieldInputGate()
    g.trackKeyDown('ArrowUp')
    g.trackKeyDown('a')
    g.trackKeyDown('Enter')
    expect(g.heldKeys()).toEqual(['ArrowUp'])
  })

  it('同じキーの keydown が重なっても 1 件（repeat で増えない）', () => {
    const g = new FieldInputGate()
    g.trackKeyDown('ArrowUp')
    g.trackKeyDown('ArrowUp')
    expect(g.heldKeys()).toEqual(['ArrowUp'])
  })

  it('trackKeyUp は押下記録と離すまで無視の両方から外す', () => {
    const g = new FieldInputGate()
    g.trackKeyDown('ArrowUp')
    g.armReleaseGate()
    expect(g.isReleaseGated('ArrowUp')).toBe(true)
    g.trackKeyUp('ArrowUp')
    expect(g.heldKeys()).toEqual([])
    expect(g.isReleaseGated('ArrowUp')).toBe(false)
  })

  it('armReleaseGate は押下中だったキーだけを対象にする', () => {
    const g = new FieldInputGate()
    g.trackKeyDown('ArrowUp')
    g.armReleaseGate()
    expect(g.isReleaseGated('ArrowUp')).toBe(true)
    expect(g.isReleaseGated('ArrowDown')).toBe(false)
  })

  it('armReleaseGate は直前の gate を作り直す（前回の分が残らない）', () => {
    const g = new FieldInputGate()
    g.trackKeyDown('ArrowUp')
    g.armReleaseGate()
    g.trackKeyUp('ArrowUp')
    g.trackKeyDown('ArrowDown')
    g.armReleaseGate()
    expect(g.isReleaseGated('ArrowUp')).toBe(false)
    expect(g.isReleaseGated('ArrowDown')).toBe(true)
  })

  it('押下なしで armReleaseGate しても何も gate されない', () => {
    const g = new FieldInputGate()
    g.armReleaseGate()
    expect(g.isReleaseGated('ArrowUp')).toBe(false)
  })

  it('blur は押下記録と gate の両方を捨てる', () => {
    const g = new FieldInputGate()
    g.trackKeyDown('ArrowLeft')
    g.armReleaseGate()
    g.blur()
    expect(g.heldKeys()).toEqual([])
    expect(g.isReleaseGated('ArrowLeft')).toBe(false)
  })

  it('resetHeld は押下記録だけ捨て、gate は持ち越す', () => {
    const g = new FieldInputGate()
    g.trackKeyDown('ArrowLeft')
    g.armReleaseGate()
    g.resetHeld()
    expect(g.heldKeys()).toEqual([])
    expect(g.isReleaseGated('ArrowLeft')).toBe(true)
  })

  it('suspended の既定は false、set で切り替わる', () => {
    const g = new FieldInputGate()
    expect(g.isSuspended).toBe(false)
    g.setSuspended(true)
    expect(g.isSuspended).toBe(true)
    g.setSuspended(false)
    expect(g.isSuspended).toBe(false)
  })

  it('suspended 中でも押下の追跡は続く', () => {
    const g = new FieldInputGate()
    g.setSuspended(true)
    g.trackKeyDown('ArrowRight')
    expect(g.heldKeys()).toEqual(['ArrowRight'])
  })
})

describe('openFieldBattle', () => {
  const settings = (over: Partial<FieldBattleSettings> = {}): FieldBattleSettings => ({
    ...DEFAULT_FIELD_BATTLE_SETTINGS,
    ...over,
  })

  function open(
    over: {
      settings?: Partial<FieldBattleSettings>
      ids?: string[]
      gate?: FieldInputGate
      enemies?: BattleEntity[]
    } = {}
  ) {
    const stage = new Container()
    const onClosed = vi.fn()
    const gate = over.gate ?? new FieldInputGate()
    const screen = openFieldBattle({
      stage,
      width: 800,
      height: 600,
      settings: settings(over.settings),
      roster: roster(over.ids ?? ['hero', 'mage', 'priest']),
      enemies: over.enemies ?? [enemy()],
      gate,
      onClosed,
    })
    const s = screen as unknown as {
      engine: { getState(): { party: { id: string }[]; atb?: unknown } }
      opts: Record<string, unknown>
      handleCommand(id: string): void
    }
    return { stage, onClosed, gate, screen, s }
  }

  it('ステージに戦闘画面が載る', () => {
    const { stage, screen } = open()
    expect(stage.children).toContain(screen)
  })

  it('front は先頭 1 人だけをエンジンに渡す', () => {
    const { s } = open({ settings: { layout: 'front' } })
    expect(s.engine.getState().party.map((p) => p.id)).toEqual(['hero'])
  })

  it('side は全員をエンジンに渡す', () => {
    const { s } = open({ settings: { layout: 'side' } })
    expect(s.engine.getState().party.map((p) => p.id)).toEqual(['hero', 'mage', 'priest'])
  })

  it('ATB 設定ありのときだけエンジンが ATB になる', () => {
    expect(open().s.engine.getState().atb).toBeUndefined()
    expect(open({ settings: { atb: { mode: 'wait' } } }).s.engine.getState().atb).toBeDefined()
  })

  it('開始時に押されていた矢印キーが initialHeldKeys に渡る', () => {
    const gate = new FieldInputGate()
    gate.trackKeyDown('ArrowUp')
    expect(open({ gate }).s.opts.initialHeldKeys).toEqual(['ArrowUp'])
  })

  it('isInputSuspended は gate の現在値を返す（開いた後の切り替えにも追従）', () => {
    const { gate, s } = open()
    const f = s.opts.isInputSuspended as () => boolean
    expect(f()).toBe(false)
    gate.setSuspended(true)
    expect(f()).toBe(true)
  })

  it('終了で画面が畳まれ、onClosed が 1 回呼ばれ、押下中だったキーが gate される', () => {
    const gate = new FieldInputGate()
    gate.trackKeyDown('ArrowDown')
    const { stage, screen, onClosed, s } = open({ gate })
    s.handleCommand('attack') // hp1 の敵を 1 撃で倒して勝利
    expect(stage.children).not.toContain(screen)
    expect(onClosed).toHaveBeenCalledTimes(1)
    expect(gate.isReleaseGated('ArrowDown')).toBe(true)
  })

  it('終了後にコマンドを再入力しても onClosed は 2 回目を呼ばない（二重終了なし）', () => {
    const { onClosed, s } = open()
    s.handleCommand('attack')
    s.handleCommand('attack')
    expect(onClosed).toHaveBeenCalledTimes(1)
  })

  it('押下なしで終了したときは gate が空', () => {
    const { gate, s } = open()
    s.handleCommand('attack')
    expect(gate.isReleaseGated('ArrowDown')).toBe(false)
  })
})
