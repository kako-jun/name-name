/** 装備 (#207) の純関数: 枠の割り当て・装備の解決（アイテムと魔石を同じ入口で）・属性の層・ボーナス・わざ・装備の変更 */
import { describe, expect, it, vi } from 'vitest'
import type { ItemDef, MagiciteDef } from '../types'
import {
  MAX_SLOTS_PER_KIND,
  equipItem,
  equipmentIds,
  resolveMemberEquipment,
  slotKindOf,
  slotPlan,
  unequipItem,
  type EquipmentRoster,
} from './equipment'
import { MAX_MAGICITE_SLOTS, resolveMemberMagicite } from './magicite'

const gear = (over: Partial<ItemDef> & { id: string }): ItemDef => ({
  name: over.id,
  kind: '武器',
  ...over,
})
const stone = (over: Partial<MagiciteDef> & { id: string }): MagiciteDef => ({
  name: over.id,
  target: '相手単体',
  ...over,
})

const ITEMS: Record<string, ItemDef> = {
  sword: gear({ id: 'sword', equipBonus: 'atk+8', abilities: ['slash'] }),
  axe: gear({ id: 'axe', equipBonus: 'atk+3', abilities: ['sweep', 'slash'] }),
  plate: gear({ id: 'plate', kind: '鎧', equipBonus: 'def+5, hp+20', elements: ['fire'] }),
  robe: gear({ id: 'robe', kind: '防具', elements: ['water'] }),
  robe2: gear({ id: 'robe2', kind: '防具', elements: ['water'] }),
  shield: gear({ id: 'shield', kind: '盾', equipBonus: 'def+3' }),
  helm: gear({ id: 'helm', kind: '兜', equipBonus: 'def+2' }),
  potion: gear({ id: 'potion', kind: '回復', equipBonus: 'atk+99' }),
  only: gear({ id: 'only', equippableBy: ['mage'], equipBonus: 'atk+50' }),
  fsword: gear({ id: 'fsword', elements: ['fire'], equipBonus: 'atk+4' }),
  zz: gear({ id: 'zz', equippableBy: ['zz'] }),
  shield2: gear({ id: 'shield2', kind: '盾', elements: ['ice'] }),
  helm2: gear({ id: 'helm2', kind: '兜', elements: ['wind'] }),
  bad: gear({ id: 'bad', equipBonus: 'xx+3, atk+2, def+' }),
}
const STONES: Record<string, MagiciteDef> = {
  sea: stone({ id: 'sea', elements: ['water'], equipBonus: 'hp+30' }),
  sea2: stone({ id: 'sea2', elements: ['water'] }),
  twin: stone({ id: 'twin', elements: ['fire', 'ice'] }),
}
const ROSTER: EquipmentRoster = { items: ITEMS, magicites: STONES }

describe('slotKindOf: 種別の語 → 装備枠の種類', () => {
  it('日本語・別名・英語（大小文字・前後の空白を無視）を 4 種類にまとめる', () => {
    expect(
      [
        '武器',
        'weapon',
        ' Weapon ',
        '防具',
        '鎧',
        'armor',
        '盾',
        'shield',
        '兜',
        'かぶと',
        'helm',
      ].map(slotKindOf)
    ).toEqual(['武器', '武器', '武器', '防具', '防具', '防具', '盾', '盾', '兜', '兜', '兜'])
  })
  it('装備できない種別・未指定・Object.prototype のキーは undefined', () => {
    expect(
      ['回復', '鍵', 'その他', '', undefined, 'toString', 'constructor'].map(slotKindOf)
    ).toEqual([undefined, undefined, undefined, undefined, undefined, undefined, undefined])
  })
})

describe('slotPlan: 枠の割り当て', () => {
  it('装備枠を書かなければ 武器・防具・盾・兜 が各 1、魔石は 1', () => {
    expect(slotPlan({ id: 'a' })).toEqual({
      counts: { 武器: 1, 防具: 1, 盾: 1, 兜: 1 },
      stones: 1,
      warnings: [],
    })
  })
  it('書いた種類だけ・並べた数だけ。同じ種類を並べれば複数枠', () => {
    const p = slotPlan({ id: 'a', equipmentSlots: ['武器', '防具', '鎧', 'shield'] })
    expect(p.counts).toEqual({ 武器: 1, 防具: 2, 盾: 1, 兜: 0 })
    expect(p.stones).toBe(1)
  })
  it('空の装備枠は枠なし（書いた意図を尊重）', () => {
    expect(slotPlan({ id: 'a', equipmentSlots: [] }).counts).toEqual({
      武器: 0,
      防具: 0,
      盾: 0,
      兜: 0,
    })
  })
  it('種類が分からない枠は警告して無視、1 種類の枠の数は上限で頭打ち', () => {
    const many = Array.from({ length: 20 }, () => '武器')
    const p = slotPlan({ id: 'a', equipmentSlots: ['指輪', ...many] })
    expect(p.warnings).toEqual(["a: 装備枠 '指輪' は種類が分からないため無視した"])
    expect(p.counts.武器).toBe(MAX_SLOTS_PER_KIND)
  })
  it('魔石の枠: 魔石枠 > 装備枠の魔石の数 > 既定 1（0 は有効、上限あり）', () => {
    expect(slotPlan({ id: 'a', equipmentSlots: ['魔石', '魔石'] }).stones).toBe(2)
    expect(slotPlan({ id: 'a', equipmentSlots: ['魔石', '魔石'], magiciteSlots: 3 }).stones).toBe(3)
    expect(slotPlan({ id: 'a', equipmentSlots: ['魔石'], magiciteSlots: 0 }).stones).toBe(0)
    expect(slotPlan({ id: 'a', magiciteSlots: 999 }).stones).toBe(MAX_MAGICITE_SLOTS)
  })
})

describe('equipmentIds: いま装備している id の列', () => {
  it('魔石: の後ろに 装備: を続ける。roster.equipment があれば上書き（空配列は何も装備しない）', () => {
    const def = { id: 'a', magicites: ['sea'], equipment: ['sword'] }
    expect(equipmentIds(def, undefined)).toEqual(['sea', 'sword'])
    expect(equipmentIds(def, { equipment: { a: ['axe'] } })).toEqual(['axe'])
    expect(equipmentIds(def, { equipment: { a: [] } })).toEqual([])
    expect(equipmentIds(def, { equipment: { b: ['axe'] } })).toEqual(['sea', 'sword'])
    expect(equipmentIds({ id: 'a' }, undefined)).toEqual([])
  })
  it('返す配列は入力と別物（書き換えても元を壊さない）', () => {
    const eq = { a: ['sword'] }
    equipmentIds({ id: 'a' }, { equipment: eq }).push('x')
    expect(eq.a).toEqual(['sword'])
  })
})

describe('resolveMemberEquipment: 装備の解決', () => {
  it('何も装備しなければ空の結果（bonus・layers・items・abilities が空、affinity は undefined）', () => {
    const r = resolveMemberEquipment({ id: 'a' }, ROSTER)
    expect(r).toEqual({
      stones: [],
      items: [],
      abilities: [],
      bonus: {},
      layers: [],
      attackElements: [],
      affinity: undefined,
      warnings: [],
    })
  })

  it('武器の ATK と防具・盾・兜の DEF がボーナスの合計になる（魔石の装備時も同じ入口で足す）', () => {
    const r = resolveMemberEquipment(
      { id: 'a', magicites: ['sea'], equipment: ['sword', 'plate', 'shield', 'helm'] },
      ROSTER
    )
    expect(r.bonus).toEqual({ atk: 8, def: 10, hp: 50 })
    expect(r.items.map((e) => [e.kind, e.item.id])).toEqual([
      ['武器', 'sword'],
      ['防具', 'plate'],
      ['盾', 'shield'],
      ['兜', 'helm'],
    ])
    expect(r.stones.map((s) => s.id)).toEqual(['sea'])
  })

  it('防具の属性は耐性の層にだけ積まれ、通常攻撃の属性にならない（魔石の属性が先）', () => {
    const r = resolveMemberEquipment({ id: 'a', magicites: ['sea'], equipment: ['plate'] }, ROSTER)
    expect(r.layers).toEqual(['water', 'fire'])
    expect(r.attackElements).toEqual(['water'])
    expect(r.affinity).toEqual({ halve: ['water', 'fire'] })
    const armorOnly = resolveMemberEquipment({ id: 'a', equipment: ['plate'] }, ROSTER)
    expect(armorOnly.attackElements).toEqual([])
    expect(armorOnly.affinity).toEqual({ halve: ['fire'] })
  })

  it('同じ属性が 2 層で吸収（防具 2 枠・魔石 + 防具）、合計 2 層を超える分は捨てて警告する', () => {
    const two = resolveMemberEquipment(
      { id: 'a', equipment: ['robe', 'robe2'], equipmentSlots: ['防具', '防具'] },
      ROSTER
    )
    expect(two.affinity).toEqual({ absorb: ['water'] })
    const mix = resolveMemberEquipment({ id: 'a', magicites: ['sea'], equipment: ['robe'] }, ROSTER)
    expect(mix.affinity).toEqual({ absorb: ['water'] })
    expect(mix.attackElements).toEqual(['water'])
    const over = resolveMemberEquipment(
      { id: 'a', magicites: ['twin'], equipment: ['plate'] },
      ROSTER
    )
    expect(over.layers).toEqual(['fire', 'ice'])
    expect(over.warnings.some((w) => w.includes("'fire'") && w.includes('2 つまで'))).toBe(true)
  })

  it('武器の `属性` は耐性にならず警告する（予約）。防具・盾・兜の `属性` は従来どおり耐性になる', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const w = resolveMemberEquipment({ id: 'a', equipment: ['fsword'] }, ROSTER)
      expect(w.affinity).toBeUndefined()
      expect(w.layers).toEqual([])
      expect(w.attackElements).toEqual([])
      expect(w.bonus).toEqual({ atk: 4 })
      expect(w.warnings).toEqual([
        "a: 武器 'fsword' の属性は現在は無視される（予約。耐性にはならない）",
      ])
      // console.warn は同じ id につき 1 度だけ
      resolveMemberEquipment({ id: 'a', equipment: ['fsword'] }, ROSTER)
      expect(warn).toHaveBeenCalledTimes(1)
      const g = resolveMemberEquipment({ id: 'a', equipment: ['robe', 'shield2'] }, ROSTER)
      expect(g.layers).toEqual(['water', 'ice'])
      expect(g.affinity).toEqual({ halve: ['water', 'ice'] })
      const h = resolveMemberEquipment({ id: 'a', equipment: ['helm2'] }, ROSTER)
      expect(h.affinity).toEqual({ halve: ['wind'] })
    } finally {
      warn.mockRestore()
    }
  })

  it('装備品と extraElements が合わせて 2 層を超えるとき、装備品が先に積まれ extra が捨てられる', () => {
    const r = resolveMemberEquipment(
      { id: 'a', equipment: ['robe', 'shield2'] },
      { ...ROSTER, extraElements: { a: ['wind'] } }
    )
    expect(r.layers).toEqual(['water', 'ice'])
    expect(r.affinity).toEqual({ halve: ['water', 'ice'] })
    expect(r.warnings.some((w) => w.includes("'wind'") && w.includes('2 つまで'))).toBe(true)
  })

  it('武器のわざを装備した順に集める（重複なし）', () => {
    const r = resolveMemberEquipment(
      { id: 'a', equipment: ['sword', 'axe'], equipmentSlots: ['武器', '武器'] },
      ROSTER
    )
    expect(r.abilities).toEqual(['slash', 'sweep'])
  })

  it('枠を超える分・種別違い・装備可に無い・重複・宣言なしは警告して捨てる（書いた順に枠が埋まる）', () => {
    const r = resolveMemberEquipment(
      { id: 'a', equipment: ['sword', 'axe', 'potion', 'only', 'sword', 'nothing'] },
      ROSTER
    )
    expect(r.items.map((e) => e.item.id)).toEqual(['sword'])
    expect(r.warnings).toEqual([
      "a: 装備枠 武器 1 を超えるため 'axe' は装備できない",
      "a: アイテム 'potion' は種別 '回復' のため装備できない",
      "a: アイテム 'only' は装備可に含まれないため装備できない",
      "a: アイテム 'sword' は重複しているため 2 つ目を無視した",
      "a: 'nothing' は [魔石] にも [アイテム] にも宣言が無いため装備できない",
    ])
  })

  it('枠の種類が無ければ装備できない（0 枠と未宣言を区別して知らせる）', () => {
    const r = resolveMemberEquipment(
      { id: 'a', equipment: ['sword', 'plate'], equipmentSlots: ['防具'] },
      ROSTER
    )
    expect(r.items.map((e) => e.item.id)).toEqual(['plate'])
    expect(r.warnings).toEqual(["a: 装備枠に 武器 が無いため 'sword' は装備できない"])
  })

  it('装備可に入っている味方は装備できる', () => {
    const r = resolveMemberEquipment({ id: 'mage', equipment: ['only'] }, ROSTER)
    expect(r.bonus).toEqual({ atk: 50 })
  })

  it('読めないボーナスは警告して無視し、読めた分は生かす', () => {
    const r = resolveMemberEquipment({ id: 'a', equipment: ['bad'] }, ROSTER)
    expect(r.bonus).toEqual({ atk: 2 })
    expect(r.warnings).toHaveLength(2)
    expect(r.warnings[0]).toContain("アイテム 'bad'")
  })

  it('成長（growth）と extraElements も同じ結果に足される', () => {
    const r = resolveMemberEquipment(
      { id: 'a', equipment: ['sword'] },
      { ...ROSTER, growth: { a: { atk: 2, hp: 5 } }, extraElements: { a: ['wind'] } }
    )
    expect(r.bonus).toEqual({ atk: 10, hp: 5 })
    expect(r.layers).toEqual(['wind'])
  })

  it('魔石の id も同じ `装備:` で書ける。同じ id が両方にあれば魔石を先に引いて警告する', () => {
    const r = resolveMemberEquipment({ id: 'a', equipment: ['sea', 'sword'] }, ROSTER)
    expect(r.stones.map((s) => s.id)).toEqual(['sea'])
    expect(r.items.map((e) => e.item.id)).toEqual(['sword'])
    const clash = resolveMemberEquipment(
      { id: 'a', equipment: ['dup'] },
      {
        items: { dup: gear({ id: 'dup', equipBonus: 'atk+1' }) },
        magicites: { dup: stone({ id: 'dup' }) },
      }
    )
    expect(clash.stones.map((s) => s.id)).toEqual(['dup'])
    expect(clash.items).toEqual([])
    expect(clash.warnings).toEqual([
      "a: 'dup' は [魔石] と [アイテム] の両方にあるため魔石として扱った",
    ])
  })

  it('魔石だけの装備は resolveMemberMagicite と同じ結果（互換）', () => {
    const def = { id: 'a', magicites: ['sea', 'sea2', 'twin'], magiciteSlots: 2 }
    const legacy = resolveMemberMagicite(def, { magicites: STONES, extraElements: { a: ['wind'] } })
    const unified = resolveMemberEquipment(def, {
      magicites: STONES,
      extraElements: { a: ['wind'] },
    })
    const { items, abilities, ...rest } = unified
    expect(items).toEqual([])
    expect(abilities).toEqual([])
    expect(rest).toEqual(legacy)
  })

  it('アイテムのマスターが無くても（魔石だけのゲーム）装備の列に魔石以外があれば宣言なしで捨てる', () => {
    const r = resolveMemberEquipment({ id: 'a', equipment: ['sword'] }, { magicites: STONES })
    expect(r.items).toEqual([])
    expect(r.warnings).toHaveLength(1)
  })

  it('入力（定義・マスター）を書き換えない', () => {
    const def = { id: 'a', equipment: ['sword', 'plate'], equipmentSlots: ['武器', '防具'] }
    const before = JSON.stringify([def, ROSTER])
    resolveMemberEquipment(def, ROSTER)
    expect(JSON.stringify([def, ROSTER])).toBe(before)
  })
})

describe('equipItem / unequipItem: 装備の変更の計算', () => {
  const def = { id: 'a', equipment: ['sword', 'plate'] }

  it('空いている枠に付ける。入力の配列は変えない', () => {
    const cur = ['sword']
    const r = equipItem(def, ROSTER, cur, 'shield')
    expect(r).toEqual({ equipment: ['sword', 'shield'], ok: true })
    expect(cur).toEqual(['sword'])
  })

  it('同じ種類の枠が埋まっていれば末尾を入れ替える（replaced）', () => {
    const r = equipItem(def, ROSTER, ['sword', 'plate'], 'axe')
    expect(r).toEqual({ equipment: ['plate', 'axe'], ok: true, replaced: 'sword' })
    const two = equipItem(
      { id: 'a', equipmentSlots: ['武器', '武器'] },
      ROSTER,
      ['sword', 'axe'],
      'only'
    )
    // only は mage 専用なので付けられず、変更なし
    expect(two.ok).toBe(false)
    expect(two.equipment).toEqual(['sword', 'axe'])
  })

  it('複数枠の種類は末尾の 1 つだけ入れ替える', () => {
    const d = { id: 'a', equipmentSlots: ['防具', '防具'] }
    const r = equipItem(d, ROSTER, ['robe', 'plate'], 'robe2')
    expect(r).toEqual({ equipment: ['robe', 'robe2'], ok: true, replaced: 'plate' })
  })

  it('すでに装備している id は変更なしで ok', () => {
    expect(equipItem(def, ROSTER, ['sword'], 'sword')).toEqual({ equipment: ['sword'], ok: true })
    // 列にあるだけで枠に入っていない（装備可に無い）品は「装備済み」にならない
    const ng = equipItem({ id: 'a' }, ROSTER, ['zz'], 'zz')
    expect(ng.ok).toBe(false)
    expect(ng.equipment).toEqual(['zz'])
    expect(ng.reason).toContain('装備可')
    // 枠から溢れて捨てられている品も同じ
    expect(equipItem({ id: 'a' }, ROSTER, ['sword', 'axe'], 'axe').ok).toBe(false)
  })

  it('付けられないもの（宣言なし・種別違い・装備可違反・枠なし）は変更なしで理由を返す', () => {
    const cur = ['sword']
    const cases: Array<[string, string]> = [
      ['nothing', '宣言が無い'],
      ['potion', '種別が装備できない'],
      ['only', '装備可'],
    ]
    for (const [id, text] of cases) {
      const r = equipItem(def, ROSTER, cur, id)
      expect(r.ok, id).toBe(false)
      expect(r.equipment, id).toEqual(['sword'])
      expect(r.reason, id).toContain(text)
    }
    const noSlot = equipItem({ id: 'a', equipmentSlots: ['防具'] }, ROSTER, [], 'sword')
    expect(noSlot).toMatchObject({ ok: false, equipment: [] })
    expect(noSlot.reason).toContain('装備枠に 武器 が無い')
  })

  it('魔石も同じ入口で付け替えられる（魔石枠 1 なら入れ替え）', () => {
    const r = equipItem({ id: 'a' }, ROSTER, ['sea'], 'twin')
    expect(r).toEqual({ equipment: ['twin'], ok: true, replaced: 'sea' })
    const none = equipItem({ id: 'a', magiciteSlots: 0 }, ROSTER, [], 'sea')
    expect(none.ok).toBe(false)
  })

  it('付けた結果が resolveMemberEquipment に反映される（変更 → 解決の通し）', () => {
    const r = equipItem(def, ROSTER, ['sword', 'plate'], 'axe')
    const eq = resolveMemberEquipment(def, ROSTER, r.equipment)
    expect(eq.items.map((e) => e.item.id)).toEqual(['plate', 'axe'])
    expect(eq.bonus).toEqual({ atk: 3, def: 5, hp: 20 })
    expect(eq.abilities).toEqual(['sweep', 'slash'])
  })

  it('unequipItem は外した列を返し、装備していない id は変更なし', () => {
    const cur = ['sword', 'plate']
    expect(unequipItem(cur, 'sword')).toEqual(['plate'])
    expect(unequipItem(cur, 'nothing')).toEqual(['sword', 'plate'])
    expect(cur).toEqual(['sword', 'plate'])
  })
})
