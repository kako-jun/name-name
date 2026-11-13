/**
 * fieldBattle.ts（フィールド共通の戦闘起動・終了・キー入力状態）の単体テスト (#784)。
 * RaycastRenderer / TopDownRenderer 経由の結合は各 *.battle.test.ts が担当し、ここは共通部品を直接検証する。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Container } from 'pixi.js'
import {
  DEFAULT_FIELD_BATTLE_SETTINGS,
  FieldInputGate,
  buildBattleMenuData,
  buildHeroBattleEntity,
  buildFieldScriptedBattle,
  buildPartyBattleEntities,
  buildScriptedBattle,
  buildScriptedEnemies,
  planBattleFlagUpdates,
  planEventBattle,
  closeFieldBattle,
  openFieldBattle,
  orderedPartyKeys,
  partyDefToBattleEntity,
  readFieldBattleSettings,
  type FieldBattleSettings,
} from './fieldBattle'
import type { BattleScriptDef, MonsterDef, PartyMemberDef } from '../types'
import type { RPGProject } from '../types/rpg'
import type { BattleEntity } from './spellDsl'
import type { BattleEffects } from './battleEffects'
import { RESULT_HOLD_DQ_MS } from './battleResult'
import { DIALOG_JUST_SHOWN_GUARD_MS, attachTouchInput } from './touchInput'

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
        battlePresentation: 'ff',
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
      presentation: 'ff',
    })
  })

  it('pixelArt は true のときだけ true（false / 未指定は false）', () => {
    expect(readFieldBattleSettings(minimalProject({ pixelArt: true })).pixelArt).toBe(true)
    expect(readFieldBattleSettings(minimalProject({ pixelArt: false })).pixelArt).toBe(false)
    expect(readFieldBattleSettings(minimalProject()).pixelArt).toBe(false)
  })

  it('敵グリッド・窓との重なり許容量 (#839) は RPGProject の値がそのまま入り、未指定は undefined', () => {
    const s = readFieldBattleSettings(
      minimalProject({ battleEnemyGrid: { cols: 6, rows: 2 }, battleEnemyWindowOverlap: 0.3 })
    )
    expect(s.enemyGrid).toEqual({ cols: 6, rows: 2 })
    expect(s.enemyWindowOverlap).toBe(0.3)
    const d = readFieldBattleSettings(minimalProject())
    expect(d.enemyGrid).toBeUndefined()
    expect(d.enemyWindowOverlap).toBeUndefined()
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

  it('poses は正規化して写す（未知キー・空値は捨て、無ければ poses なし） (#745)', () => {
    const e = partyDefToBattleEntity(
      member('mage', { poses: { Idle: 'p/i.webp', cast: 'p/c.webp', bogus: 'x', hurt: ' ' } }),
      'side'
    )
    expect(e.poses).toEqual({ idle: 'p/i.webp', cast: 'p/c.webp' })
    expect('poses' in partyDefToBattleEntity(member('x'), 'side')).toBe(false)
    expect('poses' in partyDefToBattleEntity(member('y', { poses: { bogus: 'x' } }), 'side')).toBe(
      false
    )
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
      assetBaseUrl?: string
      effects?: BattleEffects
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
      assetBaseUrl: over.assetBaseUrl,
      ...(over.effects ? { effects: over.effects } : {}),
      onClosed,
    })
    const s = screen as unknown as {
      engine: { getState(): { party: { id: string }[]; atb?: unknown } }
      opts: Record<string, unknown>
      handleCommand(id: string): void
      tick(ms: number): void
    }
    return { stage, onClosed, gate, screen, s }
  }

  it('assetBaseUrl は BattleScreen の opts にそのまま転送される（未指定は undefined）', () => {
    expect(open({ assetBaseUrl: 'https://x.example/raw' }).s.opts.assetBaseUrl).toBe(
      'https://x.example/raw'
    )
    expect(open().s.opts.assetBaseUrl).toBeUndefined()
  })

  it('effects は BattleScreen の opts にそのまま転送される（未指定は載らない） (#941)', () => {
    const effects: BattleEffects = {
      impact: { image: 'a.png', frames: 2, columns: 2, frameMs: 100, anchor: 'center', scale: 1 },
    }
    expect(open({ effects, settings: { layout: 'side', presentation: 'ff' } }).s.opts.effects).toBe(
      effects
    )
    expect('effects' in open().s.opts).toBe(false)
  })

  describe('敵の最前列 (#896)', () => {
    const at = (col: number) => ({ layout: { w: 1, h: 1, scale: 1, at: { col, row: 0 } } })
    /** 勇者（atk 4・rng 0）が奥の敵 b を通常攻撃して減った HP。手前の敵 a は右端の列 */
    const hitBack = (over: Partial<FieldBattleSettings>, layout: 'side' | 'front' = 'side') => {
      vi.spyOn(Math, 'random').mockReturnValue(0)
      const a = enemy({ id: 'a', hp: 99, maxHp: 99, ...at(1) })
      const b = enemy({ id: 'b', hp: 99, maxHp: 99, ...at(0) })
      const { s } = open({
        ids: ['hero'],
        enemies: [a, b],
        settings: { layout, enemyGrid: { cols: 2, rows: 1 }, ...over },
      })
      ;(s.engine as unknown as { selectAttack(id: string): void }).selectAttack('b')
      return 99 - b.hp
    }

    it('side + グリッドあり: 設定なしで、最前列でない敵への通常攻撃は半分', () => {
      expect(hitBack({})).toBe(2)
    })

    it('front レイアウトでは効かない（敵の列を描かない）', () => {
      expect(hitBack({}, 'front')).toBe(4)
    })

    it('グリッドが無ければ効かない', () => {
      expect(hitBack({ enemyGrid: undefined })).toBe(4)
    })
  })

  it('enemyList は BattleScreen の opts に転送される（既定は off） (#954)', () => {
    expect(
      open({ settings: { presentation: 'ff', layout: 'side', enemyList: 'window' } }).s.opts
        .enemyList
    ).toBe('window')
    expect(open().s.opts.enemyList).toBe('off')
  })

  it('motion は BattleScreen の opts に転送される（既定は default） (#956)', () => {
    expect(
      open({ settings: { presentation: 'ff', layout: 'side', motion: 'snappy' } }).s.opts.motion
    ).toBe('snappy')
    expect(open().s.opts.motion).toBe('default')
  })

  it('presentation は BattleScreen の opts に転送される（既定は dq） (#745)', () => {
    expect(open({ settings: { presentation: 'ff', layout: 'side' } }).s.opts.presentation).toBe(
      'ff'
    )
    expect(open().s.opts.presentation).toBe('dq')
  })

  it('enemyGrid / enemyWindowOverlap は BattleScreen の opts に転送される（未指定は載らない） (#839)', () => {
    const { s } = open({
      settings: { layout: 'side', enemyGrid: { cols: 6, rows: 2 }, enemyWindowOverlap: 0.3 },
    })
    expect(s.opts.enemyGrid).toEqual({ cols: 6, rows: 2 })
    expect(s.opts.enemyWindowOverlap).toBe(0.3)
    const d = open().s
    expect('enemyGrid' in d.opts).toBe(false)
    expect('enemyWindowOverlap' in d.opts).toBe(false)
  })

  it('commands / commandLabels は BattleScreen の opts に転送される (#873)', () => {
    const { s } = open({
      settings: {
        layout: 'side',
        commands: ['skill', 'spell', 'item', 'escape'],
        commandLabels: { skill: '刀' },
      },
    })
    expect(s.opts.commands).toEqual(['skill', 'spell', 'item', 'escape'])
    expect(s.opts.commandLabels).toEqual({ skill: '刀' })
    const d = open().s
    expect(d.opts.commands).toBeUndefined()
  })

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
    expect(stage.children).toContain(screen) // 勝利を読ませる待機中は畳まない (#745)
    s.tick(RESULT_HOLD_DQ_MS)
    expect(stage.children).not.toContain(screen)
    expect(onClosed).toHaveBeenCalledTimes(1)
    expect(gate.isReleaseGated('ArrowDown')).toBe(true)
  })

  it('終了後にコマンドを再入力しても onClosed は 2 回目を呼ばない（二重終了なし）', () => {
    const { onClosed, s } = open()
    s.handleCommand('attack')
    s.tick(RESULT_HOLD_DQ_MS)
    s.handleCommand('attack')
    s.tick(RESULT_HOLD_DQ_MS)
    expect(onClosed).toHaveBeenCalledTimes(1)
  })

  it('押下なしで終了したときは gate が空', () => {
    const { gate, s } = open()
    s.handleCommand('attack')
    expect(gate.isReleaseGated('ArrowDown')).toBe(false)
  })
})

describe('readFieldBattleSettings: 旧実装（Raycast の個別フィールド）との等価性 (#784)', () => {
  it('未指定の既定値は旧実装のリテラルと一致する', () => {
    expect(readFieldBattleSettings(minimalProject())).toEqual({
      layout: 'front',
      background: undefined,
      spriteStyle: 'none',
      windowStyle: 'dark',
      backgroundTone: 'on',
      backgroundDof: 'off',
      logTypewriter: 'off',
      presentation: 'dq',
      motion: 'default',
      enemyList: 'off',
      depth: null,
      foreground: undefined,
      pixelArt: false,
      atb: undefined,
      commandLayout: 'grid',
      commandLabels: undefined,
      transition: 'none',
    })
  })

  it('全項目を指定したときは RPGProject の各値がそのまま対応する項目に入る', () => {
    const p = minimalProject({
      battleLayout: 'side',
      battleBackground: 'bg/a.webp',
      spriteStyle: 'acrylic',
      windowStyle: 'ff-blue',
      battleBackgroundTone: 'off',
      battleBackgroundDof: 'on',
      battleLogTypewriter: 'on',
      battleDepth: { horizon: 0.3, perspective: 0.8 },
      battleForeground: 'fg/a.png',
      pixelArt: true,
      battleAtb: { mode: 'active' },
      battleCommandLayout: 'cross',
      battleCommandLabels: { attack: '斬る' },
      battlePresentation: 'ff',
      battleMotion: 'snappy',
      battleEnemyList: 'window',
      battleTransition: 'ff',
    })
    expect(readFieldBattleSettings(p)).toEqual({
      layout: 'side',
      background: 'bg/a.webp',
      spriteStyle: 'acrylic',
      windowStyle: 'ff-blue',
      backgroundTone: 'off',
      backgroundDof: 'on',
      logTypewriter: 'on',
      presentation: 'ff',
      motion: 'snappy',
      enemyList: 'window',
      depth: { horizon: 0.3, perspective: 0.8 },
      foreground: 'fg/a.png',
      pixelArt: true,
      atb: { mode: 'active' },
      commandLayout: 'cross',
      commandLabels: { attack: '斬る' },
      transition: 'ff',
    })
  })
})

describe('openFieldBattle: 終了・強制終了・タップ抑止 (#784)', () => {
  function open() {
    const stage = new Container()
    const onClosed = vi.fn()
    const gate = new FieldInputGate()
    const screen = openFieldBattle({
      stage,
      width: 800,
      height: 600,
      settings: { ...DEFAULT_FIELD_BATTLE_SETTINGS },
      roster: roster(['hero']),
      enemies: [enemy()],
      gate,
      onClosed,
    })
    const s = screen as unknown as {
      opts: { onClose(o: string): void }
      handleCommand(id: string): void
      tick(ms: number): void
    }
    return { stage, screen, onClosed, s }
  }

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('onClosed に戦闘の結果が渡る', () => {
    const { s, onClosed } = open()
    s.handleCommand('attack')
    s.tick(RESULT_HOLD_DQ_MS)
    expect(onClosed).toHaveBeenCalledWith(
      'victory',
      expect.objectContaining({ outcome: 'victory', exp: 0, gold: 0, loot: [], items: [] })
    )
  })

  it('closeFieldBattle は画面を外して破棄し、onClosed は呼ばず、多重呼び出しも無害', () => {
    const { stage, screen, onClosed } = open()
    closeFieldBattle(stage, screen)
    expect(stage.children).not.toContain(screen)
    expect(screen.destroyed).toBe(true)
    expect(() => closeFieldBattle(stage, screen)).not.toThrow()
    expect(onClosed).not.toHaveBeenCalled()
  })

  it('強制終了した画面の古い onClose は後始末（onClosed・gate）を走らせない', () => {
    const { stage, screen, onClosed, s } = open()
    closeFieldBattle(stage, screen)
    s.opts.onClose('victory')
    expect(onClosed).not.toHaveBeenCalled()
  })

  it('戦闘を終わらせたタップの直後（pointerup）は canvas の tap にならず、ガード時間が過ぎれば tap になる', () => {
    let now = 10_000
    vi.spyOn(performance, 'now').mockImplementation(() => now)
    const el = document.createElement('div')
    const onTap = vi.fn()
    const detach = attachTouchInput(el, { onTap })
    const ev = (type: string) =>
      Object.assign(new Event(type), { isPrimary: true, clientX: 5, clientY: 5 })

    const { s } = open()
    el.dispatchEvent(ev('pointerdown'))
    s.opts.onClose('escaped') // pointertap が先に走って画面が畳まれる
    el.dispatchEvent(ev('pointerup'))
    expect(onTap).not.toHaveBeenCalled()

    now += DIALOG_JUST_SHOWN_GUARD_MS + 1
    el.dispatchEvent(ev('pointerdown'))
    el.dispatchEvent(ev('pointerup'))
    expect(onTap).toHaveBeenCalledTimes(1)
    detach()
  })
})

describe('buildBattleMenuData: 候補窓の呪文 (#204)', () => {
  const spells = {
    fire: { id: 'fire', name: 'ほのお', mp: 3, target: '敵単体', effect: 'damage 8..14' },
    heal: { id: 'heal', name: 'ヒール', mp: 2, target: '味方単体', builtin: 'x' },
    big: { id: 'big', name: 'だいまほう', mp: 9, target: '敵全体' },
  }
  const learns = [
    { level: 1, spell: 'fire' },
    { level: 3, spell: 'heal' },
    { level: 1, spell: 'unknown' },
    { level: 5, spell: 'big' },
    { level: 1, spell: 'fire' },
  ]

  it('レベル以下で覚える・マスターにある呪文だけを、定義順・重複なしで味方ごとに作る', () => {
    const r = {
      ...roster(['a', 'b'], { a: { level: 3, learns }, b: { level: 1, learns } }),
      spells,
    }
    const party = buildPartyBattleEntities(r, 'side')
    const m = buildBattleMenuData(r, party)!
    expect(m.spells!.a.map((e) => e.id)).toEqual(['fire', 'heal'])
    expect(m.spells!.b.map((e) => e.id)).toEqual(['fire'])
    expect(m.spells!.a[0]).toEqual({
      id: 'fire',
      name: 'ほのお',
      mp: 3,
      target: '敵単体',
      effect: 'damage 8..14',
    })
    expect(m.spells!.a[1].builtin).toBe('x')
  })

  it('レベル未指定は 1 として扱う', () => {
    const r = { ...roster(['a'], { a: { learns } }), spells }
    expect(buildBattleMenuData(r, buildPartyBattleEntities(r, 'side'))!.spells!.a).toHaveLength(1)
  })

  it('呪文マスターがない・覚える呪文がない・Object.prototype のキーは undefined（従来どおり）', () => {
    const r = roster(['a'], { a: { learns } })
    expect(buildBattleMenuData(r, buildPartyBattleEntities(r, 'side'))).toBeUndefined()
    const none = { ...roster(['a']), spells }
    expect(buildBattleMenuData(none, buildPartyBattleEntities(none, 'side'))).toBeUndefined()
    const proto = {
      ...roster(['a'], { a: { learns: [{ level: 1, spell: 'toString' }] } }),
      spells,
    }
    expect(buildBattleMenuData(proto, buildPartyBattleEntities(proto, 'side'))).toBeUndefined()
  })
})

describe('openFieldBattle: 候補窓の呪文を BattleScreen へ渡す (#204)', () => {
  function open(commandLayout: 'grid' | 'cross', withSpells: boolean) {
    const stage = new Container()
    const r = roster(['hero'], { hero: { learns: [{ level: 1, spell: 'fire' }] } })
    const screen = openFieldBattle({
      stage,
      width: 800,
      height: 450,
      settings: { ...DEFAULT_FIELD_BATTLE_SETTINGS, layout: 'side', commandLayout },
      roster: withSpells
        ? {
            ...r,
            spells: {
              fire: { id: 'fire', name: 'ほのお', mp: 3, target: '敵単体', effect: 'damage 1..1' },
            },
          }
        : r,
      enemies: [enemy()],
      gate: new FieldInputGate(),
      onClosed: vi.fn(),
    })
    return {
      stage,
      screen,
      s: screen as unknown as { menuStack: unknown[]; handleCommand(id: string): void },
    }
  }

  it('cross + 呪文マスターありで「じゅもん」が候補窓を開く', () => {
    const { stage, screen, s } = open('cross', true)
    s.handleCommand('spell')
    expect(s.menuStack).toHaveLength(1)
    closeFieldBattle(stage, screen)
  })

  it('わざだけ（呪文・アイテムなし）でも cross なら「わざ」が候補窓を開く (#873)', () => {
    const stage = new Container()
    const r = {
      ...roster(['hero'], { hero: { abilities: ['slash'] } }),
      skills: { slash: { id: 'slash', name: 'きる', target: '相手単体', effect: 'damage 5..9' } },
    }
    const screen = openFieldBattle({
      stage,
      width: 800,
      height: 450,
      settings: {
        ...DEFAULT_FIELD_BATTLE_SETTINGS,
        layout: 'side',
        commandLayout: 'cross',
        commands: ['skill', 'attack', 'item', 'escape'],
      },
      roster: r,
      enemies: [enemy()],
      gate: new FieldInputGate(),
      onClosed: vi.fn(),
    })
    const s = screen as unknown as { menuStack: unknown[]; handleCommand(id: string): void }
    s.handleCommand('skill')
    expect(s.menuStack).toHaveLength(1)
    closeFieldBattle(stage, screen)
  })

  it('cross でも呪文マスターが無ければ従来どおり何も起きない', () => {
    const { stage, screen, s } = open('cross', false)
    s.handleCommand('spell')
    expect(s.menuStack).toHaveLength(0)
    closeFieldBattle(stage, screen)
  })

  it('grid でも呪文マスターがあれば候補窓が開く (#806)', () => {
    const { stage, screen, s } = open('grid', true)
    s.handleCommand('spell')
    expect(s.menuStack).toHaveLength(1)
    closeFieldBattle(stage, screen)
  })
})

describe('buildBattleMenuData: 候補窓のわざ (#873)', () => {
  const skills = {
    slash: { id: 'slash', name: 'きる', target: '相手単体', effect: 'damage 5..9' },
    sweep: {
      id: 'sweep',
      name: 'なぎはらい',
      target: '相手全体',
      builtin: 'x',
      message: '{user}は薙いだ',
    },
  }

  it('わざ: の特技 id のうち特技マスターにあるものを、書いた順・重複なしで味方ごとに作る', () => {
    const r = {
      ...roster(['a', 'b'], {
        a: { abilities: ['sweep', 'nope', 'slash', 'sweep'] },
        b: { abilities: ['slash'] },
      }),
      skills,
    }
    const m = buildBattleMenuData(r, buildPartyBattleEntities(r, 'side'))!
    expect(m.skills!.a.map((e) => e.id)).toEqual(['sweep', 'slash'])
    expect(m.skills!.b.map((e) => e.id)).toEqual(['slash'])
    expect(m.skills!.a[0]).toEqual({
      id: 'sweep',
      name: 'なぎはらい',
      target: '相手全体',
      builtin: 'x',
      message: '{user}は薙いだ',
    })
    expect(m.spells).toBeUndefined() // 呪文が無ければ spells は出さない
  })

  it('呪文とわざは同じ味方に共存できる', () => {
    const r = {
      ...roster(['a'], { a: { abilities: ['slash'], learns: [{ level: 1, spell: 'fire' }] } }),
      skills,
      spells: { fire: { id: 'fire', name: 'ほのお', mp: 3, target: '敵単体' } },
    }
    const m = buildBattleMenuData(r, buildPartyBattleEntities(r, 'side'))!
    expect(m.skills!.a).toHaveLength(1)
    expect(m.spells!.a).toHaveLength(1)
  })

  it('特技マスターが無い・わざが無い・Object.prototype のキーは undefined（従来どおり）', () => {
    const noMaster = roster(['a'], { a: { abilities: ['slash'] } })
    expect(
      buildBattleMenuData(noMaster, buildPartyBattleEntities(noMaster, 'side'))
    ).toBeUndefined()
    const none = { ...roster(['a']), skills }
    expect(buildBattleMenuData(none, buildPartyBattleEntities(none, 'side'))).toBeUndefined()
    const proto = { ...roster(['a'], { a: { abilities: ['toString'] } }), skills }
    expect(buildBattleMenuData(proto, buildPartyBattleEntities(proto, 'side'))).toBeUndefined()
  })
})

describe('readFieldBattleSettings: battleCommands (#873)', () => {
  it('未指定は undefined（既定の 4 コマンド）、指定は透過する', () => {
    expect(readFieldBattleSettings(minimalProject()).commands).toBeUndefined()
    expect(
      readFieldBattleSettings(minimalProject({ battleCommands: ['skill', 'escape'] })).commands
    ).toEqual(['skill', 'escape'])
    expect(DEFAULT_FIELD_BATTLE_SETTINGS.commands).toBeUndefined()
  })
})

describe('一枚絵フィールドの脚本制御の戦闘 (#1073)', () => {
  const mon = (id: string): MonsterDef => ({
    id,
    name: id.toUpperCase(),
    hp: 10,
    atk: 2,
    def: 1,
    agi: 1,
    exp: 1,
    gold: 1,
  })
  const monsters: Record<string, MonsterDef> = { slime: mon('slime'), bat: mon('bat') }
  const ally = (id: string, hp = 20): BattleEntity => enemy({ id, name: id, hp, maxHp: 20 })
  const def = (over: Partial<BattleScriptDef> = {}): BattleScriptDef => ({
    id: 'b1',
    enemies: 'slime',
    rules: [],
    ...over,
  })
  const party = [ally('a'), ally('b'), ally('c')]
  const rng = () => 0
  const warnSpy = () => vi.spyOn(console, 'warn').mockImplementation(() => {})
  afterEach(() => vi.restoreAllMocks())

  describe('buildScriptedEnemies', () => {
    it('正常系は敵を返し警告 0 件', () => {
      const w = warnSpy()
      expect(
        buildScriptedEnemies(def({ enemies: 'slime+bat' }), monsters, rng)?.map((e) => e.id)
      ).toEqual(['slime', 'bat'])
      expect(w).not.toHaveBeenCalled()
    })
    it.each([undefined, '', '   '])('敵: が %j なら null と警告 1 件', (enemies) => {
      const w = warnSpy()
      expect(buildScriptedEnemies(def({ enemies }), monsters, rng)).toBeNull()
      expect(w).toHaveBeenCalledTimes(1)
    })
    it('未知モンスターだけなら null と警告（未知 1 + 組めない 1）', () => {
      const w = warnSpy()
      expect(buildScriptedEnemies(def({ enemies: 'ghost' }), monsters, rng)).toBeNull()
      expect(w).toHaveBeenCalledTimes(2)
    })
    it('一部が未知なら組めた敵だけ返し、未知ごとに警告 1 回', () => {
      const w = warnSpy()
      const r = buildScriptedEnemies(def({ enemies: 'slime+ghost1+ghost2' }), monsters, rng)
      expect(r?.map((e) => e.id)).toEqual(['slime'])
      expect(w).toHaveBeenCalledTimes(2)
    })
    it('固定 rng で個数ランダムの体数が決定的', () => {
      const d = def({ enemies: 'slime*1..3' })
      expect(buildScriptedEnemies(d, monsters, () => 0)).toHaveLength(1)
      expect(buildScriptedEnemies(d, monsters, () => 0.99)).toHaveLength(3)
      expect(buildScriptedEnemies(d, monsters, () => 0.5)).toHaveLength(2)
    })
    it('buildScriptedBattle は共有後も同じ敵・同じ警告を出す', () => {
      const w = warnSpy()
      const d = def({ enemies: 'slime+ghost' })
      const direct = buildScriptedEnemies(d, monsters, rng)
      const nWarnDirect = w.mock.calls.length
      w.mockClear()
      const viaBattle = buildScriptedBattle(d, monsters, roster(['a']), 'side', rng)
      expect(viaBattle?.enemies).toEqual(direct)
      expect(w).toHaveBeenCalledTimes(nWarnDirect)
    })
  })

  describe('buildFieldScriptedBattle', () => {
    it('味方: 未指定は全員が初期編成（side / front とも）・joiners 空・警告 0', () => {
      const w = warnSpy()
      for (const layout of ['side', 'front'] as const) {
        const r = buildFieldScriptedBattle(def(), monsters, party, layout, rng)
        expect(r?.party.map((p) => p.id)).toEqual(['a', 'b', 'c'])
        expect(r?.script.joiners).toEqual({})
      }
      expect(w).not.toHaveBeenCalled()
    })
    it('既知 1 人（side）は残りが joiners', () => {
      const r = buildFieldScriptedBattle(def({ party: ['b'] }), monsters, party, 'side', rng)
      expect(r?.party.map((p) => p.id)).toEqual(['b'])
      expect(Object.keys(r?.script.joiners ?? {})).toEqual(['a', 'c'])
    })
    it('既知 1 人（front）は joiners 空', () => {
      const r = buildFieldScriptedBattle(def({ party: ['b'] }), monsters, party, 'front', rng)
      expect(r?.party.map((p) => p.id)).toEqual(['b'])
      expect(r?.script.joiners).toEqual({})
    })
    it('既知 + 未知: 未知は警告 1 件で飛ばす', () => {
      const w = warnSpy()
      const r = buildFieldScriptedBattle(def({ party: ['a', 'zz'] }), monsters, party, 'side', rng)
      expect(r?.party.map((p) => p.id)).toEqual(['a'])
      expect(w).toHaveBeenCalledTimes(1)
    })
    it('全部未知なら全員にフォールバックし、未知ごとに警告', () => {
      const w = warnSpy()
      const r = buildFieldScriptedBattle(def({ party: ['x', 'y'] }), monsters, party, 'side', rng)
      expect(r?.party.map((p) => p.id)).toEqual(['a', 'b', 'c'])
      expect(r?.script.joiners).toEqual({})
      expect(w).toHaveBeenCalledTimes(2)
    })
    it('全員指名なら joiners 空・指名順', () => {
      const r = buildFieldScriptedBattle(
        def({ party: ['c', 'a', 'b'] }),
        monsters,
        party,
        'side',
        rng
      )
      expect(r?.party.map((p) => p.id)).toEqual(['c', 'a', 'b'])
      expect(r?.script.joiners).toEqual({})
    })
    it('味方: の重複 id は先勝ちで重複除去（警告なし）', () => {
      const w = warnSpy()
      const r = buildFieldScriptedBattle(
        def({ party: ['b', 'b', 'a'] }),
        monsters,
        party,
        'side',
        rng
      )
      expect(r?.party.map((p) => p.id)).toEqual(['b', 'a'])
      expect(w).not.toHaveBeenCalled()
    })
    it('HP 0 の味方も指名どおり初期編成に入る', () => {
      const r = buildFieldScriptedBattle(
        def({ party: ['a'] }),
        monsters,
        [ally('a', 0), ally('b')],
        'side',
        rng
      )
      expect(r?.party.map((p) => [p.id, p.hp])).toEqual([['a', 0]])
    })
    it('party=[] は全員フォールバック', () => {
      const r = buildFieldScriptedBattle(def({ party: [] }), monsters, party, 'side', rng)
      expect(r?.party).toHaveLength(3)
    })
    it('敵が組めなければ null', () => {
      warnSpy()
      expect(
        buildFieldScriptedBattle(def({ enemies: '' }), monsters, party, 'side', rng)
      ).toBeNull()
    })
    it('入力を書き換えず、戻り値の味方は複製', () => {
      const src = [ally('a'), ally('b')]
      const snapshot = structuredClone(src)
      const r = buildFieldScriptedBattle(def({ party: ['a'] }), monsters, src, 'side', rng)
      expect(r?.party[0]).not.toBe(src[0])
      expect(r?.script.joiners?.b).not.toBe(src[1])
      if (r) r.party[0].hp = 1
      if (r?.script.joiners) r.script.joiners.b.hp = 1
      expect(src).toEqual(snapshot)
    })
    it('script.id と rules が渡る', () => {
      const r = buildFieldScriptedBattle(
        def({ id: 'boss', rules: ['にげる: 不可'] }),
        monsters,
        party,
        'side',
        rng
      )
      expect(r?.script.id).toBe('boss')
      expect(r?.script.rules).toEqual(['にげる: 不可'])
    })
  })

  describe('planEventBattle', () => {
    const base = (over: Partial<Parameters<typeof planEventBattle>[0]> = {}) => ({
      id: 'b1',
      battleScripts: { b1: def() },
      busy: false,
      monsters,
      party,
      layout: 'side' as const,
      rng,
      ...over,
    })
    it('宣言なしは skip no-def と警告 1 回', () => {
      const w = warnSpy()
      expect(planEventBattle(base({ id: 'nope' }))).toEqual({ kind: 'skip', reason: 'no-def' })
      expect(w).toHaveBeenCalledTimes(1)
    })
    it('battleScripts が undefined でも no-def', () => {
      warnSpy()
      expect(planEventBattle(base({ battleScripts: undefined }))).toEqual({
        kind: 'skip',
        reason: 'no-def',
      })
    })
    it.each(['__proto__', 'toString', 'constructor'])('継承名 %s は no-def', (id) => {
      const w = warnSpy()
      expect(planEventBattle(base({ id }))).toEqual({ kind: 'skip', reason: 'no-def' })
      expect(w).toHaveBeenCalledTimes(1)
    })
    it('busy は skip busy で警告なし', () => {
      const w = warnSpy()
      expect(planEventBattle(base({ busy: true }))).toEqual({ kind: 'skip', reason: 'busy' })
      expect(w).not.toHaveBeenCalled()
    })
    it('敵が組めなければ no-enemies', () => {
      warnSpy()
      const r = planEventBattle(base({ battleScripts: { b1: def({ enemies: 'ghost' }) } }))
      expect(r).toEqual({ kind: 'skip', reason: 'no-enemies' })
    })
    it('味方が空なら no-party と警告 1 回', () => {
      const w = warnSpy()
      expect(planEventBattle(base({ party: [] }))).toEqual({ kind: 'skip', reason: 'no-party' })
      expect(w).toHaveBeenCalledTimes(1)
    })
    it('正常は start・警告 0', () => {
      const w = warnSpy()
      const r = planEventBattle(base())
      expect(r.kind).toBe('start')
      if (r.kind === 'start') {
        expect(r.setup.enemies.map((e) => e.id)).toEqual(['slime'])
        expect(r.setup.party).toHaveLength(3)
      }
      expect(w).not.toHaveBeenCalled()
    })
  })
})

describe('planBattleFlagUpdates: 戦闘結果の フラグ= の選別 (#1077)', () => {
  const declared = { 勝利: false, 逃走: false }

  it('宣言済みの真偽値は set に入り、警告は無い', () => {
    expect(planBattleFlagUpdates(declared, { 勝利: true })).toEqual({
      set: [{ name: '勝利', value: true }],
      warnings: [],
    })
  })
  it('false も反映する（宣言済みを false へ戻せる）', () => {
    expect(planBattleFlagUpdates({ 勝利: true }, { 勝利: false }).set).toEqual([
      { name: '勝利', value: false },
    ])
  })
  it('結果フラグが undefined / 空なら何も起きない', () => {
    expect(planBattleFlagUpdates(declared, undefined)).toEqual({ set: [], warnings: [] })
    expect(planBattleFlagUpdates(declared, {})).toEqual({ set: [], warnings: [] })
  })
  it('未宣言の名前は警告 1 件で反映しない（名前を含む）', () => {
    const r = planBattleFlagUpdates(declared, { 未宣言: true })
    expect(r.set).toEqual([])
    expect(r.warnings).toHaveLength(1)
    expect(r.warnings[0]).toContain('未宣言')
  })
  it('宣言済みでも数値・文字列は警告して反映しない', () => {
    const r = planBattleFlagUpdates(declared, { 勝利: 1, 逃走: 'yes' })
    expect(r.set).toEqual([])
    expect(r.warnings).toHaveLength(2)
    expect(r.warnings[0]).toContain('1')
    expect(r.warnings[1]).toContain('"yes"')
  })
  it('数値 0 / 空文字も真偽値ではないので反映しない', () => {
    const r = planBattleFlagUpdates(declared, { 勝利: 0, 逃走: '' })
    expect(r.set).toEqual([])
    expect(r.warnings).toHaveLength(2)
  })
  it('継承の名前（__proto__ / toString / constructor）は未宣言扱い', () => {
    const resultFlags = JSON.parse('{"__proto__": true, "toString": true, "constructor": true}')
    const r = planBattleFlagUpdates(declared, resultFlags)
    expect(r.set).toEqual([])
    expect(r.warnings).toHaveLength(3)
  })
  it('混在: 宣言済み真偽値だけ set、他は警告。順序は結果フラグの並び', () => {
    const r = planBattleFlagUpdates(declared, { 勝利: true, 未宣言: true, 逃走: 3 })
    expect(r.set).toEqual([{ name: '勝利', value: true }])
    expect(r.warnings).toHaveLength(2)
    expect(r.warnings[0]).toContain('未宣言')
    expect(r.warnings[1]).toContain('逃走')
  })
  it('declared を書き換えない', () => {
    const d = { 勝利: false }
    planBattleFlagUpdates(d, { 勝利: true })
    expect(d).toEqual({ 勝利: false })
  })
})

describe('buildBattleMenuData: 習得候補は保存した Lv を優先 (#206)', () => {
  const spells = {
    fire: { id: 'fire', name: 'ほのお', mp: 3, target: '敵単体' },
    ice: { id: 'ice', name: 'こおり', mp: 3, target: '敵単体' },
  }
  const learns = [
    { level: 1, spell: 'fire' },
    { level: 4, spell: 'ice' },
  ]
  const ids = (r: ReturnType<typeof roster> & { spells: typeof spells }, level?: number) => {
    const party = buildPartyBattleEntities(r, 'side').map((m) =>
      level === undefined ? m : { ...m, level }
    )
    return buildBattleMenuData(r, party)?.spells?.a?.map((e) => e.id)
  }

  it('味方の level（レベルアップ後）が定義の初期 Lv より優先される', () => {
    const r = { ...roster(['a'], { a: { level: 1, learns } }), spells }
    expect(ids(r)).toEqual(['fire'])
    expect(ids(r, 4)).toEqual(['fire', 'ice'])
  })

  it('保存した level の方が低ければ、定義の初期 Lv ではなく保存側に従う', () => {
    const r = { ...roster(['a'], { a: { level: 5, learns } }), spells }
    expect(ids(r, 2)).toEqual(['fire'])
  })

  it('味方に level が無ければ定義の初期 Lv、それも無ければ 1', () => {
    const hi = { ...roster(['a'], { a: { level: 4, learns } }), spells }
    expect(ids(hi)).toEqual(['fire', 'ice'])
    const none = { ...roster(['a'], { a: { learns } }), spells }
    expect(ids(none)).toEqual(['fire'])
  })
})
