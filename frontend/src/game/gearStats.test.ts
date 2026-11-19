/**
 * 一枚絵フィールドの装備の能力値 (#1234) の単体テスト。
 * 売り物の装備（`gearShop` の品の `equipBonus`）を、戦闘に出す味方とメニューのステータスに足し、
 * 戦闘後の書き戻しでは素の値へ戻す（`partyState` に加算が積み上がらない・HP ボーナスで戦闘のたびに回復しない）。
 * 現在 HP / MP は絶対値で、装備は最大値だけを変える（足すときは装備込みの最大値で切り詰めるだけ・戻すときはそのまま）
 */
import { describe, expect, it } from 'vitest'
import { applyGearStats, clampToGear, removeGearStats, type GearStatsInput } from './gearStats'
import { parseRpgSave, resolveRpg, snapshotRpg, type RpgBaseConfig } from './rpgSave'
import { BattleEngine } from './battleEngine'
import { carryOverBattleResult, snapshotParty } from '../field/fieldResume'
import type { GearShopConfig } from './gearShop'
import type { BattleEntity } from './spellDsl'

function member(id: string, over: Partial<BattleEntity> = {}): BattleEntity {
  return {
    id,
    name: id.toUpperCase(),
    hp: 100,
    maxHp: 100,
    mp: 10,
    maxMp: 10,
    atk: 10,
    def: 5,
    agi: 5,
    ...over,
  }
}

const foe = (): BattleEntity => ({
  id: 'slime',
  name: 'スライム',
  hp: 9999,
  maxHp: 9999,
  mp: 0,
  maxMp: 0,
  atk: 0,
  def: 0,
  agi: 1,
})

const shop: GearShopConfig = {
  multiplier: 2,
  entries: [
    { id: 'fast-blade', kind: 'blade', owner: 'a', basePrice: 100, equipBonus: 'agi+5, atk+3' },
    { id: 'other-blade', kind: 'blade', owner: 'b', basePrice: 100, equipBonus: 'atk+7' },
    { id: 'vest', kind: 'armor', price: 50, equipBonus: 'def+4, hp+20, mp+6' },
    { id: 'cursed', kind: 'armor', price: 50, equipBonus: 'def-9' },
    { id: 'plate', kind: 'armor', price: 50, equipBonus: 'hp+10, mp+4' },
  ],
}

const input = (equipment: Record<string, string[]>): GearStatsInput => ({ shop, equipment })

describe('applyGearStats: 装備の能力値を戦闘の味方に足す (#1234)', () => {
  it('刀・防具の equipBonus が atk / def / agi / 最大 HP / 最大 MP に足される（現在 HP / MP は動かない）', () => {
    const { party } = applyGearStats([member('a')], input({ a: ['fast-blade', 'vest'] }))
    expect(party[0]).toMatchObject({
      atk: 13,
      def: 9,
      agi: 10,
      maxHp: 120,
      hp: 100,
      maxMp: 16,
      mp: 10,
    })
  })

  it('現在 HP / MP は絶対値（装備しただけで回復しない）', () => {
    const { party } = applyGearStats([member('a', { hp: 40, mp: 3 })], input({ a: ['vest'] }))
    expect(party[0]).toMatchObject({ hp: 40, maxHp: 120, mp: 3, maxMp: 16 })
  })

  it('現在 HP / MP は装備込みの最大値で切り詰める（素の最大値を超えた値を持つ味方）', () => {
    const { party } = applyGearStats(
      [member('a', { hp: 150, maxHp: 100, mp: 30, maxMp: 10 })],
      input({ a: ['vest'] })
    )
    expect(party[0]).toMatchObject({ hp: 120, maxHp: 120, mp: 16, maxMp: 16 })
  })

  it('装備していない味方・装備列に無い味方は同じ値（キーも増えない）', () => {
    const base = [member('a'), member('b')]
    const { party } = applyGearStats(base, input({ a: [] }))
    expect(party).toEqual(base)
  })

  it('他人の刀（owner 違い）は装備の検査で捨てられ、足されない（そうび画面の装備の規則と同じ）', () => {
    const { party } = applyGearStats([member('a')], input({ a: ['other-blade'] }))
    expect(party[0].atk).toBe(10)
  })

  it('能力値は 0 未満にならない（マイナスのボーナス）', () => {
    const { party } = applyGearStats([member('a', { def: 5 })], input({ a: ['cursed'] }))
    expect(party[0].def).toBe(0)
  })

  it('売り物の定義が無いゲームは従来どおり（味方をそのまま）', () => {
    const base = [member('a')]
    const { party } = applyGearStats(base, { shop: undefined, equipment: { a: ['vest'] } })
    expect(party).toEqual(base)
  })

  it('渡した味方は書き換えない', () => {
    const base = [member('a')]
    applyGearStats(base, input({ a: ['fast-blade', 'vest'] }))
    expect(base[0]).toEqual(member('a'))
  })
})

describe('removeGearStats: 戦闘後の書き戻しで素の値へ戻す (#1234)', () => {
  it('戦闘を 2 回しても素の値に装備の加算が積み上がらない', () => {
    let partyState = [member('a')]
    const eq = input({ a: ['fast-blade', 'vest'] })
    for (let i = 0; i < 2; i++) {
      const { party, deltas } = applyGearStats(partyState, eq)
      expect(party[0]).toMatchObject({ atk: 13, def: 9, agi: 10, maxHp: 120, maxMp: 16 })
      partyState = removeGearStats(party, deltas)
    }
    expect(partyState[0]).toEqual(member('a'))
  })

  it('HP ボーナスで戦闘のたびに回復しない（戦闘中の減りは素の値へ持ち越す）', () => {
    let partyState = [member('a', { hp: 50 })]
    const eq = input({ a: ['vest'] })
    const first = applyGearStats(partyState, eq)
    expect(first.party[0]).toMatchObject({ hp: 50, maxHp: 120 })
    // 戦闘で 30 減った
    first.party[0].hp -= 30
    partyState = removeGearStats(first.party, first.deltas)
    expect(partyState[0]).toMatchObject({ hp: 20, maxHp: 100 })
    const second = applyGearStats(partyState, eq)
    expect(second.party[0]).toMatchObject({ hp: 20, maxHp: 120 })
  })

  it('戦闘で倒れた味方（HP 0）は 0 のまま戻る（起こさない）', () => {
    const { party, deltas } = applyGearStats([member('a')], input({ a: ['vest'] }))
    party[0].hp = 0
    expect(removeGearStats(party, deltas)[0]).toMatchObject({ hp: 0, maxHp: 100 })
  })

  it('レベルアップの成長（戦闘後に増えた分）は失わない', () => {
    const { party, deltas } = applyGearStats([member('a')], input({ a: ['fast-blade', 'vest'] }))
    // 勝利のレベルアップで最大 HP +8・atk +2・agi +1 が装備込みの値に足された
    party[0] = {
      ...party[0],
      maxHp: party[0].maxHp + 8,
      hp: party[0].hp + 8,
      atk: party[0].atk + 2,
      agi: party[0].agi + 1,
      level: 2,
    }
    expect(removeGearStats(party, deltas)[0]).toMatchObject({
      maxHp: 108,
      hp: 108,
      atk: 12,
      def: 5,
      agi: 6,
      maxMp: 10,
      mp: 10,
      level: 2,
    })
  })

  it('0 に丸めたマイナスのボーナスは、実際に引いた分だけ戻す', () => {
    const { party, deltas } = applyGearStats([member('a', { def: 5 })], input({ a: ['cursed'] }))
    expect(removeGearStats(party, deltas)[0].def).toBe(5)
  })

  it('状態異常など能力値以外の戦闘後の値は残す', () => {
    const { party, deltas } = applyGearStats([member('a')], input({ a: ['vest'] }))
    party[0] = { ...party[0], status: { poison: 3 } }
    expect(removeGearStats(party, deltas)[0]).toMatchObject({ status: { poison: 3 } })
  })
})

describe('HP / MP の往復: 現在値は絶対値・装備は最大値だけ (#1234)', () => {
  const eq = input({ a: ['plate'] })
  const roundTrip = (m: BattleEntity) => {
    const first = applyGearStats([m], eq)
    const back = removeGearStats(first.party, first.deltas)
    const second = applyGearStats(back, eq)
    return { first: first.party[0], back: back[0], second: second.party[0] }
  }

  it('5/40 で戻して足しても 5/40（下限への丸めで値を失わない・回復しない）。MP も同じ', () => {
    const r = roundTrip(member('a', { hp: 5, maxHp: 30, mp: 1, maxMp: 8 }))
    expect(r.first).toMatchObject({ hp: 5, maxHp: 40, mp: 1, maxMp: 12 })
    expect(r.back).toMatchObject({ hp: 5, maxHp: 30, mp: 1, maxMp: 8 })
    expect(r.second).toMatchObject({ hp: 5, maxHp: 40, mp: 1, maxMp: 12 })
  })

  it('装備込みで満タンの 40/40 も往復する（素の値は 40/30 のまま持つ）。MP も同じ', () => {
    const r = roundTrip(member('a', { hp: 40, maxHp: 30, mp: 12, maxMp: 8 }))
    expect(r.first).toMatchObject({ hp: 40, maxHp: 40, mp: 12, maxMp: 12 })
    expect(r.back).toMatchObject({ hp: 40, maxHp: 30, mp: 12, maxMp: 8 })
    expect(r.second).toMatchObject({ hp: 40, maxHp: 40, mp: 12, maxMp: 12 })
  })

  it('戦闘中に減った値（5/40）を戻して足すと 5/40', () => {
    const { party, deltas } = applyGearStats([member('a', { hp: 40, maxHp: 30 })], eq)
    party[0].hp = 5
    const back = removeGearStats(party, deltas)
    expect(back[0]).toMatchObject({ hp: 5, maxHp: 30 })
    expect(applyGearStats(back, eq).party[0]).toMatchObject({ hp: 5, maxHp: 40 })
  })

  it('倒れた者（HP 0）は往復しても 0', () => {
    const r = roundTrip(member('a', { hp: 0, maxHp: 30, mp: 0, maxMp: 8 }))
    expect(r.first).toMatchObject({ hp: 0, mp: 0 })
    expect(r.back).toMatchObject({ hp: 0, mp: 0 })
    expect(r.second).toMatchObject({ hp: 0, mp: 0 })
  })
})

describe('clampToGear: 装備を外したら新しい最大値まで切り詰める (#1234)', () => {
  it('外して最大値が下がった分だけ HP / MP が下がる。装備したままなら変わらない', () => {
    const base = [member('a', { hp: 40, maxHp: 30, mp: 12, maxMp: 8 })]
    expect(clampToGear(base, input({ a: ['plate'] }))[0]).toMatchObject({
      hp: 40,
      maxHp: 30,
      mp: 12,
      maxMp: 8,
    })
    expect(clampToGear(base, input({ a: [] }))[0]).toMatchObject({
      hp: 30,
      maxHp: 30,
      mp: 8,
      maxMp: 8,
    })
  })

  it('装備しても回復しない（最大値が上がっても現在値はそのまま）', () => {
    const base = [member('a', { hp: 5, maxHp: 30 })]
    expect(clampToGear(base, input({ a: ['plate'] }))[0]).toMatchObject({ hp: 5, maxHp: 30 })
  })

  it('渡した味方は書き換えない', () => {
    const base = [member('a', { hp: 40, maxHp: 30 })]
    clampToGear(base, input({ a: [] }))
    expect(base[0].hp).toBe(40)
  })
})

describe('セーブ → 再開で装備込みの値が元どおり (#1234)', () => {
  const base: RpgBaseConfig = {
    party: [member('a', { hp: 30, maxHp: 30, mp: 8, maxMp: 8 })],
    items: [],
    flags: {},
    enemy: () => undefined,
  }
  const saveAndResume = (party: BattleEntity[]): BattleEntity[] => {
    const save = snapshotRpg({ party, inventory: {}, equipment: {}, gold: 0 }, base)
    const parsed = parseRpgSave(JSON.parse(JSON.stringify(save)))
    if (!parsed.ok) throw new Error(parsed.error)
    return resolveRpg(parsed.value, base).party
  }

  it('素の最大値を超えた現在値（35/30）は maxHp も書かれ、再開しても素の最大値が持ち上がらない（装備込みで 35/40）', () => {
    const eq = input({ a: ['plate'] })
    const { party, deltas } = applyGearStats(
      [member('a', { hp: 40, maxHp: 30, mp: 12, maxMp: 8 })],
      eq
    )
    party[0].hp = 35
    party[0].mp = 11
    const partyState = removeGearStats(party, deltas)
    const resumed = saveAndResume(partyState)
    expect(resumed[0]).toMatchObject({ hp: 35, maxHp: 30, mp: 11, maxMp: 8 })
    expect(applyGearStats(resumed, eq).party[0]).toMatchObject({
      hp: 35,
      maxHp: 40,
      mp: 11,
      maxMp: 12,
    })
  })

  it('hp だけ書いた従来のセーブは、従来どおり maxHp / maxMp を hp / mp まで持ち上げる', () => {
    const resolved = resolveRpg(
      {
        version: 1,
        party: [{ id: 'a', hp: 50, mp: 9 }],
        items: {},
        equipment: {},
        gold: 0,
      },
      base
    )
    expect(resolved.party[0]).toMatchObject({ hp: 50, maxHp: 50, mp: 9, maxMp: 9 })
  })
})

describe('一枚絵フィールドの配線と同じ流れ (#1234)', () => {
  const eq = input({ a: ['fast-blade', 'vest'] })

  it('勝利の持ち越し（carryOverBattleResult）を 2 回通しても、素の値は戦闘の減りだけが残り加算は積み上がらない', () => {
    let partyState = [member('a'), member('b')]
    for (let i = 0; i < 2; i++) {
      const { party, deltas } = applyGearStats(partyState, eq)
      party[0].hp -= 10 // 戦闘で減った
      partyState = carryOverBattleResult({
        outcome: 'victory',
        earnedGold: 0,
        menuItems: [],
        partyAfter: removeGearStats(party, deltas),
        before: { inventory: {}, gold: 0, party: partyState },
      }).party
    }
    expect(partyState[0]).toMatchObject({ hp: 80, maxHp: 100, atk: 10, def: 5, agi: 5, mp: 10 })
    expect(partyState[1]).toEqual(member('b'))
  })

  it('戦闘中のセーブ（素の値で書く）から再開して足し直すと、戦闘中の値に戻る（二重に足さない）', () => {
    const partyState = [member('a'), member('b')]
    const { party, deltas } = applyGearStats(partyState, eq)
    party[0].hp = 33
    const saved = snapshotParty(partyState, removeGearStats(party, deltas), true)
    expect(saved[0]).toMatchObject({ maxHp: 100, atk: 10, agi: 5 })
    const resumed = applyGearStats(saved, eq).party
    expect(resumed[0]).toMatchObject({ hp: 33, maxHp: 120, atk: 13, def: 9, agi: 10 })
  })
})

describe('ATB: 素早さの装備でゲージが速く溜まる (#1234)', () => {
  it('agi+5 の刀を装備した味方は、装備しない味方より同じ時間でゲージが多く溜まる', () => {
    const base = [member('a'), member('b')]
    const { party } = applyGearStats(base, input({ a: ['fast-blade'] }))
    const eng = new BattleEngine(party, [foe()], { atb: { mode: 'wait' }, rng: () => 0 })
    eng.tick(1000)
    const [ga, gb] = eng.getState().atb!.partyGauge
    // AGI 10 は AGI 5 の 2 倍の速さ
    expect(ga).toBeCloseTo(gb * 2)
    expect(ga).toBeGreaterThan(gb)
  })
})
