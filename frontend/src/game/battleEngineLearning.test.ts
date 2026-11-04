/** ラーニング (#882 段階 1): 敵の特技を味方が食らうと、戦闘終了時にパーティ共通の習得済みになる */
import { describe, expect, it } from 'vitest'
import { BattleEngine, type SkillExecution } from './battleEngine'
import type { BattleEntity } from './spellDsl'
import { buildBattleMenuData, type FieldBattleRoster } from './fieldBattle'
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
const enemyWith = (skill: string, over: Partial<BattleEntity> = {}): BattleEntity =>
  ent('boss', { atk: 1, actions: [`候補=${skill}`], ...over })
const make = (
  party: BattleEntity[],
  enemy: BattleEntity,
  skills: Record<string, SkillExecution>,
  learnedSpells?: string[]
) =>
  new BattleEngine(party, [enemy], {
    rng: () => 0,
    skills,
    ...(learnedSpells ? { learnedSpells } : {}),
  })
/** 決着まで攻撃を押し続ける */
const finish = (e: BattleEngine): void => {
  for (let i = 0; i < 300 && !e.isOver(); i++) e.selectAttack()
}

describe('敵の特技を食らうと、戦闘終了時の結果に習得済みが載る (#882)', () => {
  it('勝利: 食らった呪文が結果の learnedSpells に入る。戦闘中のログ・候補には何も足さない', () => {
    const e = make([ent('hero', { atk: 40 })], enemyWith('breath', { hp: 100, maxHp: 100 }), {
      breath: BREATH,
    })
    e.selectAttack()
    expect(e.getState().log.some((l) => l.includes('おぼえた'))).toBe(false)
    expect(e.getResult()).toBeNull() // 戦闘中は結果なし（確定は終了時）
    finish(e)
    expect(e.getResult()).toMatchObject({ outcome: 'victory', learnedSpells: ['flame'] })
  })

  it('全滅（敗北）・逃走でも結果に載る（勝敗は問わない。暫定）', () => {
    const lose = make([ent('hero', { hp: 3, maxHp: 3 })], enemyWith('breath', { atk: 1 }), {
      breath: { ...BREATH, effect: 'damage 99..99' },
    })
    finish(lose)
    expect(lose.getResult()).toMatchObject({ outcome: 'defeat', learnedSpells: ['flame'] })
    const fled = make([ent('hero')], enemyWith('breath'), { breath: BREATH })
    fled.selectAttack()
    fled.selectEscape()
    for (let i = 0; i < 50 && !fled.isOver(); i++) fled.selectEscape()
    expect(fled.getResult()?.outcome).toBe('escaped')
    expect(fled.getResult()?.learnedSpells).toEqual(['flame'])
  })

  it('複数の味方・戦闘不能の味方が混じっても、食らった呪文は 1 度だけ（重複しない）で、パーティ共通', () => {
    const e = make(
      [ent('down', { hp: 0 }), ent('a'), ent('b')],
      enemyWith('breath', { hp: 40, maxHp: 40 }),
      { breath: { ...BREATH, target: '相手全体' } }
    )
    finish(e)
    expect(e.getResult()?.learnedSpells).toEqual(['flame'])
  })

  it('MISS・無効（HP が動かない）でも、味方が対象に解決されたら載る（暫定）', () => {
    const hero = ent('hero', { affinity: { nullify: ['fire'] } })
    const e = make([hero], enemyWith('breath', { hp: 40, maxHp: 40 }), {
      breath: { ...BREATH, effect: 'damage 5..5 type=fire' },
    })
    e.selectAttack()
    expect(hero.hp).toBe(500)
    finish(e)
    expect(e.getResult()?.learnedSpells).toEqual(['flame'])
  })

  it('初期の習得済み（ホストの保存分）は結果にそのまま含まれ、重ならない。2 つ以上覚えると覚えた順', () => {
    const two: Record<string, SkillExecution> = {
      a: BREATH,
      b: { ...BREATH, name: 'こおりのいき', learns: 'ice' },
    }
    const e = make([ent('hero')], enemyWith('a | b', { hp: 100, maxHp: 100 }), two, [
      'holy',
      'flame',
    ])
    finish(e)
    const r = e.getResult()?.learnedSpells ?? []
    expect(r.slice(0, 2)).toEqual(['holy', 'flame'])
    expect(new Set(r).size).toBe(r.length)
  })

  it('食らわない技・味方が使う特技は覚えない。習得済みが無く覚えもしなければ結果にキーが無い', () => {
    // 敵が仲間（敵）へ使う技
    const heal: SkillExecution = {
      name: 'かいふく',
      target: '仲間単体',
      effect: 'heal 5..5',
      learns: 'flame',
    }
    const e = make([ent('hero', { atk: 99 })], enemyWith('heal', { hp: 40, maxHp: 40 }), { heal })
    finish(e)
    expect('learnedSpells' in (e.getResult() ?? {})).toBe(false)
    // 味方が使うわざ（対象が味方でも、使い手が味方なら覚えない）
    const e2 = make([ent('hero', { atk: 99 })], ent('boss', { atk: 0, hp: 40, maxHp: 40 }), {})
    e2.selectSkill({ ...BREATH, target: '仲間単体' })
    finish(e2)
    expect('learnedSpells' in (e2.getResult() ?? {})).toBe(false)
  })

  it('覚える: を書かない特技だけの戦闘は従来どおり（結果にキーが付かない）', () => {
    const e = make([ent('hero', { atk: 99 })], enemyWith('p', { hp: 40, maxHp: 40 }), {
      p: { name: 'p', target: '相手単体', effect: 'damage 1..1' },
    })
    finish(e)
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

describe('次の戦闘: roster.learnedSpells が候補窓に出る (#882)', () => {
  it('習得済みは全員の候補の最後に出る（覚える宣言の無い味方にも・既にある呪文は重ねない・マスターに無い id は出ない）', () => {
    const m = buildBattleMenuData(roster({ learnedSpells: ['flame', 'own', 'zzz'] }), members)
    expect(m?.spells?.hero.map((s) => s.id)).toEqual(['own', 'flame'])
    expect(m?.spells?.mage.map((s) => s.id)).toEqual(['flame', 'own'])
  })
  it('learnedSpells が無ければ従来どおり（learns の無い味方は何も持たない）', () => {
    const m = buildBattleMenuData(roster(), members)
    expect(m?.spells?.hero.map((s) => s.id)).toEqual(['own'])
    expect(m?.spells?.mage).toBeUndefined()
  })
})

describe('openFieldBattle: 結果で返した習得済みを次の戦闘の入力にできる (#882)', () => {
  it('1 戦闘目で食らうと結果に載り、2 戦闘目に roster.learnedSpells として渡すと候補窓に出る', async () => {
    const { Container } = await import('pixi.js')
    const { FieldInputGate, openFieldBattle, DEFAULT_FIELD_BATTLE_SETTINGS } = await import(
      './fieldBattle'
    )
    const base = roster({
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
    const open = (r: FieldBattleRoster) => {
      const screen = openFieldBattle({
        stage: new Container(),
        width: 800,
        height: 600,
        settings: { ...DEFAULT_FIELD_BATTLE_SETTINGS, layout: 'side' },
        roster: r,
        enemies: [enemyWith('breath')],
        gate: new FieldInputGate(),
        onClosed: () => {},
      })
      return screen as unknown as {
        engine: BattleEngine
        opts: { menu?: { spells?: Record<string, { id: string }[]> } }
      }
    }
    const first = open(base)
    expect(first.opts.menu?.spells?.hero.map((e) => e.id)).toEqual(['own'])
    finish(first.engine)
    const learned = first.engine.getResult()?.learnedSpells
    expect(learned).toEqual(['flame'])
    const second = open({ ...base, learnedSpells: learned })
    expect(second.opts.menu?.spells?.hero.map((e) => e.id)).toEqual(['own', 'flame'])
    expect(second.opts.menu?.spells?.mage.map((e) => e.id)).toEqual(['flame'])
    expect(JSON.stringify(base)).not.toContain('learnedSpells')
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
