/**
 * `[召喚獣]` の宣言 (#750): markdown → parser(wasm) → マスター集約 → 参照の解決（魔石・特技）→ 戦闘の候補窓・エンジンの行動の記録まで通る。
 * `召喚獣id` を書かない既存の宣言は従来どおり（同じオブジェクト・キーも増えない）。
 */
import { describe, expect, it } from 'vitest'
import { parseMarkdown } from '../wasm/parser'
import { collectMasterData, mergeMasterDataFromDocs, rpgProjectFromDoc } from './rpgProjectFromDoc'
import { buildBattleMenuData, buildPartyBattleEntities } from './fieldBattle'
import { BattleEngine } from './battleEngine'
import { toSkillExecutions } from './enemyAi'
import type { EventDocument } from '../types'

const MD = `---
engine: name-name
chapter: 1
title: "t"
---
## data: マスター

[召喚獣 S001]
名前: 日本海の召喚獣
属性: water
画像: summons/S001.webp
効果音: se/wave.ogg
想像: はい
対象: 相手全体
効果: damage 30..30 type=water
メッセージ: {user}は 荒波を よびだした！
[/召喚獣]

[召喚獣 S004]
名前: 虎の召喚獣
属性: fire
向き: 左
対象: 相手単体
効果: damage 50..50 type=fire
[/召喚獣]

[魔石 sea]
名前: うみの石
召喚獣id: S001
装備時: hp+30
[/魔石]

[魔石 tiger]
名前: かわぎりの石
召喚獣: ひのとら
召喚獣id: S004
属性: ice
効果: damage 7..7 type=ice
[/魔石]

[魔石 lost]
名前: まよいの石
召喚獣id: nothing
効果: damage 1..1
[/魔石]

[魔石 old]
名前: ふるい石
召喚獣: ふるいやつ
効果: damage 2..2
[/魔石]

[特技 call]
名前: よびごえ
召喚獣id: S001
[/特技]

[特技 own]
名前: じぶんの
召喚獣id: S001
対象: 自分
効果: heal 10..10
[/特技]

[特技 hit]
名前: たたく
効果: damage 3..3
[/特技]

[パーティ hero]
名前: ゆうしゃ
HP: 100
MP: 10
ATK: 10
DEF: 4
AGI: 5
魔石: sea, tiger
魔石枠: 2
[/パーティ]

## map: 村

[マップ: 3x2]
`

async function load(md: string = MD): Promise<EventDocument> {
  return (await parseMarkdown(md)) as EventDocument
}

/** マスターの宣言（parser の出力）に最小のマップを足した文書。`rpgProjectFromDoc` はマップが無いと null を返す */
function withMap(doc: EventDocument): EventDocument {
  const events = doc.chapters.flatMap((c) => c.scenes.flatMap((sc) => sc.events))
  return {
    ...doc,
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
  }
}

describe('[召喚獣] のパースと集約', () => {
  it('parser が SummonDef を返し、collectMasterData が id 引きにまとめる', async () => {
    const m = collectMasterData(await load())
    expect(Object.keys(m.summons)).toEqual(['S001', 'S004'])
    expect(m.summons.S001).toEqual({
      id: 'S001',
      name: '日本海の召喚獣',
      elements: ['water'],
      image: 'summons/S001.webp',
      se: 'se/wave.ogg',
      imaginary: true,
      target: '相手全体',
      effect: 'damage 30..30 type=water',
      message: '{user}は 荒波を よびだした！',
    })
    expect(m.summons.S004).toMatchObject({ facing: 'left' })
    expect(m.summons.S004.imaginary).toBeUndefined()
    expect(m.magicites.sea.summonId).toBe('S001')
    expect(m.skills.call.summonId).toBe('S001')
    expect(collectMasterData({ engine: 'name-name', chapters: [] }).summons).toEqual({})
  })

  it('複数 doc の統合は id 重複が後勝ち', async () => {
    const b = (await parseMarkdown(
      '---\nengine: name-name\nchapter: 1\ntitle: "t"\n---\n## data: x\n\n[召喚獣 S001]\n名前: ぬりかえ\n[/召喚獣]\n'
    )) as EventDocument
    const merged = mergeMasterDataFromDocs([await load(), b])
    expect(merged.summons.S001.name).toBe('ぬりかえ')
    expect(merged.summons.S004.name).toBe('虎の召喚獣')
  })
})

describe('参照の解決（rpgProjectFromDoc）', () => {
  async function project() {
    const p = rpgProjectFromDoc(withMap(await load()))
    expect(p).toBeTruthy()
    return p!
  }

  it('魔石: 自分の効果が無ければ召喚獣の中身・表示名・属性を使い、cue が付く', async () => {
    const p = await project()
    expect(p.magicites?.sea).toMatchObject({
      id: 'sea',
      summon: '日本海の召喚獣',
      elements: ['water'],
      target: '相手全体',
      effect: 'damage 30..30 type=water',
      message: '{user}は 荒波を よびだした！',
      equipBonus: 'hp+30',
      cue: {
        id: 'S001',
        name: '日本海の召喚獣',
        image: 'summons/S001.webp',
        se: 'se/wave.ogg',
        imaginary: true,
      },
    })
  })

  it('魔石: 自分の効果・表示名・属性があればそちらが優先（召喚獣の中身は混ぜない）。向きは cue に出る', async () => {
    const p = await project()
    expect(p.magicites?.tiger).toMatchObject({
      summon: 'ひのとら',
      elements: ['ice'],
      effect: 'damage 7..7 type=ice',
      cue: { id: 'S004', name: '虎の召喚獣', faces: 'left' },
    })
    expect(p.magicites?.tiger.target).toBe('相手単体')
    expect(p.magicites?.tiger.cue).not.toHaveProperty('imaginary')
    expect(p.magicites?.tiger.cue).not.toHaveProperty('image')
  })

  it('宣言の無い id は無視（cue も中身の継承も付かない）。召喚獣id を書かない魔石・特技は同じオブジェクトのまま', async () => {
    const doc = await load()
    const p = rpgProjectFromDoc(withMap(doc))!
    expect(p.magicites?.lost).not.toHaveProperty('cue')
    expect(p.magicites?.lost.effect).toBe('damage 1..1')
    expect(p.magicites?.old).not.toHaveProperty('cue')
    const raw = collectMasterData(doc)
    expect(p.magicites?.old).toBe(raw.magicites.old)
    expect(p.skills?.hit).toBe(raw.skills.hit)
  })

  it('特技: 自分の効果が無ければ召喚獣の中身。あれば特技が優先。cue は両方に付く', async () => {
    const p = await project()
    expect(p.skills?.call).toMatchObject({
      target: '相手全体',
      effect: 'damage 30..30 type=water',
      cue: { id: 'S001' },
    })
    expect(p.skills?.own).toMatchObject({
      target: '自分',
      effect: 'heal 10..10',
      cue: { id: 'S001' },
    })
    expect(p.skills?.hit).not.toHaveProperty('cue')
  })

  it('召喚獣を 1 つも宣言しない文書は、魔石・特技が入力と同じオブジェクトのまま', async () => {
    const plain = await load(
      '---\nengine: name-name\nchapter: 1\ntitle: "t"\n---\n## data: x\n\n[魔石 a]\n名前: あ\n効果: damage 1..1\n[/魔石]\n\n[特技 b]\n名前: い\n[/特技]\n'
    )
    const raw = collectMasterData(plain)
    const p = rpgProjectFromDoc(withMap(plain))!
    expect(p.magicites?.a).toBe(raw.magicites.a)
    expect(p.skills?.b).toBe(raw.skills.b)
    expect(Object.prototype.hasOwnProperty.call(p.magicites?.a, 'cue')).toBe(false)
  })
})

describe('戦闘まで通る（実パーサ経由）', () => {
  it('候補窓の「しょうかん」の行に cue が載り、召喚すると行動の記録に summon が付く', async () => {
    const p = rpgProjectFromDoc(withMap(await load()))!
    const roster = {
      party: p.party ?? {},
      order: p.partyOrder ?? [],
      magicites: p.magicites,
      skills: p.skills,
    }
    const party = buildPartyBattleEntities(roster, 'side')
    const menu = buildBattleMenuData(roster, party)
    const rows = menu?.summons?.hero ?? []
    expect(rows.map((r) => [r.id, r.name, r.cue?.id])).toEqual([
      ['sea', '日本海の召喚獣', 'S001'],
      ['tiger', 'ひのとら', 'S004'],
    ])
    const enemy = {
      id: 'e',
      name: 'てき',
      hp: 500,
      maxHp: 500,
      mp: 0,
      maxMp: 0,
      atk: 0,
      def: 0,
      agi: 1,
      exp: 1,
      gold: 1,
    }
    const engine = new BattleEngine(party, [enemy], { rng: () => 0 })
    expect(engine.selectSummon(rows[0])).toBe(true)
    const ev = engine.getState().events.find((e) => e.kind === 'skill')
    expect(ev?.summon).toMatchObject({ id: 'S001', imaginary: true, image: 'summons/S001.webp' })
    expect(ev?.hits[0]).toMatchObject({ kind: 'damage', amount: 30 })
  })

  it('敵が cue つきの特技を使っても、enemy 側の記録に summon は付かない（普通の特技として動く）', async () => {
    const p = rpgProjectFromDoc(withMap(await load()))!
    const boss = {
      id: 'boss',
      name: 'ぬし',
      hp: 999,
      maxHp: 999,
      mp: 0,
      maxMp: 0,
      atk: 1,
      def: 0,
      agi: 99,
      exp: 1,
      gold: 1,
      actions: ['候補=call'],
    }
    const hero = {
      id: 'h',
      name: 'H',
      hp: 500,
      maxHp: 500,
      mp: 0,
      maxMp: 0,
      atk: 1,
      def: 0,
      agi: 1,
    }
    const engine = new BattleEngine([hero], [boss], {
      rng: () => 0,
      skills: toSkillExecutions(p.skills ?? {}),
    })
    engine.selectAttack()
    const ev = engine.getState().events.find((e) => e.kind === 'skill' && e.actor.side === 'enemy')
    expect(ev).toBeDefined()
    expect(ev?.summon).toBeUndefined()
    expect(ev?.label).toBe('よびごえ')
    expect(ev?.hits[0]).toMatchObject({ kind: 'damage', amount: 30 })
  })
})
