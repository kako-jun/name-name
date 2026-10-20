/**
 * #877 検証ハーネスが見つけた壊れの修正: HP は常に 0〜最大 HP・同時全滅は敗北優先・即死は数字なし・吸収は 9999 で頭打ち
 */
import { describe, it, expect } from 'vitest'
import { BattleEngine } from './battleEngine'
import type { BattleEntity } from './spellDsl'
import { parseEffect, applyEffect } from './spellDsl'
import { applyDamageToHp } from './battleLimits'

function ent(over: Partial<BattleEntity> = {}): BattleEntity {
  return {
    id: 'e',
    name: 'E',
    hp: 100,
    maxHp: 100,
    mp: 99,
    maxMp: 99,
    atk: 5,
    def: 1,
    agi: 2,
    exp: 1,
    gold: 1,
    ...over,
  }
}
const rng0 = () => 0
const ctx = (targets: BattleEntity[]) => ({ caster: targets[0], targets, rng: rng0 })

describe('負のダメージは HP を増やさない', () => {
  it('applyDamageToHp: 負の量は 0（HP 不変・戻り値 0）', () => {
    const t = ent({ hp: 100, maxHp: 100 })
    expect(applyDamageToHp(t, -5)).toBe(0)
    expect(t.hp).toBe(100)
    const u = ent({ hp: 50 })
    expect(applyDamageToHp(u, -1000000)).toBe(0)
    expect(u.hp).toBe(50)
  })
  it('damage -5..-1 は最大 HP ちょうど・-1 の境界でも HP を動かさない', () => {
    for (const hp of [100, 99, 1]) {
      const t = ent({ hp, maxHp: 100 })
      applyEffect(parseEffect('damage -5..-1')!, ctx([t]))
      expect(t.hp).toBe(hp)
    }
  })
  it('負の resist は 0（無効）に丸める。HP は増えず最大 HP を超えない', () => {
    const t = ent({ hp: 100, maxHp: 100, resist: { fire: -1 } })
    applyEffect(parseEffect('damage 10..10 type=fire')!, ctx([t]))
    expect(t.hp).toBe(100)
    const u = ent({ hp: 100, maxHp: 100, resist: { fire: -1e9 } })
    applyEffect(parseEffect('damage 1000..1000 type=fire')!, ctx([u]))
    expect(u.hp).toBe(100)
  })
  it('正の量・上限内の既存挙動は不変', () => {
    const t = ent({ hp: 100 })
    applyEffect(parseEffect('damage 10..10')!, ctx([t]))
    expect(t.hp).toBe(90)
  })
})

describe('HP を増やす経路は最大 HP で止まる', () => {
  it('heal: 最大 HP ちょうど / +1', () => {
    for (const [hp, amount, want] of [
      [90, 10, 100],
      [90, 11, 100],
      [90, 9, 99],
    ]) {
      const t = ent({ hp, maxHp: 100 })
      applyEffect(parseEffect(`heal ${amount}..${amount}`)!, ctx([t]))
      expect(t.hp).toBe(want)
    }
  })
  it('revive: 全快も半分も最大 HP を超えない（生きている対象は動かさない）', () => {
    const full = ent({ hp: 0, maxHp: 77 })
    applyEffect({ kind: 'revive', hp: 'full' }, ctx([full]))
    expect(full.hp).toBe(77)
    const half = ent({ hp: 0, maxHp: 77 })
    applyEffect({ kind: 'revive', hp: 'half' }, ctx([half]))
    expect(half.hp).toBe(38)
    const alive = ent({ hp: 5, maxHp: 77 })
    applyEffect({ kind: 'revive', hp: 'full' }, ctx([alive]))
    expect(alive.hp).toBe(5)
  })
  it('吸収は 9999 で頭打ち・最大 HP でも止まる（既存の最大 HP クランプは維持）', () => {
    const t = ent({ hp: 1, maxHp: 100000, affinity: { absorb: ['fire'] } })
    const amounts: number[] = []
    const log = applyEffect(parseEffect('damage 50000..50000 type=fire')!, {
      ...ctx([t]),
      onAmount: (_t, _k, a) => amounts.push(a),
    })
    expect(t.hp).toBe(10000)
    expect(amounts).toEqual([9999])
    expect(log).toEqual([`${t.name} は 9999 のダメージを吸収した！`])
    const u = ent({ hp: 98, maxHp: 100, affinity: { absorb: ['fire'] } })
    applyEffect(parseEffect('damage 500..500 type=fire')!, ctx([u]))
    expect(u.hp).toBe(100)
    // 9999 以下はそのまま
    const v = ent({ hp: 1, maxHp: 100000, affinity: { absorb: ['fire'] } })
    applyEffect(parseEffect('damage 9999..9999 type=fire')!, ctx([v]))
    expect(v.hp).toBe(10000)
  })
})

describe('同時全滅は味方全滅=敗北を優先する', () => {
  // 敵の死亡時の行動（全体ダメージ）で味方も 0 になる
  it('ターン制: 味方の行動で自分も敵も全滅 → 敗北', () => {
    const hero = ent({ id: 'hero', hp: 10, maxHp: 10, atk: 100, agi: 1 })
    const foe = ent({ id: 'foe', hp: 5, maxHp: 5, agi: 1, onDeath: '候補=burst' })
    const eng = new BattleEngine([hero], [foe], {
      rng: rng0,
      skills: { burst: { name: 'じばく', target: '相手全体', effect: 'damage 99..99' } },
    })
    eng.selectAttack()
    expect(hero.hp).toBe(0)
    expect(foe.hp).toBe(0)
    expect(eng.getState().phase).toBe('defeat')
    expect(eng.getState().earnedExp).toBe(0)
  })
  it('ATB: 同時全滅で敗北し、キューに倒れた味方が残らない', () => {
    const hero = ent({ id: 'hero', hp: 10, maxHp: 10, atk: 100, agi: 25 })
    const hero2 = ent({ id: 'hero2', hp: 10, maxHp: 10, atk: 1, agi: 25 })
    const foe = ent({ id: 'foe', hp: 5, maxHp: 5, agi: 1, onDeath: '候補=burst' })
    const eng = new BattleEngine([hero, hero2], [foe], {
      rng: rng0,
      atb: { initialGauges: { party: [1000, 1000] } },
      skills: { burst: { name: 'じばく', target: '相手全体', effect: 'damage 99..99' } },
    })
    eng.selectAttack()
    const s = eng.getState()
    expect(s.party.every((p) => p.hp === 0)).toBe(true)
    expect(s.enemies[0].hp).toBe(0)
    expect(s.phase).toBe('defeat')
    expect(s.atb!.queue).toEqual([])
    expect(s.atb!.partyGauge).toEqual([0, 0])
  })
  it('敵だけ全滅なら勝利のまま（既存挙動）', () => {
    const hero = ent({ id: 'hero', hp: 10, maxHp: 10, atk: 100, agi: 25 })
    const foe = ent({ id: 'foe', hp: 5, maxHp: 5, agi: 1 })
    const eng = new BattleEngine([hero], [foe], {
      rng: rng0,
      atb: { initialGauges: { party: [1000] } },
    })
    eng.selectAttack()
    expect(eng.getState().phase).toBe('victory')
  })
})

describe('即死は数字を出さず「たおれた」だけ', () => {
  it('damage_full: ログは「たおれた」・hit は instantDeath で HP は 0 へ（前後差と矛盾しない amount）', () => {
    const e = new BattleEngine(
      [ent({ id: 'hero' })],
      [ent({ id: 'boss', name: 'ボス', hp: 50000, maxHp: 50000, atk: 0 })],
      { rng: rng0 }
    )
    e.selectSpell({ name: 'デス', mp: 1, target: '敵単体', effect: 'damage_full' })
    const s = e.getState()
    expect(s.enemies[0].hp).toBe(0)
    expect(s.log.some((l) => l.includes('のダメージ'))).toBe(false)
    expect(s.log).toContain('ボス は たおれた！')
    const hit = s.events[0].hits[0]
    expect(hit).toMatchObject({ kind: 'damage', hpBefore: 50000, hpAfter: 0, instantDeath: true })
    expect(hit.amount).toBe(hit.hpBefore - hit.hpAfter)
  })
  it('通常のダメージの hit には instantDeath が付かない', () => {
    const e = new BattleEngine([ent({ id: 'hero' })], [ent({ id: 'boss', atk: 0 })], { rng: rng0 })
    e.selectSpell({ name: 'x', mp: 1, target: '敵単体', effect: 'damage 10..10' })
    expect(e.getState().events[0].hits[0].instantDeath).toBeUndefined()
  })
})
