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
  buildPartyBattleEntities,
  closeFieldBattle,
  openFieldBattle,
  orderedPartyKeys,
  partyDefToBattleEntity,
  readFieldBattleSettings,
  type FieldBattleSettings,
} from './fieldBattle'
import type { PartyMemberDef } from '../types'
import type { RPGProject } from '../types/rpg'
import type { BattleEntity } from './spellDsl'
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
    expect(onClosed).toHaveBeenCalledWith('victory')
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
