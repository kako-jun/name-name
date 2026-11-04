/** ラーニング (#882 段階 1): 敵の特技を味方が食らうとパーティ共通の習得済みに入る */
import { describe, expect, it, vi } from 'vitest'
import { BattleEngine, type SkillExecution } from './battleEngine'
import type { BattleEntity } from './spellDsl'
import { addLearnedSpellToMenu, buildBattleMenuData, type FieldBattleRoster } from './fieldBattle'
import { toSkillExecutions } from './enemyAi'
import type { SkillDef, SpellDef } from '../types'

const ent = (id: string, over: Partial<BattleEntity> = {}): BattleEntity => ({
  id,
  name: id,
  hp: 500,
  maxHp: 500,
  mp: 9,
  maxMp: 9,
  atk: 1,
  def: 0,
  agi: 9,
  exp: 1,
  gold: 1,
  ...over,
})
const BREATH: SkillExecution = {
  name: 'ほのおのいき',
  target: '相手単体',
  effect: 'damage 5..5',
  learns: 'flame',
}
const enemyWith = (skill: string): BattleEntity =>
  ent('boss', { atk: 1, actions: [`候補=${skill}`] })
const make = (
  party: BattleEntity[],
  enemy: BattleEntity,
  skills: Record<string, SkillExecution>,
  learning?: ConstructorParameters<typeof BattleEngine>[2] extends infer O
    ? O extends { learning?: infer L }
      ? L
      : never
    : never
) => new BattleEngine(party, [enemy], { rng: () => 0, skills, ...(learning ? { learning } : {}) })

describe('敵の特技を食らうと覚える (#882)', () => {
  it('味方に当たったら習得済みに入り、ログと onLearn と結果に出る。2 回目は重ならない', () => {
    const onLearn = vi.fn()
    const e = make(
      [ent('hero', { name: 'ゆうしゃ' })],
      enemyWith('breath'),
      { breath: BREATH },
      {
        names: { flame: 'ほのお' },
        onLearn,
      }
    )
    e.selectAttack()
    expect(e.getState().log).toContain('ゆうしゃ は ほのお を おぼえた！')
    expect(onLearn).toHaveBeenCalledTimes(1)
    expect(onLearn).toHaveBeenCalledWith('flame')
    e.selectAttack()
    expect(onLearn).toHaveBeenCalledTimes(1)
    // 敵が敵を倒しきるまで進めて結果を見る
    for (let i = 0; i < 200 && !e.isOver(); i++) e.selectAttack()
    expect(e.getResult()?.learnedSpells).toEqual(['flame'])
  })

  it('初期の習得済みは結果に含まれ、すでに覚えている呪文は覚え直さない', () => {
    const onLearn = vi.fn()
    const e = make(
      [ent('hero')],
      enemyWith('breath'),
      { breath: BREATH },
      {
        initial: ['ice', 'flame'],
        onLearn,
      }
    )
    e.selectAttack()
    expect(onLearn).not.toHaveBeenCalled()
    for (let i = 0; i < 200 && !e.isOver(); i++) e.selectAttack()
    expect(e.getResult()?.learnedSpells).toEqual(['ice', 'flame'])
  })

  it('MISS・無効（HP が動かない効果）でも、味方が対象に解決されたら覚える', () => {
    const onLearn = vi.fn()
    const miss: SkillExecution = { ...BREATH, effect: 'damage 5..5 type=fire' }
    const hero = ent('hero', { affinity: { nullify: ['fire'] } })
    const e = make([hero], enemyWith('breath'), { breath: miss }, { onLearn })
    e.selectAttack()
    expect(hero.hp).toBe(500)
    expect(onLearn).toHaveBeenCalledWith('flame')
  })

  it('覚えるのは敵の特技だけ: 味方が使う特技（わざ）・敵が敵へかける技は覚えない', () => {
    const onLearn = vi.fn()
    const e = make([ent('hero')], ent('boss', { atk: 0 }), {}, { onLearn })
    e.selectSkill({ ...BREATH, target: '相手単体' })
    expect(onLearn).not.toHaveBeenCalled()
    // 味方が味方へ使う特技（対象が味方でも、使い手が味方なら覚えない）
    e.selectSkill({ ...BREATH, target: '仲間単体' })
    expect(onLearn).not.toHaveBeenCalled()
    // 敵が仲間（敵）へ使う特技
    const heal: SkillExecution = {
      name: 'かいふく',
      target: '仲間単体',
      effect: 'heal 5..5',
      learns: 'flame',
    }
    const e2 = make([ent('hero')], enemyWith('heal'), { heal }, { onLearn })
    e2.selectAttack()
    expect(onLearn).not.toHaveBeenCalled()
    expect(e2.getResult()).toBeNull()
  })

  it('learning を渡さない戦闘は従来どおり（覚えず、結果にキーも付かない）', () => {
    const e = make([ent('hero')], enemyWith('breath'), { breath: BREATH })
    e.selectAttack()
    expect(e.getState().log.some((l) => l.includes('おぼえた'))).toBe(false)
    for (let i = 0; i < 200 && !e.isOver(); i++) e.selectAttack()
    expect('learnedSpells' in (e.getResult() ?? {})).toBe(false)
  })
})

const spell = (id: string): SpellDef => ({
  id,
  name: `まほう${id}`,
  mp: 3,
  target: '敵単体',
  effect: 'damage 9..9',
})
const roster = (over: Partial<FieldBattleRoster> = {}): FieldBattleRoster => ({
  party: {
    hero: {
      id: 'hero',
      name: 'h',
      hp: 9,
      atk: 1,
      def: 1,
      agi: 1,
      learns: [{ level: 1, spell: 'own' }],
    },
    mage: { id: 'mage', name: 'm', hp: 9, atk: 1, def: 1, agi: 1 },
  },
  order: ['hero', 'mage'],
  spells: { own: spell('own'), flame: spell('flame') },
  ...over,
})
const members = [ent('hero'), ent('mage')]

describe('候補窓: 習得済みの呪文 (#882)', () => {
  it('roster.learnedSpells は全員の候補の最後に出る（覚えていない味方にも・既にある呪文は重ねない）', () => {
    const m = buildBattleMenuData(roster({ learnedSpells: ['flame', 'own', 'zzz'] }), members)
    expect(m?.spells?.hero.map((s) => s.id)).toEqual(['own', 'flame'])
    expect(m?.spells?.mage.map((s) => s.id)).toEqual(['flame', 'own'])
  })
  it('learnedSpells が無ければ従来どおり', () => {
    const m = buildBattleMenuData(roster(), members)
    expect(m?.spells?.hero.map((s) => s.id)).toEqual(['own'])
    expect(m?.spells?.mage).toBeUndefined()
  })
  it('addLearnedSpellToMenu: 戦闘中に覚えた呪文を全員の候補に足す（重ねない・マスターに無い id は無視）', () => {
    const r = roster()
    const menu = buildBattleMenuData(r, members)
    addLearnedSpellToMenu(menu, r, members, 'flame')
    addLearnedSpellToMenu(menu, r, members, 'flame')
    addLearnedSpellToMenu(menu, r, members, 'nope')
    expect(menu?.spells?.hero.map((s) => s.id)).toEqual(['own', 'flame'])
    expect(menu?.spells?.mage.map((s) => s.id)).toEqual(['flame'])
    addLearnedSpellToMenu(undefined, r, members, 'flame')
  })
})

describe('toSkillExecutions: learns の引き継ぎ (#882)', () => {
  it('learns を書いた特技だけキーが付く', () => {
    const skills: Record<string, SkillDef> = {
      a: { id: 'a', name: 'A', target: '相手単体', effect: 'damage 1..2', learns: 'flame' },
      b: { id: 'b', name: 'B', target: '相手単体', effect: 'damage 1..2' },
    }
    const ex = toSkillExecutions(skills)
    expect(ex.a.learns).toBe('flame')
    expect('learns' in ex.b).toBe(false)
  })
})

describe('openFieldBattle: 覚えた呪文が候補窓に出る (#882)', () => {
  it('敵の特技を食らうと、全員の候補に足され、結果に習得済みが出る。ロスターは書き換えない', async () => {
    const { Container } = await import('pixi.js')
    const { FieldInputGate, openFieldBattle, DEFAULT_FIELD_BATTLE_SETTINGS } = await import(
      './fieldBattle'
    )
    const r = roster({
      skills: {
        breath: {
          id: 'breath',
          name: 'ほのおのいき',
          target: '相手単体',
          effect: 'damage 5..5',
          learns: 'flame',
        },
      },
    })
    const before = JSON.stringify(r)
    const boss = ent('boss', { atk: 1, actions: ['候補=breath'] })
    const screen = openFieldBattle({
      stage: new Container(),
      width: 800,
      height: 600,
      settings: { ...DEFAULT_FIELD_BATTLE_SETTINGS, layout: 'side' },
      roster: r,
      enemies: [boss],
      gate: new FieldInputGate(),
      onClosed: () => {},
    })
    const s = screen as unknown as {
      engine: BattleEngine
      opts: { menu?: { spells?: Record<string, { id: string }[]> } }
    }
    expect(s.opts.menu?.spells?.hero.map((e) => e.id)).toEqual(['own'])
    expect(s.opts.menu?.spells?.mage).toBeUndefined()
    s.engine.selectAttack()
    expect(s.opts.menu?.spells?.hero.map((e) => e.id)).toEqual(['own', 'flame'])
    expect(s.opts.menu?.spells?.mage.map((e) => e.id)).toEqual(['flame'])
    expect(JSON.stringify(r)).toBe(before)
  })
})
