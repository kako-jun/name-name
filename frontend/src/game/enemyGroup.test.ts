import { describe, it, expect, vi } from 'vitest'
import {
  parseEncounterGroup,
  pickGroupIndex,
  resolveEncounterGroup,
  ENCOUNTER_ITEM_MAX_COUNT,
} from './enemyGroup'
import { rollEncounter } from './encounter'
import { placeEnemies } from './enemyGrid'
import type { MonsterDef } from '../types'

const mk = (id: string): MonsterDef => ({
  id,
  name: id,
  hp: 1,
  mp: 0,
  atk: 1,
  def: 1,
  agi: 1,
  exp: 1,
  gold: 1,
})
const masters = { a: mk('a'), b: mk('b'), c: mk('c') }

/** 値列を順に返し、消費回数を数える rng */
function seq(values: number[]) {
  let n = 0
  const rng = () => values[Math.min(n++, values.length - 1)]
  return { rng, count: () => n }
}

describe('parseEncounterGroup', () => {
  it('修飾なしの既存書式は従来どおり（+ 連結・空白・空項）', () => {
    const g = parseEncounterGroup(' a + b++c ')
    expect(g.items.map((i) => [i.id, i.min, i.max, i.ranged])).toEqual([
      ['a', 1, 1, false],
      ['b', 1, 1, false],
      ['c', 1, 1, false],
    ])
    expect(g.weight).toBeUndefined()
    expect(g.warnings).toEqual([])
  })
  it('空文字は項なし', () => {
    expect(parseEncounterGroup('').items).toEqual([])
  })
  it('配置・個数・範囲・重み', () => {
    const g = parseEncounterGroup('boss@C1+bit*2@E1+slime*1..3+x*0..2:2')
    expect(g.weight).toBe(2)
    expect(g.items).toEqual([
      { id: 'boss', min: 1, max: 1, ranged: false, at: { col: 2, row: 0 } },
      { id: 'bit', min: 2, max: 2, ranged: false, at: { col: 4, row: 0 } },
      { id: 'slime', min: 1, max: 3, ranged: true },
      { id: 'x', min: 0, max: 2, ranged: true },
    ])
    expect(g.warnings).toEqual([])
  })
  it('構文エラーの項だけ捨てて警告する', () => {
    const g = parseEncounterGroup('a+b*0+c*3..1+d@+e@1A+f*x+g*49+h@c1')
    expect(g.items.map((i) => i.id)).toEqual(['a', 'h'])
    expect(g.warnings).toHaveLength(6)
  })
  it('個数の上限ちょうどは通る', () => {
    expect(parseEncounterGroup(`a*${ENCOUNTER_ITEM_MAX_COUNT}`).items).toHaveLength(1)
  })
  it('有効な項が無い群は警告する（重みだけ・項が全部捨てられた）', () => {
    expect(parseEncounterGroup(':2').warnings.some((w) => w.includes('有効な項が無い'))).toBe(true)
    const g = parseEncounterGroup('a:2:3')
    expect(g.items).toEqual([])
    expect(g.weight).toBe(3)
    expect(g.warnings.some((w) => w.includes('有効な項が無い'))).toBe(true)
    expect(parseEncounterGroup('').warnings).toEqual([])
  })
  it('全角の修飾記号・数字・セルを受理する（id 本体は正規化しない）', () => {
    const g = parseEncounterGroup('boss＠Ｃ１＋x')
    // 全角プラスは連結記号ではないので boss＠Ｃ１＋x 全体が1項（修飾部が不正）→ 捨てる
    expect(g.items).toEqual([])
    const h = parseEncounterGroup('bit＊２＠Ｅ１+s＊１．．３：２')
    expect(h.weight).toBe(2)
    expect(h.items).toEqual([
      { id: 'bit', min: 2, max: 2, ranged: false, at: { col: 4, row: 0 } },
      { id: 's', min: 1, max: 3, ranged: true },
    ])
    expect(parseEncounterGroup('ｓｌｉｍｅ').items[0].id).toBe('ｓｌｉｍｅ')
  })
  it('id に . を含んでよい', () => {
    expect(parseEncounterGroup('a.b*2').items[0]).toMatchObject({ id: 'a.b', min: 2 })
  })
  it('不正な重みは無視して警告（項は残る）', () => {
    for (const bad of [':0', ':x', ':1.5', ':-1', ':', ':99999999999999999999']) {
      const g = parseEncounterGroup(`a${bad}`)
      expect(g.weight).toBeUndefined()
      expect(g.items).toHaveLength(1)
      expect(g.warnings).toHaveLength(1)
    }
  })
})

describe('pickGroupIndex', () => {
  it('重み未指定は Math.floor(rng()*n) で rng 1 回', () => {
    for (const r of [0, 0.3, 0.5, 0.99999]) {
      const s = seq([r])
      expect(pickGroupIndex([undefined, undefined, undefined], s.rng)).toBe(Math.floor(r * 3))
      expect(s.count()).toBe(1)
    }
  })
  it('重みがあれば累積重みの境界で選ぶ（rng 1 回）', () => {
    // 重み 1,3 → 境界 0.25
    expect(pickGroupIndex([undefined, 3], () => 0.2499)).toBe(0)
    expect(pickGroupIndex([undefined, 3], () => 0.25)).toBe(1)
    expect(pickGroupIndex([undefined, 3], () => 0.9999)).toBe(1)
    const s = seq([0.5])
    pickGroupIndex([2, 2], s.rng)
    expect(s.count()).toBe(1)
  })
  it('rng が 1 を返しても範囲外にならない', () => {
    expect(pickGroupIndex([1, 1], () => 1)).toBe(1)
  })
})

describe('resolveEncounterGroup', () => {
  it('固定個数は rng を消費しない', () => {
    const s = seq([0.5])
    expect(resolveEncounterGroup(parseEncounterGroup('a*3+b'), s.rng).map((e) => e.id)).toEqual([
      'a',
      'a',
      'a',
      'b',
    ])
    expect(s.count()).toBe(0)
  })
  it('範囲ごとに rng を 1 回ずつ消費し、境界値を取る', () => {
    const g = parseEncounterGroup('a*1..3+b*2..4')
    expect(resolveEncounterGroup(g, () => 0).map((e) => e.id)).toEqual(['a', 'b', 'b'])
    expect(resolveEncounterGroup(g, () => 0.9999).map((e) => e.id)).toEqual([
      'a',
      'a',
      'a',
      'b',
      'b',
      'b',
      'b',
    ])
    const s = seq([0, 0])
    resolveEncounterGroup(g, s.rng)
    expect(s.count()).toBe(2)
  })
  it('配置は最初の 1 体だけ、placeEnemies に渡せる形', () => {
    const r = resolveEncounterGroup(parseEncounterGroup('bit*2@E1'), () => 0)
    expect(r).toEqual([{ id: 'bit', at: { col: 4, row: 0 } }, { id: 'bit' }])
    const res = placeEnemies(
      { cols: 6, rows: 2 },
      r.map((e) => ({ w: 1, h: 1, ...(e.at ? { at: e.at } : {}) }))
    )
    expect(res.errors).toEqual([])
    expect(res.cells[0]).toEqual({ col: 4, row: 0 })
  })
  it('全体 0 体なら 1 回だけ振り直す', () => {
    const g = parseEncounterGroup('a*0..1')
    const s = seq([0, 0.9])
    expect(resolveEncounterGroup(g, s.rng).map((e) => e.id)).toEqual(['a'])
    expect(s.count()).toBe(2)
    const s2 = seq([0, 0, 0.9])
    expect(resolveEncounterGroup(g, s2.rng)).toEqual([])
    expect(s2.count()).toBe(2)
  })
  it('範囲なしで 0 体（項なし）は振り直さない', () => {
    const s = seq([0.5])
    expect(resolveEncounterGroup(parseEncounterGroup(''), s.rng)).toEqual([])
    expect(s.count()).toBe(0)
  })
})

describe('rollEncounter: 群の書式 (#839 段2)', () => {
  const ids = (r: ReturnType<typeof rollEncounter>) => r?.map((e) => e.id)
  it('回帰: 重みなしは現行と同じ結果・同じ rng 消費回数', () => {
    const groups = ['a', 'b+c', 'c+c']
    for (const r of [0, 0.2, 0.34, 0.5, 0.67, 0.99]) {
      const s = seq([0, r])
      const out = rollEncounter({ rate: 1, groups, masters, rng: s.rng })
      const legacy = groups[Math.floor(r * groups.length)].split('+')
      expect(ids(out)).toEqual(legacy)
      expect(s.count()).toBe(2)
    }
  })
  it('回帰: k/n ちょうどと k/n-ε の境界値・未知id・constructor・空項を含むシード固定ランダム', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    // 旧実装の式を参照実装として持つ
    const legacyIds = (spec: string) =>
      spec
        .split('+')
        .map((x) => x.trim())
        .filter(Boolean)
    const legacyRoll = (groups: string[], r: number) => {
      const ids = legacyIds(groups[Math.floor(r * groups.length)]).filter((id) =>
        Object.prototype.hasOwnProperty.call(masters, id)
      )
      return ids.length > 0 ? ids : null
    }
    const check = (groups: string[], r: number) => {
      const s = seq([0, r])
      const out = rollEncounter({ rate: 1, groups, masters, rng: s.rng })
      expect(out?.map((e) => e.id) ?? null).toEqual(legacyRoll(groups, r))
      expect(s.count()).toBe(2)
    }
    const groups = ['a', 'b+c', 'constructor', 'zzz+ a ++b', 'c+c']
    const n = groups.length
    for (let k = 0; k <= n; k++) {
      if (k < n) check(groups, k / n)
      if (k > 0) check(groups, k / n - Number.EPSILON)
      if (k > 0) check(groups, (k - 0.01) / n)
    }
    let state = 12345
    const lcg = () => (state = (state * 1664525 + 1013904223) % 4294967296) / 4294967296
    for (let i = 0; i < 300; i++) check(groups.slice(0, 1 + (i % n)), lcg())
    warn.mockRestore()
  })
  it('構文エラー項の警告は console.warn で出る', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    rollEncounter({ rate: 1, groups: ['a+b*0'], masters, rng: () => 0 })
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0][0])).toContain("'b*0'")
    warn.mockRestore()
  })
  it('重みつきは rng 2 回（当選判定＋抽選）。重みの比で選ぶ', () => {
    const groups = ['a', 'b:3']
    const s = seq([0, 0.3])
    expect(ids(rollEncounter({ rate: 1, groups, masters, rng: s.rng }))).toEqual(['b'])
    expect(s.count()).toBe(2)
    expect(ids(rollEncounter({ rate: 1, groups, masters, rng: seq([0, 0.1]).rng }))).toEqual(['a'])
  })
  it('個数の幅は群を選んだ後に範囲ごと 1 回ずつ消費', () => {
    const s = seq([0, 0, 0.99])
    expect(ids(rollEncounter({ rate: 1, groups: ['a*1..3'], masters, rng: s.rng }))).toEqual([
      'a',
      'a',
      'a',
    ])
    expect(s.count()).toBe(3)
  })
  it('構文エラーの項だけ捨てる。全部捨てたら不発', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(ids(rollEncounter({ rate: 1, groups: ['a+b*0'], masters, rng: () => 0 }))).toEqual(['a'])
    expect(rollEncounter({ rate: 1, groups: ['b*0'], masters, rng: () => 0 })).toBeNull()
    warn.mockRestore()
  })
  it('未知 id は従来どおり警告して飛ばす', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(ids(rollEncounter({ rate: 1, groups: ['zzz*2+a'], masters, rng: () => 0 }))).toEqual([
      'a',
    ])
    expect(warn).toHaveBeenCalledTimes(2)
    warn.mockRestore()
  })
})
