/**
 * `[魔石]` の宣言 (#889): markdown → parser(wasm) → マスター集約 → RPGProject → 戦闘の味方・候補窓・エンジンまで通る。
 * あわせて、複数属性の判定（resolveAffinityMulti）・候補窓の行・コマンド id の追加を固定する。
 */
import { describe, expect, it } from 'vitest'
import { parseMarkdown } from '../wasm/parser'
import { collectMasterData, mergeMasterDataFromDocs, rpgProjectFromDoc } from './rpgProjectFromDoc'
import {
  buildBattleMenuData,
  buildHeroBattleEntity,
  buildPartyBattleEntities,
  partyDefToBattleEntity,
  type FieldBattleRoster,
} from './fieldBattle'
import { BattleEngine } from './battleEngine'
import { resolveAffinityMulti } from './affinity'
import { buildMenuRows, targetSpecOf, type BattleSummonEntry } from './battleMenu'
import { parseCommandIds, resolveCommandSpecs, crossKeyToCommandId } from './battleCommands'
import type { Event, EventDocument } from '../types'

const MD = `---
engine: name-name
chapter: 1
title: "t"
battle_commands: "attack, summon, spell, item, escape"
---
## data: マスター

[魔石 sea]
名前: うみの石
召喚獣: うみの召喚獣
属性: water
対象: 相手全体
効果: damage 30..30 type=water
メッセージ: {user}は 波を よびだした！
装備時: hp+30, atk+2
成長: hp+3
[/魔石]

[魔石 tiger]
名前: かわぎりの石
召喚獣: ひのとら
属性: fire
消費MP: 5
効果: damage 50..50 type=fire
装備時: atk+6
成長: atk+1
装備可: ally
[/魔石]

[パーティ hero]
名前: ゆうしゃ
HP: 100
MP: 10
ATK: 10
DEF: 4
AGI: 5
魔石: sea, tiger
[/パーティ]

[パーティ ally]
名前: なかま
HP: 80
MP: 10
ATK: 8
DEF: 3
AGI: 4
魔石: sea, tiger
魔石枠: 2
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

describe('[魔石] のパースと集約', () => {
  it('parser が MagiciteDef を返し、collectMasterData が id 引きにまとめる', async () => {
    const m = collectMasterData(await load())
    expect(Object.keys(m.magicites)).toEqual(['sea', 'tiger'])
    expect(m.magicites.sea).toEqual({
      id: 'sea',
      name: 'うみの石',
      summon: 'うみの召喚獣',
      elements: ['water'],
      target: '相手全体',
      effect: 'damage 30..30 type=water',
      message: '{user}は 波を よびだした！',
      mp: 0,
      equipBonus: 'hp+30, atk+2',
      growth: 'hp+3',
    })
    expect(m.magicites.tiger).toMatchObject({ mp: 5, equippableBy: ['ally'], target: '相手単体' })
    expect(m.party.hero.magicites).toEqual(['sea', 'tiger'])
    expect(m.party.hero.magiciteSlots).toBeUndefined()
    expect(m.party.ally.magiciteSlots).toBe(2)
    expect(m.party.plain.magicites).toBeUndefined()
    expect(collectMasterData({ engine: 'name-name', chapters: [] }).magicites).toEqual({})
  })

  it('複数 doc の統合は id 重複が後勝ち', async () => {
    const a = await load()
    const b = (await parseMarkdown(
      '---\nengine: name-name\nchapter: 1\ntitle: "t"\n---\n## data: x\n\n[魔石 sea]\n名前: ぬりかえ\n[/魔石]\n'
    )) as EventDocument
    const merged = mergeMasterDataFromDocs([a, b])
    expect(merged.magicites.sea.name).toBe('ぬりかえ')
    expect(merged.magicites.tiger.name).toBe('かわぎりの石')
  })

  it('RPGProject は宣言したときだけ magicites を持つ（無いゲームのキー集合は従来どおり）', () => {
    const mapDoc = (events: Event[]): EventDocument => ({
      engine: 'name-name',
      chapters: [
        {
          number: 1,
          title: 'RPG',
          hidden: false,
          default_bgm: null,
          scenes: [
            {
              id: 'map',
              title: '村',
              view: 'TopDown',
              events: [
                { RpgMap: { width: 1, height: 1, tile_size: 32, tiles: [[0]] } },
                { PlayerStart: { x: 0, y: 0, direction: 'Down' } },
                ...events,
              ],
            },
          ],
        },
      ],
    })
    const withStone = rpgProjectFromDoc(
      mapDoc([{ Magicite: { id: 'sea', name: 'うみ', target: '相手単体' } }])
    )
    expect(withStone?.magicites).toEqual({ sea: { id: 'sea', name: 'うみ', target: '相手単体' } })
    const without = rpgProjectFromDoc(mapDoc([]))
    expect(without).toBeTruthy()
    expect(Object.prototype.hasOwnProperty.call(without, 'magicites')).toBe(false)
  })

  it('frontmatter の battle_commands に summon を書ける', async () => {
    const doc = await load()
    expect(parseCommandIds(doc.battle_commands)).toEqual([
      'attack',
      'summon',
      'spell',
      'item',
      'escape',
    ])
  })
})

describe('戦闘の味方への反映（実パーサ経由）', () => {
  async function roster(extra: Partial<FieldBattleRoster> = {}): Promise<FieldBattleRoster> {
    const m = collectMasterData(await load())
    return { party: m.party, order: m.partyOrder, magicites: m.magicites, ...extra }
  }

  it('hero は sea だけ装備（tiger は装備可に無い）。能力値・耐性・通常攻撃の属性が付く', async () => {
    const [hero, ally, plain] = buildPartyBattleEntities(await roster(), 'side')
    // hero: 枠 1 → sea のみ（tiger は枠を超える）
    expect(hero).toMatchObject({
      id: 'hero',
      maxHp: 130,
      hp: 130,
      atk: 12,
      def: 4,
      attackElements: ['water'],
      affinity: { halve: ['water'] },
    })
    // ally: 枠 2 → sea + tiger（水と火の 2 層）
    expect(ally).toMatchObject({
      id: 'ally',
      maxHp: 110,
      atk: 16,
      attackElements: ['water', 'fire'],
      affinity: { halve: ['water', 'fire'] },
    })
    // 魔石を持たない味方は従来と同一（キーも増えない）
    expect(Object.keys(plain)).not.toContain('attackElements')
    expect(Object.keys(plain)).not.toContain('affinity')
    expect(plain).toMatchObject({ maxHp: 50, atk: 5 })
  })

  it('装備可に入っていない味方は装備できない（tiger は ally 専用）', async () => {
    const r = await roster({ equipment: { hero: ['tiger'] } })
    const hero = buildHeroBattleEntity(r, 'side')
    expect(hero.attackElements).toBeUndefined()
    expect(hero.atk).toBe(10)
  })

  it('equipment が魔石: を上書きし、growth は装備時ボーナスとは別に足され、extraElements は魔石の後ろに積まれる', async () => {
    const r = await roster({
      equipment: { hero: ['sea'] },
      growth: { hero: { hp: 9, def: 2 } },
      extraElements: { hero: ['water'] },
    })
    const hero = buildHeroBattleEntity(r, 'side')
    expect(hero).toMatchObject({
      maxHp: 100 + 30 + 9,
      def: 6,
      atk: 12,
      attackElements: ['water', 'water'],
      affinity: { absorb: ['water'] },
    })
  })

  it('魔石を宣言しない roster の味方は従来どおり（partyDefToBattleEntity の出力が変わらない）', async () => {
    const m = collectMasterData(await load())
    const plain = partyDefToBattleEntity(m.party.plain, 'side')
    expect(plain).toEqual(partyDefToBattleEntity(m.party.plain, 'side', {}))
    expect(Object.keys(plain).sort()).toEqual(
      ['id', 'name', 'hp', 'maxHp', 'mp', 'maxMp', 'atk', 'def', 'agi', 'sprite'].sort()
    )
  })

  it('候補窓の「しょうかん」: 装備中の魔石を枠の順に（hero は 1 件・ally は 2 件・魔石なしは無し）', async () => {
    const r = await roster()
    const party = buildPartyBattleEntities(r, 'side')
    const menu = buildBattleMenuData(r, party)
    expect(menu?.summons?.hero.map((e) => [e.id, e.name, e.mp])).toEqual([
      ['sea', 'うみの召喚獣', 0],
    ])
    expect(menu?.summons?.ally.map((e) => [e.id, e.name, e.mp])).toEqual([
      ['sea', 'うみの召喚獣', 0],
      ['tiger', 'ひのとら', 5],
    ])
    expect(menu?.summons?.plain).toBeUndefined()
    // 魔石を宣言しない roster は summons を持たず、候補窓のデータも無い（従来どおり）
    const none = buildBattleMenuData({ party: r.party, order: r.order }, party)
    expect(none).toBeUndefined()
  })

  it('実パーサの魔石で召喚 → 1 バトル 1 回・MP・属性ダメージまで通る', async () => {
    const r = await roster()
    const party = buildPartyBattleEntities(r, 'side')
    const menu = buildBattleMenuData(r, party)
    const enemies = [
      {
        id: 'e1',
        name: 'かわのぬし',
        hp: 500,
        maxHp: 500,
        mp: 0,
        maxMp: 0,
        atk: 0,
        def: 0,
        agi: 0,
        affinity: { weak: ['water'], absorb: ['fire'] },
      },
    ]
    const engine = new BattleEngine(party, enemies, { rng: () => 0 })
    const sea = menu!.summons!.hero[0]
    expect(engine.selectSummon(sea)).toBe(true)
    expect(enemies[0].hp).toBe(500 - 60) // 水の召喚 30 × 弱点 2
    expect(party[0].summoned).toBe(true)
    // 2 回目は拒否
    expect(engine.selectSummon(sea)).toBe(false)
    expect(enemies[0].hp).toBe(440)
  })
})

describe('resolveAffinityMulti', () => {
  const aff = { weak: ['water'], halve: ['ice'], nullify: ['wind'], absorb: ['fire'] }
  it('属性 0〜1 個は resolveAffinity と同じ。未指定・空・相性なしは normal', () => {
    expect(resolveAffinityMulti(aff, undefined)).toBe('normal')
    expect(resolveAffinityMulti(aff, [])).toBe('normal')
    expect(resolveAffinityMulti(undefined, ['fire'])).toBe('normal')
    expect(resolveAffinityMulti(aff, ['water'])).toBe('weak')
    expect(resolveAffinityMulti(aff, ['ice'])).toBe('halve')
    expect(resolveAffinityMulti(aff, ['wind'])).toBe('nullify')
    expect(resolveAffinityMulti(aff, ['fire'])).toBe('absorb')
    expect(resolveAffinityMulti(aff, ['earth'])).toBe('normal')
  })
  it('複数属性は優先順位の高い種類（吸収 > 無効 > 半減 > 弱点 > 等倍）を採る（全ペア）', () => {
    const order = [
      ['fire', 'absorb'],
      ['wind', 'nullify'],
      ['ice', 'halve'],
      ['water', 'weak'],
      ['earth', 'normal'],
    ] as const
    for (let i = 0; i < order.length; i++) {
      for (let j = 0; j < order.length; j++) {
        const want = order[Math.min(i, j)][1]
        expect(resolveAffinityMulti(aff, [order[i][0], order[j][0]])).toBe(want)
      }
    }
  })
  it('属性 id は正規化して照合する（全角・大文字）', () => {
    expect(resolveAffinityMulti(aff, ['ＷＡＴＥＲ', 'earth'])).toBe('weak')
  })
})

describe('候補窓の「しょうかん」と コマンド id', () => {
  const entry = (over: Partial<BattleSummonEntry> = {}): BattleSummonEntry => ({
    id: 'sea',
    name: 'うみ',
    target: '相手全体',
    mp: 0,
    ...over,
  })
  it('行: MP が 0 なら消費欄は空、0 より大きければ数字。呼び済み・MP 不足はグレー', () => {
    const rows = (actor: { mp: number; summoned?: boolean } | undefined, mp: number) =>
      buildMenuRows('summon', [entry({ mp })], actor)
    expect(rows({ mp: 0 }, 0)).toEqual([{ label: 'うみ', cost: '', disabled: false }])
    expect(rows({ mp: 5 }, 5)).toEqual([{ label: 'うみ', cost: '5', disabled: false }])
    expect(rows({ mp: 4 }, 5)[0].disabled).toBe(true)
    expect(rows({ mp: 9, summoned: true }, 5)[0].disabled).toBe(true)
    expect(rows({ mp: 9, summoned: true }, 0)[0].disabled).toBe(true)
    expect(rows(undefined, 0)[0].disabled).toBe(true)
  })
  it('対象は特技と同じ相対表現（相手単体・相手全体・仲間全体・自分）', () => {
    const spec = (target: string) => targetSpecOf('summon', entry({ target }))
    expect(spec('相手全体')).toEqual({ side: 'enemy', scope: 'all' })
    expect(spec('相手単体')).toEqual({ side: 'enemy', scope: 'single' })
    expect(spec('仲間全体')).toEqual({ side: 'party', scope: 'all' })
    expect(spec('自分')).toEqual({ side: 'party', scope: 'self' })
    expect(spec('')).toEqual({ side: 'enemy', scope: 'single' })
  })
  it('summon は既定の並びに入らず、書いたときだけ並ぶ。表示名の既定は「しょうかん」', () => {
    expect(resolveCommandSpecs().map((c) => c.id)).toEqual(['attack', 'spell', 'item', 'escape'])
    expect(
      resolveCommandSpecs(undefined, ['attack', 'summon', 'spell', 'item', 'escape'])[1]
    ).toEqual({
      id: 'summon',
      label: 'しょうかん',
    })
    expect(resolveCommandSpecs({ summon: 'よぶ' }, ['summon'])[0].label).toBe('よぶ')
    expect(parseCommandIds('summon, skill, summon')).toEqual(['summon', 'skill'])
    expect(crossKeyToCommandId('ArrowLeft', ['attack', 'summon', 'spell', 'item'])).toBe('summon')
  })
})
