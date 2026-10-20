/** 戦闘の上限・HP 下限の基盤 (#877 段階 1): 1 回のダメージ上限 9999・負 HP 防止・既存挙動の不変 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { BattleEngine } from './battleEngine'
import type { BattleEntity } from './spellDsl'
import { parseEffect, applyEffect } from './spellDsl'
import {
  MAX_DAMAGE,
  MIN_HP,
  MAX_HITS_PER_ACTION,
  applyDamageToHp,
  clampDamage,
  clampHp,
} from './battleLimits'

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

function ctxFor(targets: BattleEntity[], amounts?: { kind: string; amount: number }[]) {
  return {
    caster: targets[0],
    targets,
    rng: rng0,
    onAmount: (_t: BattleEntity, kind: 'damage' | 'heal', amount: number) =>
      amounts?.push({ kind, amount }),
  }
}

afterEach(() => vi.restoreAllMocks())

describe('定数', () => {
  it('ダメージ上限は 9999、HP 下限は 0、MAX_HITS_PER_ACTION は #879 用に用意されている', () => {
    expect(MAX_DAMAGE).toBe(9999)
    expect(MIN_HP).toBe(0)
    expect(MAX_HITS_PER_ACTION).toBeGreaterThan(0)
  })
})

describe('clampDamage / clampHp / applyDamageToHp', () => {
  it('境界 9998 / 9999 / 10000', () => {
    expect(clampDamage(9998)).toBe(9998)
    expect(clampDamage(9999)).toBe(9999)
    expect(clampDamage(10000)).toBe(9999)
  })
  it('clampHp: 下限 0・maxHp 省略なら上限なし', () => {
    expect(clampHp(-1)).toBe(0)
    expect(clampHp(0)).toBe(0)
    expect(clampHp(1)).toBe(1)
    expect(clampHp(100000)).toBe(100000)
    expect(clampHp(150, 100)).toBe(100)
  })
  it('敵 HP が 10 万でも減算が正しい（上限は HP に掛からない）', () => {
    const e = { hp: 100000 }
    expect(applyDamageToHp(e, 9999)).toBe(9999)
    expect(e.hp).toBe(90001)
    expect(applyDamageToHp(e, 12000)).toBe(9999)
    expect(e.hp).toBe(80002)
  })
  it('HP を超えるダメージは 0 で止まり、戻り値は頭打ち後のダメージ', () => {
    const e = { hp: 5 }
    expect(applyDamageToHp(e, 50)).toBe(50)
    expect(e.hp).toBe(0)
  })
})

describe('呪文・特技・アイテムの damage（効果 DSL）', () => {
  it.each([
    [9998, 9998],
    [9999, 9999],
    [10000, 9999],
    [12000, 9999],
  ])('damage %i..%i → 数字 %i', (raw, shown) => {
    const t = ent({ hp: 50000, maxHp: 50000 })
    const amounts: { kind: string; amount: number }[] = []
    const log = applyEffect(parseEffect(`damage ${raw}..${raw}`)!, ctxFor([t], amounts))
    expect(t.hp).toBe(50000 - shown)
    expect(amounts).toEqual([{ kind: 'damage', amount: shown }])
    expect(log).toEqual([`E に ${shown} のダメージ！`])
  })

  it('複数対象それぞれに上限が掛かる', () => {
    const a = ent({ id: 'a', hp: 30000, maxHp: 30000 })
    const b = ent({ id: 'b', hp: 100, maxHp: 100 })
    const amounts: { kind: string; amount: number }[] = []
    applyEffect(parseEffect('damage 20000..20000')!, ctxFor([a, b], amounts))
    expect(a.hp).toBe(30000 - 9999)
    expect(b.hp).toBe(0)
    expect(amounts.map((x) => x.amount)).toEqual([9999, 9999])
  })

  it('弱点 ×2 で超過する分も 9999 で止まる', () => {
    const t = ent({ hp: 50000, maxHp: 50000, affinity: { weak: ['fire'] } })
    const amounts: { kind: string; amount: number }[] = []
    applyEffect(parseEffect('damage 6000..6000 type=fire')!, ctxFor([t], amounts))
    expect(t.hp).toBe(50000 - 9999)
    expect(amounts).toEqual([{ kind: 'damage', amount: 9999 }])
  })

  it('弱点 ×2 が上限内なら従来どおり（4999 → 9998）', () => {
    const t = ent({ hp: 50000, maxHp: 50000, affinity: { weak: ['fire'] } })
    applyEffect(parseEffect('damage 4999..4999 type=fire')!, ctxFor([t]))
    expect(t.hp).toBe(50000 - 9998)
  })

  it('半減は従来どおり', () => {
    const t = ent({ hp: 50000, maxHp: 50000, affinity: { halve: ['fire'] } })
    applyEffect(parseEffect('damage 30000..30000 type=fire')!, ctxFor([t]))
    expect(t.hp).toBe(50000 - 9999)
  })

  it('耐性倍率 (resist) 経由の超過も頭打ち', () => {
    const t = ent({ hp: 50000, maxHp: 50000, resist: { fire: 2 } })
    applyEffect(parseEffect('damage 8000..8000 type=fire')!, ctxFor([t]))
    expect(t.hp).toBe(50000 - 9999)
  })

  it('吸収の回復量にはダメージ上限を掛けない（最大 HP で止まる）', () => {
    const t = ent({ hp: 1, maxHp: 50000, affinity: { absorb: ['fire'] } })
    const amounts: { kind: string; amount: number }[] = []
    applyEffect(parseEffect('damage 12000..12000 type=fire')!, ctxFor([t], amounts))
    expect(t.hp).toBe(12001)
    expect(amounts).toEqual([{ kind: 'heal', amount: 12000 }])
  })

  it('即死 (damage_full) は高 HP でも倒す。数字だけ 9999 で頭打ち', () => {
    const t = ent({ hp: 50000, maxHp: 50000 })
    const amounts: { kind: string; amount: number }[] = []
    applyEffect(parseEffect('damage_full')!, ctxFor([t], amounts))
    expect(t.hp).toBe(0)
    expect(amounts).toEqual([{ kind: 'damage', amount: 9999 }])
  })
})

describe('heal の下限 0', () => {
  const heal = (hp: number, range: string) => {
    const t = ent({ hp, maxHp: 100 })
    applyEffect(parseEffect(`heal ${range}`)!, ctxFor([t]))
    return t.hp
  }
  it('負値の回復で HP が 0 未満にならない', () => {
    expect(heal(3, '-10..-10')).toBe(0)
    expect(heal(0, '-1..-1')).toBe(0)
  })
  it('境界 -1 / 0 / +1', () => {
    expect(heal(5, '-1..-1')).toBe(4)
    expect(heal(5, '0..0')).toBe(5)
    expect(heal(5, '1..1')).toBe(6)
  })
  it('従来どおり最大 HP で止まる・回復量に上限は掛からない', () => {
    expect(heal(90, '50..50')).toBe(100)
    const t = ent({ hp: 1, maxHp: 50000 })
    applyEffect(parseEffect('heal 20000..20000')!, ctxFor([t]))
    expect(t.hp).toBe(20001)
  })
  it('heal_full は最大 HP（有限）になる', () => {
    const t = ent({ hp: 3, maxHp: 77777 })
    applyEffect(parseEffect('heal_full')!, ctxFor([t]))
    expect(t.hp).toBe(77777)
  })
})

describe('エンジン経由（全経路）で数字・ログ・イベントが 9999 を超えない', () => {
  it('通常攻撃（味方→敵）: ATK が巨大でも 9999。敵 HP 10 万から 5 回で 9999 ずつ減る', () => {
    const e = new BattleEngine(
      [ent({ id: 'hero', atk: 100000 })],
      [ent({ id: 'boss', hp: 100000, maxHp: 100000, atk: 0, def: 0 })],
      { rng: rng0 }
    )
    for (let i = 1; i <= 5; i++) {
      e.selectAttack()
      expect(e.getState().enemies[0].hp).toBe(100000 - 9999 * i)
    }
    const ev = e.getState().events.filter((v) => v.kind === 'attack' && v.actor.side === 'party')
    expect(ev).toHaveLength(5)
    for (const v of ev) expect(v.hits[0].amount).toBe(9999)
    expect(e.getState().log.some((l) => l.includes('9999 の ダメージ！'))).toBe(true)
    expect(e.getState().log.every((l) => !/\d{5,} の ダメージ/.test(l))).toBe(true)
  })

  it('通常攻撃（敵→味方、ターン制）: 味方 HP が 10 万でも 9999 まで', () => {
    const e = new BattleEngine(
      [ent({ id: 'hero', hp: 100000, maxHp: 100000, def: 0 })],
      [ent({ id: 'boss', atk: 50000 })],
      { rng: rng0 }
    )
    e.selectAttack()
    expect(e.getState().party[0].hp).toBe(100000 - 9999)
    const hit = e.getState().events.find((v) => v.actor.side === 'enemy')!.hits[0]
    expect(hit.amount).toBe(9999)
  })

  it('呪文 12000 → 数字 9999、HP は 9999 だけ減る', () => {
    const e = new BattleEngine(
      [ent({ id: 'hero' })],
      [ent({ id: 'boss', hp: 50000, maxHp: 50000, atk: 0 })],
      { rng: rng0 }
    )
    e.selectSpell({ name: 'ビッグバン', mp: 1, target: '敵単体', effect: 'damage 12000..12000' })
    expect(e.getState().enemies[0].hp).toBe(50000 - 9999)
    const hit = e.getState().events[0].hits[0]
    expect(hit).toMatchObject({ kind: 'damage', amount: 9999, hpBefore: 50000 })
  })

  it('アイテム 12000 も同様', () => {
    const e = new BattleEngine(
      [ent({ id: 'hero' })],
      [ent({ id: 'boss', hp: 50000, maxHp: 50000, atk: 0 })],
      { rng: rng0 }
    )
    e.selectItem({ name: 'ばくだん', effect: 'damage 12000..12000', target: '敵単体' } as never)
    expect(e.getState().events[0].hits[0].amount).toBe(9999)
  })

  it('特技（敵→味方）: 12000 → 数字 9999', () => {
    const e = new BattleEngine(
      [ent({ id: 'hero', hp: 50000, maxHp: 50000 })],
      [ent({ id: 'boss' })],
      { rng: rng0 }
    )
    e.performSkill(
      { side: 'enemy', index: 0 },
      { name: 'ごうだつ', target: '相手単体', effect: 'damage 12000..12000' }
    )
    expect(e.getState().party[0].hp).toBe(50000 - 9999)
    expect(e.getState().events[0].hits[0].amount).toBe(9999)
  })

  it('builtin の即死（HP の前後差で数字を出す経路）も 9999 で止まる', () => {
    const e = new BattleEngine(
      [ent({ id: 'hero' })],
      [ent({ id: 'boss', hp: 50000, maxHp: 50000, atk: 0 })],
      { rng: rng0 }
    )
    e.selectSpell({ name: 'ザラキ', mp: 1, target: '敵全体', builtin: 'zaraki' })
    expect(e.getState().enemies[0].hp).toBe(0)
    expect(e.getState().events[0].hits[0]).toMatchObject({ kind: 'damage', amount: 9999 })
  })

  it('負値 heal で味方 HP が 0 未満にならない（エンジン経由）', () => {
    const e = new BattleEngine([ent({ id: 'hero', hp: 3 })], [ent({ id: 'boss', atk: 0 })], {
      rng: rng0,
    })
    e.selectSpell({ name: 'どく', mp: 1, target: '味方単体', effect: 'heal -50..-50' })
    expect(e.getState().party[0].hp).toBe(0)
  })

  it('console に警告・エラーを出さない', () => {
    const w = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const er = vi.spyOn(console, 'error').mockImplementation(() => {})
    const e = new BattleEngine(
      [ent({ id: 'hero', atk: 100000 })],
      [ent({ id: 'boss', hp: 100000, maxHp: 100000 })],
      { rng: rng0 }
    )
    e.selectAttack()
    e.selectSpell({ name: 'x', mp: 1, target: '敵単体', effect: 'damage 20000..20000' })
    expect(w).not.toHaveBeenCalled()
    expect(er).not.toHaveBeenCalled()
  })
})

describe('既存挙動の不変（上限内・affinity なし）— 集約前のコードで取ったスナップショットと一致', () => {
  function lcg(seed: number) {
    let s = seed >>> 0
    return () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296
  }
  function run(seed: number): unknown[] {
    const r = lcg(seed)
    const mk = (id: string, hp: number, atk: number) => ({
      id,
      name: id,
      hp,
      maxHp: hp,
      mp: 30,
      maxMp: 30,
      atk,
      def: 3,
      agi: 5,
      exp: 1,
      gold: 1,
    })
    const e = new BattleEngine(
      [mk('h1', 3000, 40), mk('h2', 2500, 30)],
      [mk('s1', 4000, 35), mk('s2', 3500, 30)],
      { rng: lcg(seed + 1) }
    )
    const out: unknown[] = []
    for (let i = 0; i < 80 && !e.isOver(); i++) {
      const k = Math.floor(r() * 5)
      if (k === 0) e.selectAttack()
      else if (k === 1)
        e.selectSpell({ name: 'f', mp: 2, target: '敵全体', effect: 'damage 5..40 type=fire' })
      else if (k === 2)
        e.selectSpell({ name: 'c', mp: 2, target: '味方単体', effect: 'heal 5..30' })
      else if (k === 3) e.selectItem({ name: 'i', effect: 'damage 1..60' })
      else if (i === 50) e.selectSpell({ name: 'z', mp: 1, target: '敵全体', builtin: 'zaraki' })
      else e.selectSpell({ name: 'w', mp: 1, target: '敵単体', effect: 'damage 3..90' })
      out.push(JSON.parse(JSON.stringify(e.getState())))
    }
    return out
  }
  // state 全体（hp・ログ・events・rng 消費の結果）の sha256 先頭 16 桁。#872 マージ直後（本変更の前）のエンジンで採取
  const golden: Record<number, string> = {
    1: 'c1f346be5365236f',
    2: 'dfaeb276071f0825',
    3: '8ff63844805f7fd5',
    4: '5bbe30094f989179',
    5: '5486f2311b22ca7d',
    6: '8d31219b94b8673b',
    7: 'c88d62759d7da0a3',
    8: 'be7ad8f16efae2d1',
  }
  it.each(Object.entries(golden))('seed %s', async (seed, hash) => {
    const bytes = new TextEncoder().encode(JSON.stringify(run(Number(seed))))
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))
    const hex = Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('')
    expect(hex.slice(0, 16)).toBe(hash)
  })
})
