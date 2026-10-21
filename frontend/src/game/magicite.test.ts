/** 魔石 (#889) の純関数: ボーナスの書式・装備の解決・属性の層と耐性・成長・召喚の実行内容・戦闘の味方への反映 */
import { describe, expect, it, vi } from 'vitest'
import type { MagiciteDef } from '../types'
import {
  DEFAULT_MAGICITE_SLOTS,
  MAX_BONUS_VALUE,
  MAX_ELEMENT_LAYERS,
  MAX_MAGICITE_SLOTS,
  addBonus,
  applyLevelUp,
  applyMemberMagicite,
  defaultSummonMessage,
  elementLayers,
  equipBonusOf,
  isEmptyBonus,
  layersToAffinity,
  levelUpBonus,
  parseStatBonus,
  resolveEquipped,
  resolveMemberMagicite,
  slotCount,
  summonEntries,
  toSummonExecution,
  totalEquipBonus,
} from './magicite'
import type { BattleEntity } from './spellDsl'

const stone = (over: Partial<MagiciteDef> & { id: string }): MagiciteDef => ({
  name: over.id,
  target: '相手単体',
  ...over,
})

const MASTER: Record<string, MagiciteDef> = {
  sea: stone({
    id: 'sea',
    name: 'うみ',
    summon: 'うみの主',
    elements: ['water'],
    equipBonus: 'hp+30, atk+2',
    growth: 'hp+3',
  }),
  sea2: stone({ id: 'sea2', elements: ['water'] }),
  tiger: stone({ id: 'tiger', elements: ['fire'], mp: 5, equipBonus: 'atk+6', growth: 'atk+1' }),
  ice: stone({ id: 'ice', elements: ['ice'] }),
  only: stone({ id: 'only', elements: ['wind'], equippableBy: ['mage'] }),
  plain: stone({ id: 'plain' }),
}

function ent(over: Partial<BattleEntity> = {}): BattleEntity {
  return {
    id: 'a',
    name: 'A',
    hp: 50,
    maxHp: 50,
    mp: 10,
    maxMp: 10,
    atk: 10,
    def: 5,
    agi: 4,
    ...over,
  }
}

describe('parseStatBonus', () => {
  it('カンマ・空白区切りで能力値を読む（日本語名・全角記号も可）', () => {
    expect(parseStatBonus('atk+3, hp+20 def-1').bonus).toEqual({ atk: 3, hp: 20, def: -1 })
    expect(parseStatBonus('攻撃＋4、守備－2，素早さ+1').bonus).toEqual({ atk: 4, def: -2, agi: 1 })
    expect(parseStatBonus('ATK+3, Mp+2').bonus).toEqual({ atk: 3, mp: 2 })
  })
  it('同じ能力値は足し合わせ、0 になっても空ボーナス扱い', () => {
    expect(parseStatBonus('atk+3, atk+2').bonus).toEqual({ atk: 5 })
    expect(isEmptyBonus(parseStatBonus('atk+3, atk-3').bonus)).toBe(true)
  })
  it('読めない項目は警告して無視し、残りは生かす', () => {
    const r = parseStatBonus('xx+3, atk+, hp+1.5, def+2, 3, atk3, constructor+1, toString-2')
    expect(r.bonus).toEqual({ def: 2 })
    expect(r.warnings).toHaveLength(7)
    expect(r.warnings[0]).toContain('xx+3')
  })
  it('値は ±MAX_BONUS_VALUE に丸める', () => {
    expect(parseStatBonus('hp+99999999').bonus.hp).toBe(MAX_BONUS_VALUE)
    expect(parseStatBonus('hp-99999999').bonus.hp).toBe(-MAX_BONUS_VALUE)
    expect(parseStatBonus('hp+9999, hp+9999').bonus.hp).toBe(MAX_BONUS_VALUE)
  })
  it('空・未指定は空のボーナス', () => {
    expect(parseStatBonus(undefined)).toEqual({ bonus: {}, warnings: [] })
    expect(parseStatBonus('  ')).toEqual({ bonus: {}, warnings: [] })
    expect(isEmptyBonus(undefined)).toBe(true)
  })
})

describe('装備時ボーナスと成長', () => {
  it('equipBonusOf / totalEquipBonus: 魔石ごとの装備時を合計する', () => {
    expect(equipBonusOf(MASTER.sea)).toEqual({ hp: 30, atk: 2 })
    expect(equipBonusOf(MASTER.plain)).toEqual({})
    expect(totalEquipBonus([MASTER.sea, MASTER.tiger])).toEqual({ hp: 30, atk: 8 })
    expect(totalEquipBonus([])).toEqual({})
  })
  it('addBonus は入力を変えず、上限で止める', () => {
    const a = { hp: 9000 }
    const sum = addBonus(a, { hp: 9000, atk: 1 })
    expect(sum).toEqual({ hp: MAX_BONUS_VALUE, atk: 1 })
    expect(a).toEqual({ hp: 9000 })
  })
  it('levelUpBonus: 装備中の魔石の成長を levels 回ぶん足す（0 以下・非有限は 0 回）', () => {
    expect(levelUpBonus([MASTER.sea, MASTER.tiger])).toEqual({ hp: 3, atk: 1 })
    expect(levelUpBonus([MASTER.sea], 3)).toEqual({ hp: 9 })
    expect(levelUpBonus([MASTER.sea], 2.9)).toEqual({ hp: 6 })
    expect(levelUpBonus([MASTER.sea], 0)).toEqual({})
    expect(levelUpBonus([MASTER.sea], -1)).toEqual({})
    expect(levelUpBonus([MASTER.sea], Number.NaN)).toEqual({})
    expect(levelUpBonus([MASTER.plain], 5)).toEqual({})
  })
  it('applyLevelUp: 累計に足した新しい累計を返す。魔石を変えても上がった分は残る', () => {
    let g = applyLevelUp({}, 'a', [MASTER.sea])
    expect(g).toEqual({ a: { hp: 3 } })
    // 魔石を tiger に替えてレベルアップ: hp+3 は残り、atk+1 が増える
    g = applyLevelUp(g, 'a', [MASTER.tiger])
    expect(g).toEqual({ a: { hp: 3, atk: 1 } })
    // 外して（成長なし）レベルアップしても、これまでの分は残る
    const g2 = applyLevelUp(g, 'a', [])
    expect(g2).toEqual({ a: { hp: 3, atk: 1 } })
    expect(g2).not.toBe(g)
    // 別の味方は別の累計
    expect(applyLevelUp(g, 'b', [MASTER.sea])).toEqual({ a: { hp: 3, atk: 1 }, b: { hp: 3 } })
  })
  it('applyLevelUp は入力を書き換えない', () => {
    const g = { a: { hp: 1 } }
    applyLevelUp(g, 'a', [MASTER.sea])
    expect(g).toEqual({ a: { hp: 1 } })
  })
  it('味方 id が __proto__ でも汚染しない', () => {
    const g = applyLevelUp({}, '__proto__', [MASTER.sea])
    expect(Object.getPrototypeOf(g)).toBe(Object.prototype)
    expect(Object.prototype.hasOwnProperty.call(g, '__proto__')).toBe(true)
  })
})

describe('魔石枠と装備の解決', () => {
  it('slotCount: 省略は 1、負・非整数・非有限は丸め、上限で頭打ち', () => {
    expect(slotCount({})).toBe(DEFAULT_MAGICITE_SLOTS)
    expect(slotCount({ magiciteSlots: 3 })).toBe(3)
    expect(slotCount({ magiciteSlots: 0 })).toBe(0)
    expect(slotCount({ magiciteSlots: -2 })).toBe(0)
    expect(slotCount({ magiciteSlots: 2.9 })).toBe(2)
    expect(slotCount({ magiciteSlots: Number.NaN })).toBe(DEFAULT_MAGICITE_SLOTS)
    expect(slotCount({ magiciteSlots: 99999 })).toBe(MAX_MAGICITE_SLOTS)
  })
  it('書いた順に枠が埋まり、枠を超える分は警告して捨てる', () => {
    const r = resolveEquipped({ id: 'a', magicites: ['sea', 'tiger'], magiciteSlots: 1 }, MASTER)
    expect(r.stones.map((s) => s.id)).toEqual(['sea'])
    expect(r.warnings).toEqual(["a: 魔石枠 1 を超えるため 'tiger' は装備できない"])
    const two = resolveEquipped({ id: 'a', magicites: ['sea', 'tiger'], magiciteSlots: 2 }, MASTER)
    expect(two.stones.map((s) => s.id)).toEqual(['sea', 'tiger'])
    expect(two.warnings).toEqual([])
  })
  it('宣言の無い id・重複・装備可に無い味方は警告して捨てる（枠は消費しない）', () => {
    const r = resolveEquipped(
      { id: 'a', magicites: ['nope', 'sea', 'sea', 'only', 'tiger'], magiciteSlots: 2 },
      MASTER
    )
    expect(r.stones.map((s) => s.id)).toEqual(['sea', 'tiger'])
    expect(r.warnings.map((w) => w.split('魔石 ')[1]?.split(' ')[0] ?? w)).toEqual([
      "'nope'",
      "'sea'",
      "'only'",
    ])
    // 装備可に入っている味方は装備できる
    const mage = resolveEquipped({ id: 'mage', magicites: ['only'] }, MASTER)
    expect(mage.stones.map((s) => s.id)).toEqual(['only'])
  })
  it('魔石のマスターが無い・枠 0・装備なしは空。ids の指定は def.magicites を上書きする', () => {
    expect(resolveEquipped({ id: 'a', magicites: ['sea'] }, undefined).stones).toEqual([])
    expect(
      resolveEquipped({ id: 'a', magicites: ['sea'], magiciteSlots: 0 }, MASTER).stones
    ).toEqual([])
    expect(resolveEquipped({ id: 'a' }, MASTER)).toEqual({ stones: [], warnings: [] })
    expect(
      resolveEquipped({ id: 'a', magicites: ['sea'] }, MASTER, ['tiger']).stones.map((s) => s.id)
    ).toEqual(['tiger'])
    expect(resolveEquipped({ id: 'a', magicites: ['sea'] }, MASTER, []).stones).toEqual([])
  })
  it('id が Object.prototype のメンバー名でも装備できない（own-property のみ）', () => {
    const r = resolveEquipped({ id: 'a', magicites: ['constructor', 'toString'] }, MASTER)
    expect(r.stones).toEqual([])
    expect(r.warnings).toHaveLength(2)
  })
})

describe('属性の層と耐性', () => {
  it('魔石の属性 → 他の出どころの順に積み、合計 MAX_ELEMENT_LAYERS まで', () => {
    expect(MAX_ELEMENT_LAYERS).toBe(2)
    expect(elementLayers([MASTER.sea], ['fire']).layers).toEqual(['water', 'fire'])
    expect(elementLayers([MASTER.sea, MASTER.tiger], ['ice']).layers).toEqual(['water', 'fire'])
    expect(elementLayers([MASTER.sea, MASTER.tiger], ['ice']).warnings).toEqual([
      "属性は魔石と防具を合わせて 2 つまでのため 'ice' は無視した",
    ])
    expect(elementLayers([], ['fire']).layers).toEqual(['fire'])
    expect(elementLayers([MASTER.plain]).layers).toEqual([])
  })
  it('stoneLayerCount は上限を適用した後の魔石由来の層の数（防具の層は含めない）', () => {
    expect(elementLayers([MASTER.sea], ['fire']).stoneLayerCount).toBe(1)
    expect(elementLayers([MASTER.sea, MASTER.tiger], ['ice']).stoneLayerCount).toBe(2)
    expect(elementLayers([], ['fire', 'ice']).stoneLayerCount).toBe(0)
    expect(elementLayers([MASTER.plain], ['fire']).stoneLayerCount).toBe(0)
  })
  it('属性 id は正規化する（全角・大文字）。空は無視。同じ属性 2 層は有効', () => {
    expect(elementLayers([], ['ＷＡＴＥＲ', ' Water ', '']).layers).toEqual(['water', 'water'])
  })
  it('1 層 = 半減、同じ属性 2 層 = 吸収、別属性は別々に半減', () => {
    expect(layersToAffinity([])).toBeUndefined()
    expect(layersToAffinity(['water'])).toEqual({ halve: ['water'] })
    expect(layersToAffinity(['water', 'water'])).toEqual({ absorb: ['water'] })
    expect(layersToAffinity(['water', 'fire'])).toEqual({ halve: ['water', 'fire'] })
  })
})

describe('resolveMemberMagicite / applyMemberMagicite', () => {
  const def = { id: 'a', magicites: ['sea', 'tiger'], magiciteSlots: 2 }

  it('装備時ボーナス・属性の層・耐性をまとめて返す', () => {
    const m = resolveMemberMagicite(def, { magicites: MASTER })
    expect(m.stones.map((s) => s.id)).toEqual(['sea', 'tiger'])
    expect(m.bonus).toEqual({ hp: 30, atk: 8 })
    expect(m.layers).toEqual(['water', 'fire'])
    expect(m.affinity).toEqual({ halve: ['water', 'fire'] })
  })
  it('成長の累計は装備時ボーナスとは別に足される（装備を外しても残る）', () => {
    const m = resolveMemberMagicite(
      { id: 'a' },
      { magicites: MASTER, growth: { a: { hp: 6, def: 2 } } }
    )
    expect(m.stones).toEqual([])
    expect(m.bonus).toEqual({ hp: 6, def: 2 })
    expect(m.layers).toEqual([])
    const withStone = resolveMemberMagicite(
      { id: 'a', magicites: ['sea'] },
      { magicites: MASTER, growth: { a: { hp: 6 } } }
    )
    expect(withStone.bonus).toEqual({ hp: 36, atk: 2 })
  })
  it('equipment が def.magicites を上書きし、extraElements が魔石の後ろに積まれる', () => {
    const m = resolveMemberMagicite(def, {
      magicites: MASTER,
      equipment: { a: ['sea'] },
      extraElements: { a: ['water'] },
    })
    expect(m.stones.map((s) => s.id)).toEqual(['sea'])
    expect(m.layers).toEqual(['water', 'water'])
    expect(m.attackElements).toEqual(['water'])
    expect(m.affinity).toEqual({ absorb: ['water'] })
  })
  it('防具の属性は耐性にだけ効き、通常攻撃の属性にはならない', () => {
    const armorOnly = resolveMemberMagicite(
      { id: 'a', magicites: ['plain'] },
      { magicites: MASTER, extraElements: { a: ['water'] } }
    )
    expect(armorOnly.layers).toEqual(['water'])
    expect(armorOnly.attackElements).toEqual([])
    expect(armorOnly.affinity).toEqual({ halve: ['water'] })
    const e = ent()
    applyMemberMagicite(e, armorOnly)
    expect(e.affinity).toEqual({ halve: ['water'] })
    expect(Object.keys(e)).not.toContain('attackElements')
    // 魔石の層が上限を埋めたら、防具の層は耐性にも乗らず攻撃にも乗らない
    const full = resolveMemberMagicite(def, { magicites: MASTER, extraElements: { a: ['ice'] } })
    expect(full.layers).toEqual(['water', 'fire'])
    expect(full.attackElements).toEqual(['water', 'fire'])
    expect(full.warnings.some((w) => w.includes("'ice'"))).toBe(true)
  })
  it('魔石のない味方・roster 無しは空。warnings が付く', () => {
    const none = resolveMemberMagicite({ id: 'a' }, undefined)
    expect(none).toEqual({
      stones: [],
      bonus: {},
      layers: [],
      attackElements: [],
      affinity: undefined,
      warnings: [],
    })
    const bad = resolveMemberMagicite({ id: 'a', magicites: ['nope'] }, { magicites: MASTER })
    expect(bad.warnings).toHaveLength(1)
  })

  it('applyMemberMagicite: 能力値・最大 HP/MP（現在値は増えた分だけ）・通常攻撃の属性・耐性を写す', () => {
    const e = ent()
    applyMemberMagicite(e, resolveMemberMagicite(def, { magicites: MASTER }))
    expect(e).toMatchObject({
      maxHp: 80,
      hp: 80,
      atk: 18,
      def: 5,
      agi: 4,
      attackElements: ['water', 'fire'],
      affinity: { halve: ['water', 'fire'] },
    })
  })
  it('MP のボーナスは最大 MP と MP の両方に入る。負のボーナスは 0（最大 HP は 1）で止まる', () => {
    const e = ent()
    applyMemberMagicite(e, {
      stones: [],
      bonus: { mp: 5, hp: -1000, atk: -1000, def: -1000, agi: -1000 },
      layers: [],
      attackElements: [],
      affinity: undefined,
      warnings: [],
    })
    expect(e).toMatchObject({ maxMp: 15, mp: 15, maxHp: 1, hp: 1, atk: 0, def: 0, agi: 0 })
    expect(e.attackElements).toBeUndefined()
    expect(e.affinity).toBeUndefined()
  })
  it('装備時の HP/MP ボーナスは増えた分だけ現在値に足す（hp < maxHp の味方が全回復しない）', () => {
    const e = ent()
    e.hp = 20
    e.mp = 3
    applyMemberMagicite(e, {
      stones: [],
      bonus: { hp: 30, mp: 5 },
      layers: [],
      attackElements: [],
      affinity: undefined,
      warnings: [],
    })
    expect(e).toMatchObject({ maxHp: 80, hp: 50, maxMp: 15, mp: 8 })
  })
  it('最大値が下がるときは現在値を新しい最大値に収める。倒れている者は起こさない', () => {
    const down = (e: BattleEntity, hp: number, mp: number): void =>
      applyMemberMagicite(e, {
        stones: [],
        bonus: { hp, mp },
        layers: [],
        attackElements: [],
        affinity: undefined,
        warnings: [],
      })
    const e = ent() // maxHp 50 / hp 50, maxMp 10 / mp 10
    down(e, -20, -4)
    expect(e).toMatchObject({ maxHp: 30, hp: 30, maxMp: 6, mp: 6 })
    const low = ent()
    low.hp = 10
    low.mp = 2
    down(low, -20, -9)
    expect(low).toMatchObject({ maxHp: 30, hp: 1, maxMp: 1, mp: 0 })
    const dead = ent()
    dead.hp = 0
    down(dead, 30, 0)
    expect(dead).toMatchObject({ maxHp: 80, hp: 0 })
  })
  it('何も無い結果は entity を変えない（キーも増えない）', () => {
    const e = ent()
    const before = JSON.stringify(e)
    applyMemberMagicite(e, resolveMemberMagicite({ id: 'a' }, { magicites: MASTER }))
    expect(JSON.stringify(e)).toBe(before)
    expect(Object.keys(e)).not.toContain('attackElements')
    expect(Object.keys(e)).not.toContain('affinity')
  })
  it('警告は同じ文面を 1 度だけ console.warn に出す', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const m = resolveMemberMagicite(
      { id: 'warn-once', magicites: ['no-such'] },
      { magicites: MASTER }
    )
    applyMemberMagicite(ent(), m)
    applyMemberMagicite(ent(), m)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0][0]).toContain('魔石')
    warn.mockRestore()
  })
})

describe('召喚の実行内容', () => {
  it('魔石 → SummonExecution: 名前は召喚獣名（省略は魔石名）、対象・効果・消費 MP・演出文', () => {
    expect(toSummonExecution(MASTER.sea)).toEqual({
      name: 'うみの主',
      target: '相手単体',
      mp: 0,
      message: defaultSummonMessage('うみの主'),
    })
    const t = toSummonExecution(
      stone({ id: 't', name: 'とら石', mp: 5.9, effect: 'damage 5..5', message: 'わっ！' })
    )
    expect(t).toEqual({
      name: 'とら石',
      target: '相手単体',
      mp: 5,
      effect: 'damage 5..5',
      message: 'わっ！',
    })
    expect(toSummonExecution(stone({ id: 'b', builtin: 'x' })).builtin).toBe('x')
  })
  it('消費 MP の不正値（負・NaN）は 0。召喚獣名が空文字なら魔石名', () => {
    expect(toSummonExecution(stone({ id: 'n', mp: -3 })).mp).toBe(0)
    expect(toSummonExecution(stone({ id: 'n', mp: Number.NaN })).mp).toBe(0)
    expect(toSummonExecution(stone({ id: 'n', name: 'いし', summon: '' })).name).toBe('いし')
  })
  it('summonEntries: 魔石の id を付け、枠の順に並べる', () => {
    const rows = summonEntries([MASTER.tiger, MASTER.sea])
    expect(rows.map((r) => [r.id, r.name, r.mp])).toEqual([
      ['tiger', 'tiger', 5],
      ['sea', 'うみの主', 0],
    ])
    expect(summonEntries([])).toEqual([])
  })
})
