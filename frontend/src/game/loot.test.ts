/** 敵の戦利品の解釈と抽選 (#831) の純粋関数 */
import { describe, expect, it } from 'vitest'
import { parseMarkdown } from '../wasm/parser'
import { collectMasterData } from './rpgProjectFromDoc'
import { rollEncounter } from './encounter'
import { BattleEngine } from './battleEngine'
import {
  attemptSteal,
  DEFAULT_RARE_RATE,
  itemNamesOf,
  lootField,
  MAX_LOOT_COUNT,
  parseLootLine,
  parseLootSpec,
  parseStealLimit,
  rollDrops,
  summarizeLoot,
  type LootSpec,
} from './loot'

/** 呼ばれた回数を数える固定列の乱数 */
function seq(values: number[]) {
  let n = 0
  const rng = () => values[n++ % values.length]
  return { rng, calls: () => n }
}

function spec(over: Partial<LootSpec> = {}): LootSpec {
  return {
    drops: [],
    steal: [{ itemId: 'potion', chance: 100, count: 1 }],
    stealRare: [{ itemId: 'elixir', chance: 100, count: 1 }],
    stealLimit: 1,
    warnings: [],
    ...over,
  }
}

describe('parseLootLine', () => {
  it('id だけの行は確率 100・個数 1', () => {
    expect(parseLootLine('potion')).toEqual({ line: { itemId: 'potion', chance: 100, count: 1 } })
  })

  it('確率・個数（別名つき）と小数の確率を読む', () => {
    expect(parseLootLine('ether 確率=12.5 個数=3').line).toEqual({
      itemId: 'ether',
      chance: 12.5,
      count: 3,
    })
    expect(parseLootLine('ether chance=0 count=2').line).toEqual({
      itemId: 'ether',
      chance: 0,
      count: 2,
    })
  })

  it('確率が数でない行は行ごと捨てる（誤記で必ず手に入る行にならない）', () => {
    for (const bad of ['potion 確率=abc', 'potion 確率=', 'potion 確率=-5', 'potion 確率=1e2']) {
      const r = parseLootLine(bad)
      expect(r.line, bad).toBeUndefined()
      expect(r.warning, bad).toBeTruthy()
    }
  })

  it('確率 100 超は 100、個数の不正は 1・上限超は上限に直して警告する', () => {
    expect(parseLootLine('p 確率=150').line?.chance).toBe(100)
    expect(parseLootLine('p 確率=150').warning).toContain('100')
    expect(parseLootLine('p 個数=0').line?.count).toBe(1)
    expect(parseLootLine('p 個数=x').line?.count).toBe(1)
    expect(parseLootLine('p 個数=1000').line?.count).toBe(MAX_LOOT_COUNT)
  })

  it('id が無い行・空の行・未知の指定', () => {
    expect(parseLootLine('確率=50').line).toBeUndefined()
    expect(parseLootLine('   ').line).toBeUndefined()
    const r = parseLootLine('potion 重さ=3')
    expect(r.line?.itemId).toBe('potion')
    expect(r.warning).toContain('重さ=3')
  })
})

describe('parseStealLimit', () => {
  it('省略は 1、数・無限・不正', () => {
    expect(parseStealLimit(undefined).limit).toBe(1)
    expect(parseStealLimit('2').limit).toBe(2)
    expect(parseStealLimit('無限').limit).toBe(Infinity)
    expect(parseStealLimit('inf').limit).toBe(Infinity)
    expect(parseStealLimit('0').limit).toBe(1)
    expect(parseStealLimit('0').warning).toBeTruthy()
    expect(parseStealLimit('abc').limit).toBe(1)
    expect(parseStealLimit('1000').limit).toBe(99)
  })
})

describe('parseLootSpec', () => {
  it('宣言が無い・全欄が空は null（戦利品なし）', () => {
    expect(parseLootSpec(undefined)).toBeNull()
    expect(parseLootSpec({})).toBeNull()
    expect(parseLootSpec({ drops: [], steal: [] })).toBeNull()
  })

  it('取れる行だけ残し、不正な行は警告に回す', () => {
    const s = parseLootSpec({
      drops: ['potion 確率=25', 'x 確率=zz'],
      steal: ['ether'],
      stealRare: ['elixir'],
      stealLimit: '2',
    })
    expect(s?.drops).toEqual([{ itemId: 'potion', chance: 25, count: 1 }])
    expect(s?.steal.map((l) => l.itemId)).toEqual(['ether'])
    expect(s?.stealRare.map((l) => l.itemId)).toEqual(['elixir'])
    expect(s?.stealLimit).toBe(2)
    expect(s?.warnings).toHaveLength(1)
  })

  it('不正な行しかなくても警告つきの空の仕様を返す（警告を出すため）', () => {
    const s = parseLootSpec({ drops: ['x 確率=zz'] })
    expect(s).not.toBeNull()
    expect(s?.drops).toEqual([])
    expect(s?.warnings.length).toBeGreaterThan(0)
  })
})

describe('rollDrops', () => {
  it('行ごとに独立。確率 100 と 0 は乱数を使わない', () => {
    const s = spec({
      drops: [
        { itemId: 'a', chance: 100, count: 1 },
        { itemId: 'b', chance: 0, count: 1 },
        { itemId: 'c', chance: 50, count: 2 },
      ],
    })
    const r = seq([0.49])
    expect(rollDrops(s, r.rng).map((l) => l.itemId)).toEqual(['a', 'c'])
    expect(r.calls()).toBe(1)
    const r2 = seq([0.5])
    expect(rollDrops(s, r2.rng).map((l) => l.itemId)).toEqual(['a'])
  })

  it('ドロップの無い仕様は乱数を使わない', () => {
    const r = seq([0.1])
    expect(rollDrops(spec(), r.rng)).toEqual([])
    expect(r.calls()).toBe(0)
  })
})

describe('attemptSteal', () => {
  it('既定: 必中で乱数を使わず、レア枠がある敵は DEFAULT_RARE_RATE で判定する', () => {
    const r = seq([0.1])
    const out = attemptSteal(spec(), 0, {}, r.rng)
    // 0.1 < 0.125 → レア枠
    expect(out).toMatchObject({ kind: 'got', rare: true })
    expect(r.calls()).toBe(1)
    const r2 = seq([DEFAULT_RARE_RATE / 100])
    expect(attemptSteal(spec(), 0, {}, r2.rng)).toMatchObject({ kind: 'got', rare: false })
  })

  it('レア枠を持たない敵は乱数を使わず通常枠', () => {
    const r = seq([0.0])
    const out = attemptSteal(spec({ stealRare: [] }), 0, {}, r.rng)
    expect(out).toMatchObject({ kind: 'got', rare: false, line: { itemId: 'potion' } })
    expect(r.calls()).toBe(0)
  })

  it('成功判定: 確率 60 で 0.6 以上は失敗（miss）、盗める回数は呼び出し側が数える', () => {
    const r = seq([0.6])
    expect(attemptSteal(spec(), 0, { chance: 60 }, r.rng)).toEqual({ kind: 'miss' })
    const r2 = seq([0.59, 0.99])
    expect(attemptSteal(spec(), 0, { chance: 60 }, r2.rng)).toMatchObject({ kind: 'got' })
  })

  it('確率 100 は必中（乱数なし）、0 は必ず外れ（乱数なし）', () => {
    const r = seq([0.99])
    expect(attemptSteal(spec({ stealRare: [] }), 0, { chance: 100 }, r.rng).kind).toBe('got')
    expect(attemptSteal(spec({ stealRare: [] }), 0, { chance: 0 }, r.rng).kind).toBe('miss')
    expect(r.calls()).toBe(0)
  })

  it('在庫（ぬすむ回数）に達した敵・その枠を持たない敵は empty で乱数を使わない', () => {
    const r = seq([0.1])
    expect(attemptSteal(spec(), 1, { chance: 50 }, r.rng)).toEqual({ kind: 'empty' })
    expect(attemptSteal(spec({ stealLimit: 2 }), 1, {}, seq([0.5]).rng).kind).toBe('got')
    expect(attemptSteal(spec({ stealLimit: Infinity }), 999, {}, seq([0.5]).rng).kind).toBe('got')
    expect(attemptSteal(spec({ steal: [], stealRare: [] }), 0, {}, r.rng)).toEqual({
      kind: 'empty',
    })
    expect(attemptSteal(spec({ stealRare: [] }), 0, { slot: 'rare' }, r.rng)).toEqual({
      kind: 'empty',
    })
    expect(attemptSteal(spec({ steal: [] }), 0, { slot: 'normal' }, r.rng)).toEqual({
      kind: 'empty',
    })
    expect(r.calls()).toBe(0)
  })

  it('枠=レア: レア率の既定は 100（乱数なし）。レア率を下げると外れて miss', () => {
    const r = seq([0.99])
    expect(attemptSteal(spec(), 0, { slot: 'rare' }, r.rng)).toMatchObject({
      kind: 'got',
      rare: true,
      line: { itemId: 'elixir' },
    })
    expect(r.calls()).toBe(0)
    expect(attemptSteal(spec(), 0, { slot: 'rare', rareRate: 40 }, seq([0.4]).rng)).toEqual({
      kind: 'miss',
    })
    expect(attemptSteal(spec(), 0, { slot: 'rare', rareRate: 40 }, seq([0.39]).rng)).toMatchObject({
      kind: 'got',
      rare: true,
    })
  })

  it('枠=通常: レア枠は見ない', () => {
    const r = seq([0.0])
    expect(attemptSteal(spec(), 0, { slot: 'normal' }, r.rng)).toMatchObject({
      kind: 'got',
      rare: false,
    })
    expect(r.calls()).toBe(0)
  })

  it('枠の中の行は先頭から順に判定し、最初に当たった 1 行', () => {
    const s = spec({
      steal: [
        { itemId: 'a', chance: 30, count: 1 },
        { itemId: 'b', chance: 100, count: 2 },
      ],
      stealRare: [],
    })
    expect(attemptSteal(s, 0, {}, seq([0.29]).rng)).toMatchObject({ line: { itemId: 'a' } })
    expect(attemptSteal(s, 0, {}, seq([0.3]).rng)).toMatchObject({
      line: { itemId: 'b', count: 2 },
    })
    // 当たる行が無ければ miss
    const only = spec({ steal: [{ itemId: 'a', chance: 30, count: 1 }], stealRare: [] })
    expect(attemptSteal(only, 0, {}, seq([0.9]).rng)).toEqual({ kind: 'miss' })
  })

  it('使い手の加算: 確率を書いたときだけ効き、載ったときだけ 99 で頭打ち', () => {
    // 確率 60 + 加算 50 → 99%。0.98 は成功、0.99 は失敗
    expect(
      attemptSteal(spec({ stealRare: [] }), 0, { chance: 60, chanceBonus: 50 }, seq([0.98]).rng)
        .kind
    ).toBe('got')
    expect(
      attemptSteal(spec({ stealRare: [] }), 0, { chance: 60, chanceBonus: 50 }, seq([0.99]).rng)
        .kind
    ).toBe('miss')
    // 加算なしの確率 100 は必中（頭打ちに掛からない）
    expect(attemptSteal(spec({ stealRare: [] }), 0, { chance: 100 }, seq([0.999]).rng).kind).toBe(
      'got'
    )
    // 確率を書かない（必中）なら加算は無視
    const r = seq([0.5])
    expect(attemptSteal(spec({ stealRare: [] }), 0, { chanceBonus: -50 }, r.rng).kind).toBe('got')
    expect(r.calls()).toBe(0)
    // NaN の加算は 0
    expect(
      attemptSteal(spec({ stealRare: [] }), 0, { chance: 60, chanceBonus: NaN }, seq([0.59]).rng)
        .kind
    ).toBe('got')
    // レア率への加算
    expect(attemptSteal(spec(), 0, { rareBonus: 30 }, seq([0.42]).rng)).toMatchObject({
      rare: true,
    })
    expect(attemptSteal(spec(), 0, { rareBonus: 30 }, seq([0.43]).rng)).toMatchObject({
      rare: false,
    })
  })
})

describe('lootField / itemNamesOf / summarizeLoot', () => {
  it('lootField: 無い・空は {}、あれば複製して渡す', () => {
    expect(lootField(undefined)).toEqual({})
    expect(lootField({})).toEqual({})
    expect(lootField({ drops: [], stealLimit: '  ' })).toEqual({})
    const src = { drops: ['a'], stealRare: ['b'], stealLimit: '2' }
    const out = lootField(src)
    expect(out).toEqual({ loot: { drops: ['a'], stealRare: ['b'], stealLimit: '2' } })
    expect((out as { loot: { drops: string[] } }).loot.drops).not.toBe(src.drops)
  })

  it('itemNamesOf: 名前のあるものだけ。マスターが無ければ undefined', () => {
    expect(itemNamesOf(undefined)).toBeUndefined()
    expect(itemNamesOf({})).toBeUndefined()
    expect(itemNamesOf({ potion: { name: 'ポーション' }, x: { name: '' } })).toEqual({
      potion: 'ポーション',
    })
  })

  it('summarizeLoot: id ごとに個数を足し、初めて出た順', () => {
    const e = (itemId: string, count: number) => ({
      itemId,
      count,
      via: 'drop' as const,
      rare: false,
      enemyId: 'e',
      enemyName: 'E',
    })
    expect(summarizeLoot([e('b', 1), e('a', 2), e('b', 3)])).toEqual([
      { itemId: 'b', count: 4 },
      { itemId: 'a', count: 2 },
    ])
    expect(summarizeLoot([])).toEqual([])
  })
})

describe('実 WASM パーサ → 戦闘への組み立て → 戦闘 (#831)', () => {
  it('ドロップ / ぬすむ / ぬすむレア / ぬすむ回数 が MonsterDef.loot → BattleEntity.loot に写り、書かない敵は loot を持たない', async () => {
    const doc = await parseMarkdown(
      [
        '---',
        'engine: name-name',
        'chapter: 1',
        'title: t',
        '---',
        '',
        '## data: マスター',
        '',
        '[モンスター thief]',
        '名前: どろぼう',
        'HP: 10',
        'ドロップ: potion 確率=100 個数=2',
        'ぬすむ: potion 確率=80',
        'ぬすむレア: elixir',
        'ぬすむ回数: 無限',
        '[/モンスター]',
        '',
        '[モンスター plain]',
        '名前: ふつう',
        'HP: 5',
        '[/モンスター]',
        '',
      ].join('\n')
    )
    const m = collectMasterData(doc)
    expect(m.monsters['thief'].loot).toEqual({
      drops: ['potion 確率=100 個数=2'],
      steal: ['potion 確率=80'],
      stealRare: ['elixir'],
      stealLimit: '無限',
    })
    expect('loot' in m.monsters['plain']).toBe(false)
    const [t, p] = rollEncounter({
      rate: 1,
      groups: ['thief+plain'],
      masters: m.monsters,
      rng: () => 0,
    })!
    expect(t.loot).toEqual(m.monsters['thief'].loot)
    expect(t.loot).not.toBe(m.monsters['thief'].loot)
    expect('loot' in p).toBe(false)
    // 実パース経路の敵から実際に盗む
    const hero = {
      id: 'hero',
      name: 'ゆうしゃ',
      hp: 999,
      maxHp: 999,
      mp: 0,
      maxMp: 0,
      atk: 1,
      def: 99,
      agi: 1,
    }
    const e = new BattleEngine([hero], [t, p], { rng: () => 0.5 })
    e.selectSpell({ name: 'ぬすむ', mp: 0, target: '敵単体', effect: 'steal 枠=通常' })
    e.selectSpell({ name: 'ぬすむ', mp: 0, target: '敵単体', effect: 'steal 枠=通常' })
    expect(e.getState().loot?.map((l) => [l.itemId, l.enemyId])).toEqual([
      ['potion', 'thief'],
      ['potion', 'thief'],
    ])
  })
})
