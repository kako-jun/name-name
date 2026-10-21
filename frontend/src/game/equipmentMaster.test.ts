/**
 * 装備 (#207): markdown（`[アイテム]` の 装備時/装備可/属性/わざ、`[パーティ]` の 装備:/装備枠:）→ parser(wasm) → マスター集約 →
 * 戦闘の味方（能力値・耐性・通常攻撃の属性）・候補窓の「わざ」→ エンジン（ダメージ・わざの使用）まで通る。
 * 装備を宣言しない味方・ゲームは、`BattleEntity` もメニューも従来と同一。
 */
import { describe, expect, it, vi } from 'vitest'
import { parseMarkdown } from '../wasm/parser'
import { collectMasterData } from './rpgProjectFromDoc'
import {
  buildBattleMenuData,
  buildPartyBattleEntities,
  partyDefToBattleEntity,
  type FieldBattleRoster,
} from './fieldBattle'
import { BattleEngine, type SkillExecution } from './battleEngine'
import type { BattleSkillEntry } from './battleMenu'
import type { EventDocument } from '../types'
import type { BattleEntity } from './spellDsl'

const MD = `---
engine: name-name
chapter: 1
title: "t"
battle_commands: "skill, summon, item, escape"
---
## data: マスター

[特技 slash]
名前: きりさく
対象: 相手単体
効果: damage 45..45
[/特技]

[特技 sweep]
名前: なぎはらい
対象: 相手全体
効果: damage 25..25 type=fire
[/特技]

[特技 guard]
名前: みがまえ
対象: 自分
効果: buff def=+5 duration=3
[/特技]

[アイテム katana]
名前: かたな
種別: 武器
装備時: atk+8
わざ: slash
[/アイテム]

[アイテム katana2]
名前: かたな2
種別: 武器
装備時: atk+3, agi+2
装備可: ally
わざ: sweep
[/アイテム]

[アイテム armor]
名前: みずのよろい
種別: 防具
装備時: def+4, hp+30
属性: water
[/アイテム]

[アイテム potion]
名前: くすり
種別: 回復
効果: heal 30
[/アイテム]

[魔石 sea]
名前: うみの石
属性: water
対象: 相手全体
効果: damage 40..40 type=water
[/魔石]

[パーティ hero]
名前: ゆうしゃ
HP: 100
MP: 10
ATK: 10
DEF: 4
AGI: 5
装備枠: 武器, 防具
装備: katana, armor
[/パーティ]

[パーティ ally]
名前: なかま
HP: 80
MP: 10
ATK: 8
DEF: 3
AGI: 4
わざ: guard
装備: katana2, armor, sea
魔石枠: 1
[/パーティ]

[パーティ mage]
名前: まほう
HP: 50
ATK: 5
DEF: 1
AGI: 3
装備: katana2, potion
[/パーティ]

[パーティ plain]
名前: ふつう
HP: 50
ATK: 5
DEF: 1
AGI: 3
[/パーティ]

## map: 村

[マップ: 3x2]
`

async function load(): Promise<EventDocument> {
  return (await parseMarkdown(MD)) as EventDocument
}

async function roster(extra: Partial<FieldBattleRoster> = {}): Promise<FieldBattleRoster> {
  const m = collectMasterData(await load())
  const skills = Object.fromEntries(
    Object.values(m.skills).map((s) => [s.id, s])
  ) as FieldBattleRoster['skills']
  return {
    party: m.party,
    order: m.partyOrder,
    items: m.items,
    magicites: m.magicites,
    skills,
    ...extra,
  }
}

describe('[アイテム] の装備項目と [パーティ] の 装備:/装備枠: のパースと集約', () => {
  it('parser が装備項目を返し、collectMasterData が id 引きにまとめる', async () => {
    const m = collectMasterData(await load())
    expect(m.items.katana).toMatchObject({
      kind: '武器',
      equipBonus: 'atk+8',
      abilities: ['slash'],
    })
    expect(m.items.katana2.equippableBy).toEqual(['ally'])
    expect(m.items.armor).toMatchObject({ elements: ['water'], equipBonus: 'def+4, hp+30' })
    // 宣言しない項目はキーも出ない
    expect(Object.keys(m.items.potion).sort()).toEqual(['effect', 'id', 'kind', 'name'])
    expect(m.party.hero.equipment).toEqual(['katana', 'armor'])
    expect(m.party.hero.equipmentSlots).toEqual(['武器', '防具'])
    expect(m.party.ally.equipmentSlots).toBeUndefined()
    expect(m.party.plain.equipment).toBeUndefined()
  })
})

describe('戦闘の味方への反映（実パーサ経由）', () => {
  it('武器の ATK・防具の DEF/HP がボーナスに、防具の属性が耐性だけに付く', async () => {
    // 装備できなかった理由は警告として console に出る（同じ文面は 1 度だけなので、最初にここで受ける）
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    let texts: string[]
    let entities: BattleEntity[]
    try {
      entities = buildPartyBattleEntities(await roster(), 'side')
      texts = warn.mock.calls.map((c) => String(c[0]))
    } finally {
      warn.mockRestore()
    }
    expect(texts.some((t) => t.includes("mage: アイテム 'katana2' は装備可に含まれない"))).toBe(
      true
    )
    expect(texts.some((t) => t.includes("mage: アイテム 'potion' は種別 '回復'"))).toBe(true)
    const [hero, ally, mage, plain] = entities
    expect(hero).toMatchObject({
      id: 'hero',
      atk: 18,
      def: 8,
      maxHp: 130,
      hp: 130,
      affinity: { halve: ['water'] },
    })
    // 防具の属性は通常攻撃の属性にならない
    expect(Object.keys(hero)).not.toContain('attackElements')
    // ally: 防具の水 + 魔石の水 = 2 層で吸収。通常攻撃の属性は魔石由来の水だけ
    expect(ally).toMatchObject({
      id: 'ally',
      atk: 11,
      agi: 6,
      def: 7,
      affinity: { absorb: ['water'] },
      attackElements: ['water'],
    })
    // mage: katana2 は装備可に入っておらず、potion は種別違い。ボーナスなし
    expect(mage).toMatchObject({ atk: 5, def: 1, maxHp: 50 })
    // 装備を持たない味方は従来と同一（キーも増えない）
    expect(Object.keys(plain)).not.toContain('attackElements')
    expect(Object.keys(plain)).not.toContain('affinity')
    expect(plain).toMatchObject({ maxHp: 50, atk: 5, def: 1 })
  })

  it('roster.equipment が宣言の初期装備を上書きする（外す・付け替える）', async () => {
    const r = await roster({ equipment: { hero: ['armor'], plain: ['katana'] } })
    const [hero, , , plain] = buildPartyBattleEntities(r, 'side')
    expect(hero).toMatchObject({ atk: 10, def: 8 })
    expect(plain).toMatchObject({ atk: 13 })
    const menu = buildBattleMenuData(r, buildPartyBattleEntities(r, 'side'))!
    expect(menu.skills!.hero).toBeUndefined() // 武器を外せばわざも無い
    expect(menu.skills!.plain.map((e) => e.id)).toEqual(['slash'])
  })
})

describe('候補窓の「わざ」は装備中の武器から導く', () => {
  it('メンバー自身の わざ: の後ろに装備中の武器の わざ を重複なく足す', async () => {
    const r = await roster()
    const m = buildBattleMenuData(r, buildPartyBattleEntities(r, 'side'))!
    expect(m.skills!.hero.map((e) => e.id)).toEqual(['slash'])
    expect(m.skills!.ally.map((e) => e.id)).toEqual(['guard', 'sweep'])
    expect(m.skills!.mage).toBeUndefined()
    expect(m.skills!.plain).toBeUndefined()
    expect(m.skills!.hero[0]).toMatchObject({ name: 'きりさく', target: '相手単体' })
  })

  it('特技マスターに無いわざは出ない。何も宣言しないゲームは候補窓なし（従来どおり）', async () => {
    const r = await roster({ skills: {} })
    expect(buildBattleMenuData(r, buildPartyBattleEntities(r, 'side'))?.skills).toBeUndefined()
    const plain = {
      party: { a: { id: 'a', name: 'A', hp: 10, atk: 1, def: 1, agi: 1 } },
      order: ['a'],
    }
    expect(buildBattleMenuData(plain, buildPartyBattleEntities(plain, 'side'))).toBeUndefined()
  })
})

describe('エンジンまで通る', () => {
  const foe = (over: Partial<BattleEntity> = {}): BattleEntity => ({
    id: 's',
    name: 'S',
    hp: 500,
    maxHp: 500,
    mp: 0,
    maxMp: 0,
    atk: 0,
    def: 0,
    agi: 1,
    ...over,
  })
  const zero = () => 0

  it('武器の ATK が通常攻撃のダメージに反映され、装備なしより大きい', async () => {
    const r = await roster()
    const [hero] = buildPartyBattleEntities(r, 'side')
    const bare = partyDefToBattleEntity({ ...r.party.hero, equipment: undefined }, 'side', r)
    const a = foe()
    const b = foe()
    const e1 = new BattleEngine([hero], [a], { rng: zero })
    e1.selectAttack()
    const e2 = new BattleEngine([bare], [b], { rng: zero })
    e2.selectAttack()
    expect(500 - a.hp).toBeGreaterThan(500 - b.hp)
  })

  it('装備した武器のわざを selectSkill で使える（MP は減らない）。防具の水耐性で敵の水攻撃が半減する', async () => {
    const r = await roster()
    const [hero] = buildPartyBattleEntities(r, 'side')
    const menu = buildBattleMenuData(r, [hero])!
    const slash = menu.skills!.hero[0] as BattleSkillEntry
    const enemy = foe({ actions: ['候補=wave'] })
    const wave: SkillExecution = {
      name: 'なみ',
      target: '相手全体',
      effect: 'damage 40..40 type=water',
    }
    const mpBefore = hero.mp
    const engine = new BattleEngine([hero], [enemy], { rng: zero, skills: { wave } })
    const hpBefore = hero.hp
    expect(engine.selectSkill(slash)).toBe(true)
    expect(enemy.hp).toBe(500 - 45)
    expect(hero.mp).toBe(mpBefore)
    // 敵の水攻撃 40 は半減（20）で受ける
    expect(hpBefore - hero.hp).toBe(20)
  })
})
