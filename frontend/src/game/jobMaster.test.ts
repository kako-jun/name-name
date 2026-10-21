/**
 * ジョブ (#740): markdown（`[ジョブ]` の 名前/説明/装備時/属性、`[パーティ]` の ジョブ:）→ parser(wasm) → マスター集約 →
 * 戦闘の味方（能力値・耐性）→ エンジン（ダメージ）まで通る。ジョブを宣言しない味方・ゲームは `BattleEntity` もメニューも従来と同一。
 */
import { describe, expect, it, vi } from 'vitest'
import { parseMarkdown } from '../wasm/parser'
import { collectMasterData, mergeMasterDataFromDocs } from './rpgProjectFromDoc'
import {
  buildBattleMenuData,
  buildPartyBattleEntities,
  type FieldBattleRoster,
} from './fieldBattle'
import { BattleEngine, type SkillExecution } from './battleEngine'
import { resolveMemberEquipment } from './equipment'
import type { EventDocument } from '../types'

const MD = `---
engine: name-name
chapter: 1
title: "t"
---
## data: マスター

[ジョブ nurse]
名前: 看護師
説明: 守りに強い
装備時: def+4, hp+30
[/ジョブ]

[ジョブ diver]
名前: 海女
装備時: agi+3
属性: water
[/ジョブ]

[ジョブ lawyer]
名前: 弁護士
装備時: atk+3
[/ジョブ]

[アイテム armor]
名前: みずのよろい
種別: 防具
属性: water
[/アイテム]

[パーティ hero]
名前: ゆうしゃ
HP: 100
ATK: 10
DEF: 4
AGI: 5
ジョブ: nurse, diver
[/パーティ]

[パーティ ally]
名前: なかま
HP: 80
ATK: 8
DEF: 3
AGI: 4
装備: armor
ジョブ: diver
[/パーティ]

[パーティ mage]
名前: まほう
HP: 50
ATK: 5
DEF: 1
AGI: 3
ジョブ: lawyer
ジョブ: ghost
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

async function load(text = MD): Promise<EventDocument> {
  return (await parseMarkdown(text)) as EventDocument
}

async function roster(extra: Partial<FieldBattleRoster> = {}): Promise<FieldBattleRoster> {
  const m = collectMasterData(await load())
  return {
    party: m.party,
    order: m.partyOrder,
    items: m.items,
    jobs: m.jobs,
    ...extra,
  }
}

describe('[ジョブ] と [パーティ] の ジョブ: のパースと集約', () => {
  it('parser がジョブを返し、collectMasterData が id 引きにまとめる', async () => {
    const m = collectMasterData(await load())
    expect(m.jobs.nurse).toEqual({
      id: 'nurse',
      name: '看護師',
      description: '守りに強い',
      equipBonus: 'def+4, hp+30',
    })
    expect(m.jobs.diver.elements).toEqual(['water'])
    // 宣言しない項目はキーも出ない
    expect(Object.keys(m.jobs.lawyer).sort()).toEqual(['equipBonus', 'id', 'name'])
    expect(m.party.hero.jobs).toEqual(['nurse', 'diver'])
    expect(m.party.mage.jobs).toEqual(['lawyer', 'ghost'])
    expect(m.party.plain.jobs).toBeUndefined()
  })

  it('複数のドキュメントのジョブは束ねられ、同じ id は後勝ち', async () => {
    const a = await load()
    const b = await load(
      MD.replace('名前: 看護師', '名前: 後ろの看護師').replace('説明: 守りに強い\n', '')
    )
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const merged = mergeMasterDataFromDocs([a, b])
      expect(merged.jobs.nurse.name).toBe('後ろの看護師')
      expect(Object.keys(merged.jobs).sort()).toEqual(['diver', 'lawyer', 'nurse'])
    } finally {
      warn.mockRestore()
    }
  })

  it('ジョブを宣言しないドキュメントは jobs が空', async () => {
    const m = collectMasterData(
      await load(MD.replace(/\[ジョブ[\s\S]*?\[\/ジョブ\]\n\n/g, '').replace(/ジョブ:.*\n/g, ''))
    )
    expect(m.jobs).toEqual({})
  })
})

describe('戦闘の味方への反映（実パーサ経由）', () => {
  it('先頭のジョブの装備時が能力値に、属性が耐性だけに付く。就けないジョブは警告して無視する', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    let texts: string[]
    let entities: ReturnType<typeof buildPartyBattleEntities>
    try {
      entities = buildPartyBattleEntities(await roster(), 'side')
      texts = warn.mock.calls.map((c) => String(c[0]))
    } finally {
      warn.mockRestore()
    }
    const [hero, ally, mage, plain] = entities
    // hero: 先頭の看護師（DEF+4, HP+30）
    expect(hero).toMatchObject({ id: 'hero', def: 8, maxHp: 130, hp: 130 })
    expect(Object.keys(hero)).not.toContain('affinity')
    // ally: 海女の水 + 防具の水 = 2 層で吸収。通常攻撃の属性にはならない
    expect(ally).toMatchObject({ id: 'ally', agi: 7, affinity: { absorb: ['water'] } })
    expect(Object.keys(ally)).not.toContain('attackElements')
    // mage: 弁護士（ATK+3）。ghost は宣言が無く、現在のジョブは先頭の lawyer なので警告は出ない
    expect(mage).toMatchObject({ id: 'mage', atk: 8 })
    expect(texts.some((t) => t.includes("ジョブ 'ghost'"))).toBe(false)
    // ジョブを持たない味方は従来と同一（キーも増えない）
    expect(plain).toEqual({
      id: 'plain',
      name: 'ふつう',
      hp: 50,
      maxHp: 50,
      mp: 0,
      maxMp: 0,
      atk: 5,
      def: 1,
      agi: 3,
    })
  })

  it('roster.currentJobs が現在のジョブを切り替える（転職・ジョブ無し）', async () => {
    const r = await roster({ currentJobs: { hero: 'diver', ally: '' } })
    const [hero, ally] = buildPartyBattleEntities(r, 'side')
    expect(hero).toMatchObject({ def: 4, maxHp: 100, agi: 8, affinity: { halve: ['water'] } })
    // ally はジョブ無し: 防具の水だけ（半減）
    expect(ally).toMatchObject({ agi: 4, affinity: { halve: ['water'] } })
  })

  it('就けないジョブを currentJobs に入れると警告してジョブ無しになる（能力値に効かない）', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const r = await roster({ currentJobs: { hero: 'lawyer' } })
      const [hero] = buildPartyBattleEntities(r, 'side')
      expect(hero).toMatchObject({ atk: 10, def: 4, maxHp: 100 })
      expect(warn.mock.calls.some((c) => String(c[0]).includes("hero: ジョブ 'lawyer'"))).toBe(true)
    } finally {
      warn.mockRestore()
    }
  })

  it('ジョブはコマンドを増やさない: ジョブを宣言しても候補窓（わざ・まほう）は作られない', async () => {
    const r = await roster()
    expect(buildBattleMenuData(r, buildPartyBattleEntities(r, 'side'))).toBeUndefined()
    expect(resolveMemberEquipment(r.party.hero, r).abilities).toEqual([])
  })
})

describe('エンジンまで通る', () => {
  const foe = () => ({
    id: 's',
    name: 'S',
    hp: 500,
    maxHp: 500,
    mp: 0,
    maxMp: 0,
    atk: 0,
    def: 0,
    agi: 1,
    actions: ['候補=wave'],
  })
  const wave: SkillExecution = {
    name: 'なみ',
    target: '相手全体',
    effect: 'damage 40..40 type=water',
  }

  it('海女の水耐性で敵の水攻撃が半減し、看護師の HP/DEF が効く', async () => {
    const r = await roster({ currentJobs: { hero: 'diver' } })
    const [hero] = buildPartyBattleEntities(r, 'side')
    const engine = new BattleEngine([hero], [foe()], { rng: () => 0, skills: { wave } })
    const before = hero.hp
    engine.selectAttack()
    expect(before - hero.hp).toBe(20)
  })

  it('ジョブ無しなら水攻撃は全額', async () => {
    const r = await roster({ currentJobs: { hero: '' } })
    const [hero] = buildPartyBattleEntities(r, 'side')
    const engine = new BattleEngine([hero], [foe()], { rng: () => 0, skills: { wave } })
    const before = hero.hp
    engine.selectAttack()
    expect(before - hero.hp).toBe(40)
  })
})
