/** `[状態]` の宣言 (#870): markdown → parser(wasm) → マスター集約 → RPGProject → 戦闘エンジンまで通る */
import { describe, it, expect, vi } from 'vitest'
import { parseMarkdown } from '../wasm/parser'
import { collectMasterData, mergeMasterDataFromDocs, rpgProjectFromDoc } from './rpgProjectFromDoc'
import { BattleEngine } from './battleEngine'
import { toSkillExecutions } from './enemyAi'
import type { BattleEntity } from './spellDsl'
import type { Event, EventDocument } from '../types'

const MD = `---
engine: name-name
chapter: 1
title: "t"
---
## data: マスター

[状態 poison]
名前: どく
持続: 3
継続ダメージ: 1/10
[/状態]

[状態 zombie]
名前: ゾンビ
持続: 4
反転: 回復, ダメージ
[/状態]

[特技 venom]
名前: どくのきり
対象: 相手全体
効果: status poison
[/特技]

[特技 meteor]
名前: メテオ
対象: 相手全体
効果: damage 9999..9999
[/特技]

[特技 curse]
名前: まじない
対象: 相手全体
効果: status zombie
[/特技]

## map: 村

[マップ: 3x2]
`

function ent(over: Partial<BattleEntity> = {}): BattleEntity {
  return {
    id: 'e',
    name: 'E',
    hp: 100,
    maxHp: 100,
    mp: 0,
    maxMp: 0,
    atk: 0,
    def: 0,
    agi: 2,
    ...over,
  }
}

describe('[状態] のパースと集約', () => {
  it('parser が StatusDef を返し、collectMasterData が id 引きにまとめる', async () => {
    const doc = (await parseMarkdown(MD)) as EventDocument
    const m = collectMasterData(doc)
    expect(Object.keys(m.statuses)).toEqual(['poison', 'zombie'])
    expect(m.statuses.poison).toEqual({
      id: 'poison',
      name: 'どく',
      duration: '3',
      tickDamage: '1/10',
    })
    expect(m.statuses.zombie.reverse).toBe('回復, ダメージ')
    // 宣言が無い doc のマスターは空
    expect(collectMasterData({ engine: 'name-name', chapters: [] }).statuses).toEqual({})
  })

  it('複数 doc の統合は id 重複が後勝ち', async () => {
    const a = (await parseMarkdown(MD)) as EventDocument
    const b = (await parseMarkdown(
      '---\nengine: name-name\nchapter: 1\ntitle: "t"\n---\n## data: x\n\n[状態 poison]\n名前: もうどく\n[/状態]\n'
    )) as EventDocument
    const merged = mergeMasterDataFromDocs([a, b])
    expect(merged.statuses.poison.name).toBe('もうどく')
    expect(merged.statuses.zombie.name).toBe('ゾンビ')
  })

  it('RPGProject は宣言したときだけ statuses を持つ（無いゲームのキー集合は従来どおり）', async () => {
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
    const withStatus = rpgProjectFromDoc(
      mapDoc([{ Status: { id: 'poison', name: 'どく', tickDamage: '1/16' } }])
    )
    expect(withStatus?.statuses).toEqual({
      poison: { id: 'poison', name: 'どく', tickDamage: '1/16' },
    })
    const plain = rpgProjectFromDoc(mapDoc([]))
    expect(plain).not.toBeNull()
    expect('statuses' in (plain as object)).toBe(false)
  })
})

describe('markdown の宣言で戦闘が動く（端から端まで）', () => {
  it('敵の特技（markdown）で毒を付けられ、味方の手番ごとに最大 HP の 1/10 ずつ減る', async () => {
    const doc = (await parseMarkdown(MD)) as EventDocument
    const m = collectMasterData(doc)
    const hero = ent({ id: 'h', name: 'ゆうしゃ', hp: 100, maxHp: 100 })
    const boss = ent({ id: 'b', hp: 9999, maxHp: 9999, actions: ['条件=初手 候補=venom'] })
    const e = new BattleEngine([hero], [boss], {
      rng: () => 0,
      skills: toSkillExecutions(m.skills),
      statuses: m.statuses,
    })
    e.selectAttack() // 敵が毒を付ける（付けた手番では減らず、味方の次の手番の終わりから）
    expect(hero.status).toEqual({ poison: 3 })
    e.selectAttack()
    expect(hero.status).toEqual({ poison: 2 })
    const tick = e.getState().events.filter((ev) => ev.kind === 'status')
    expect(tick.map((ev) => ev.hits[0].amount)).toEqual([10])
    e.selectAttack()
    e.selectAttack()
    expect(hero.status).toEqual({}) // 持続 3 = 毒のダメージ 3 回で明ける
  })

  it('全滅級のメテオもゾンビなら回復になって生き延びる', async () => {
    const doc = (await parseMarkdown(MD)) as EventDocument
    const m = collectMasterData(doc)
    const a = ent({ id: 'a', hp: 50, maxHp: 500, status: { zombie: 4 } })
    const b = ent({ id: 'b', hp: 50, maxHp: 500 })
    const boss = ent({ id: 'x', hp: 9999, maxHp: 9999, actions: ['候補=meteor'] })
    const e = new BattleEngine([a, b], [boss], {
      rng: () => 0,
      skills: toSkillExecutions(m.skills),
      statuses: m.statuses,
    })
    e.selectAttack()
    expect(a.hp).toBe(500)
    expect(b.hp).toBe(0)
    expect(e.getState().phase).not.toBe('defeat')
  })
})

describe('[状態] の誤記を知らせる (#870)', () => {
  const BAD = `---
engine: name-name
chapter: 1
title: "t"
---
## data: マスター

[状態 noname]
持続: 3
[/状態]

[状態 typo]
名前: ほげ
持続: 3
継続ダメージュ: 5
[/状態]

[状態 ]
名前: からid
[/状態]

[状態 dup]
名前: いち
[/状態]

[状態 dup]
名前: に
[/状態]
`
  it('名前なし・未知キーは parser が console.warn する。同じ id の重複は集約時に上書きを知らせる', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const doc = await parseMarkdown(BAD)
      const msgs = () => warn.mock.calls.map((c) => String(c[0]))
      expect(msgs().some((m) => m.includes('[状態 noname]') && m.includes('名前'))).toBe(true)
      expect(msgs().some((m) => m.includes('[状態 typo]') && m.includes('継続ダメージュ'))).toBe(
        true
      )
      expect(msgs().some((m) => m.includes('[状態 ]') && m.includes('id が空'))).toBe(true)
      const master = collectMasterData(doc)
      expect(master.statuses.dup.name).toBe('に') // 後勝ち
      expect(msgs().filter((m) => m.includes('[状態 dup]') && m.includes('重複'))).toHaveLength(1)
      expect(master.statuses.noname).toBeUndefined()
    } finally {
      warn.mockRestore()
    }
  })
  it('正しい宣言は何も警告しない', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      collectMasterData(await parseMarkdown(MD))
      expect(warn.mock.calls.filter((c) => String(c[0]).includes('状態'))).toEqual([])
    } finally {
      warn.mockRestore()
    }
  })
})
