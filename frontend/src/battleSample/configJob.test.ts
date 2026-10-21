/** 戦闘画面サンプルの設定 JSON のジョブ (#740): `jobs` / `party[].jobs` / `party[].job` */
import { describe, it, expect } from 'vitest'
import jobsSample from '../../public/battle-sample/jobs.json?raw'
import {
  buildBattleSetup,
  defaultConfig,
  initialView,
  parseConfig,
  parseConfigText,
} from './config'
import { BattleEngine } from '../game/battleEngine'

const BASE = 'https://example.com/dir/x.json'
const NURSE = { id: 'nurse', name: '看護師', equipBonus: 'def+3, hp+20' }
const DIVER = { id: 'diver', name: '海女', equipBonus: 'agi+2', elements: ['water'] }

const cfg = (party: unknown[], jobs: unknown[] = [NURSE, DIVER]) =>
  parseConfig({ jobs, party }, BASE)

describe('jobs の読み込み', () => {
  it('省略は空。既定の設定にも空で入る', () => {
    const r = parseConfig({}, BASE)
    expect(r.ok && r.value.jobs).toEqual({})
    expect(defaultConfig().jobs).toEqual({})
  })

  it('id をキーにした JobDef になる（属性は正規化・重複排除、空文字は未指定）', () => {
    const r = parseConfig(
      {
        jobs: [
          {
            id: ' nurse ',
            name: ' 看護師 ',
            description: 'まもり',
            equipBonus: 'def+4',
            elements: ['ＷＡＴＥＲ', 'water', 'ice'],
          },
          { id: 'plain', name: '無職', description: '', equipBonus: ' ' },
        ],
      },
      BASE
    )
    if (!r.ok) throw new Error(r.error)
    expect(r.value.jobs).toEqual({
      nurse: {
        id: 'nurse',
        name: '看護師',
        description: 'まもり',
        equipBonus: 'def+4',
        elements: ['water', 'ice'],
      },
      plain: { id: 'plain', name: '無職' },
    })
  })

  it.each([
    ['jobs が配列でない', { jobs: {} }, 'jobs は配列'],
    ['要素がオブジェクトでない', { jobs: [1] }, 'jobs[0]'],
    ['id が無い', { jobs: [{ name: 'x' }] }, 'jobs[0].id'],
    ['name が空', { jobs: [{ id: 'a', name: ' ' }] }, 'jobs[0].name'],
    ['equipBonus が文字列でない', { jobs: [{ id: 'a', name: 'x', equipBonus: 3 }] }, 'equipBonus'],
    ['属性が 3 つ', { jobs: [{ id: 'a', name: 'x', elements: ['a', 'b', 'c'] }] }, '最大 2 つ'],
    ['party[].jobs が配列でない', { party: [{ id: 'a', hp: 1, jobs: 'nurse' }] }, 'party[0].jobs'],
    [
      'party[].job が文字列でない',
      { party: [{ id: 'a', hp: 1, jobs: ['n'], job: 3 }] },
      'party[0].job',
    ],
  ])('不正: %s はエラーにする', (_n, raw, msg) => {
    const r = parseConfig(raw, BASE)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain(msg)
  })
})

describe('party[] のジョブの反映', () => {
  it('先頭のジョブが既定。装備時が能力値に付く', () => {
    const r = cfg([{ id: 'a', hp: 50, def: 1, jobs: ['nurse', 'diver'] }])
    if (!r.ok) throw new Error(r.error)
    expect(r.value.party[0]).toMatchObject({ def: 4, maxHp: 70 })
    expect(Object.keys(r.value.party[0])).not.toContain('affinity')
  })

  it('job で現在のジョブを選べる。属性は耐性にだけ付く。空文字はジョブ無し', () => {
    const d = cfg([{ id: 'a', hp: 50, agi: 5, jobs: ['nurse', 'diver'], job: 'diver' }])
    if (!d.ok) throw new Error(d.error)
    expect(d.value.party[0]).toMatchObject({ agi: 7, affinity: { halve: ['water'] } })
    expect(Object.keys(d.value.party[0])).not.toContain('attackElements')
    const none = cfg([{ id: 'a', hp: 50, def: 1, jobs: ['nurse'], job: '' }])
    if (!none.ok) throw new Error(none.error)
    expect(none.value.party[0]).toMatchObject({ def: 1, maxHp: 50 })
  })

  it('宣言の無いジョブ・就けないジョブは装備されない（読み込みは成功）。コマンドは増えない', () => {
    const r = cfg([
      { id: 'a', hp: 50, def: 1, jobs: ['ghost'] },
      { id: 'b', hp: 50, def: 1, jobs: ['nurse'], job: 'diver' },
    ])
    if (!r.ok) throw new Error(r.error)
    expect(r.value.party[0]).toMatchObject({ def: 1, maxHp: 50 })
    expect(r.value.party[1]).toMatchObject({ def: 1, maxHp: 50 })
    expect(r.value.abilities).toEqual({})
    expect(r.value.summons).toEqual({})
  })

  it('味方がジョブを書かなければ、ジョブを宣言しても味方は従来と同一（キーも増えない）', () => {
    const base = parseConfig({ party: [{ id: 'a', hp: 50, atk: 3 }] }, BASE)
    const withMaster = cfg([{ id: 'a', hp: 50, atk: 3 }])
    if (!base.ok || !withMaster.ok) throw new Error('parse')
    expect(withMaster.value.party).toEqual(base.value.party)
    expect(Object.keys(base.value.party[0])).not.toContain('affinity')
  })
})

describe('サンプル jobs.json', () => {
  const load = () => {
    const r = parseConfigText(jobsSample, 'https://example.com/battle-sample/jobs.json')
    if (!r.ok) throw new Error(r.error)
    return r.value
  }

  it('parseConfigText で読め、ジョブ 3 種・3 人のジョブが能力値と耐性に反映される', () => {
    const c = load()
    expect(Object.keys(c.jobs)).toEqual(['nurse', 'diver', 'lawyer'])
    const [hero, ally, mage] = c.party
    // hero: 現在のジョブは海女（AGI+3・水の半減）。看護師には就いていない
    expect(hero).toMatchObject({ def: 4, maxHp: 120, agi: 9, affinity: { halve: ['water'] } })
    // ally: 海女（先頭）の水 + 防具の水 = 2 層で吸収
    expect(ally).toMatchObject({ def: 5, agi: 8, affinity: { absorb: ['water'] } })
    // mage: 弁護士（先頭。ATK+3, DEF+1）。耐性なし
    expect(mage).toMatchObject({ atk: 15, def: 3 })
    expect(Object.keys(mage)).not.toContain('affinity')
    expect(c.abilities).toEqual({})
  })

  it('敵の水の特技（40）を、hero は半減・ally は吸収・mage は全額で受ける', () => {
    const c = load()
    const setup = buildBattleSetup(c, initialView(c))
    const hero = setup.party.find((e) => e.id === 'hero')!
    const ally = setup.party.find((e) => e.id === 'ally')!
    const mage = setup.party.find((e) => e.id === 'mage')!
    ally.hp = 50
    const engine = new BattleEngine(setup.party, setup.enemies, {
      rng: () => 0,
      skills: setup.skills,
    })
    const before = [hero.hp, ally.hp, mage.hp]
    engine.selectAttack()
    expect(before[0] - hero.hp).toBe(20)
    expect(ally.hp - before[1]).toBe(40)
    expect(before[2] - mage.hp).toBe(40)
  })
})
