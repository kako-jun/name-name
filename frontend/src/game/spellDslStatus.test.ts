/** 効果 DSL の状態異常 (#870): `status … 確率=` / `cure` / 回復・ダメージの反転 / 耐性 */
import { describe, it, expect } from 'vitest'
import { applyEffect, parseEffect, type BattleEntity, type EffectContext } from './spellDsl'
import { buildStatusRules } from './statusEffects'
import { MAX_STATUS_TURNS } from './battleLimits'
import type { StatusDef } from '../types'

function ent(over: Partial<BattleEntity> = {}): BattleEntity {
  return {
    id: 'e',
    name: 'E',
    hp: 100,
    maxHp: 100,
    mp: 0,
    maxMp: 0,
    atk: 5,
    def: 1,
    agi: 2,
    ...over,
  }
}

const def = (id: string, over: Partial<StatusDef> = {}): StatusDef => ({ id, name: id, ...over })
const RULES = buildStatusRules({
  poison: def('poison', { name: 'どく', duration: '4', tickDamage: '1/16' }),
  zombie: def('zombie', { name: 'ゾンビ', duration: '3', reverse: '回復, ダメージ' }),
  healHurts: def('healHurts', { name: 'かいふくぎゃく', reverse: '回復' }),
  dmgHeals: def('dmgHeals', { name: 'ダメージかいふく', reverse: 'ダメージ' }),
})

function run(
  effect: string,
  targets: BattleEntity[],
  opts: { rng?: () => number; caster?: BattleEntity; rules?: typeof RULES | undefined } = {}
): { log: string[]; calls: number; ctx: EffectContext } {
  let calls = 0
  const base = opts.rng ?? (() => 0)
  const ctx: EffectContext = {
    caster: opts.caster ?? ent({ id: 'caster' }),
    targets,
    rng: () => {
      calls++
      return base()
    },
    ...('rules' in opts ? { statusRules: opts.rules } : { statusRules: RULES }),
  }
  const parsed = parseEffect(effect)
  if (!parsed) throw new Error(`parse failed: ${effect}`)
  const log = applyEffect(parsed, ctx)
  return { log, calls, ctx }
}

describe('parseEffect: status の 確率= と cure', () => {
  it('確率は 0〜99 の整数 %', () => {
    expect(parseEffect('status poison duration=3 確率=60')).toMatchObject({
      kind: 'status',
      state: 'poison',
      duration: 3,
      chance: 60,
    })
    expect(parseEffect('status poison 確率=0')).toMatchObject({ chance: 0 })
    expect(parseEffect('status poison 確率=99')).toMatchObject({ chance: 99 })
    expect(parseEffect('status poison 確率=99')?.warnings).toBeUndefined()
  })
  it('確率の省略は chance が付かない（必中・従来の parse 結果と同じ）', () => {
    expect(parseEffect('status poison duration=3')).toEqual({
      kind: 'status',
      state: 'poison',
      duration: 3,
    })
    expect('chance' in (parseEffect('status poison') as object)).toBe(false)
  })
  it('100 以上は 99 に切って警告、整数でない・負・小数は必中にして警告', () => {
    const over = parseEffect('status poison 確率=100')
    expect(over?.chance).toBe(99)
    expect(over?.warnings).toHaveLength(1)
    for (const bad of ['abc', '-5', '1.5', '', '５０']) {
      const p = parseEffect(`status poison 確率=${bad}`)
      expect(p?.chance, bad).toBeUndefined()
      expect(p?.warnings, bad).toHaveLength(1)
    }
  })
  it('確率= は status 専用。ほかの動詞に付けたら無視して警告する', () => {
    expect(parseEffect('damage 5..9 確率=50')?.warnings).toEqual([
      '確率= は status 専用のため無視した',
    ])
    expect(parseEffect('heal 5..9 確率=50')?.warnings).toHaveLength(1)
    expect(parseEffect('status poison 確率=50')?.warnings).toBeUndefined()
  })
  it('cure は状態名か all。引数なしは不正', () => {
    expect(parseEffect('cure poison')).toEqual({ kind: 'cure', state: 'poison' })
    expect(parseEffect('cure all')).toEqual({ kind: 'cure', state: 'all' })
    expect(parseEffect('cure')).toBeNull()
  })
})

describe('status の付与: 宣言した状態', () => {
  it('持続は duration= → 宣言の持続の順。宣言の無い印は従来どおり既定 1', () => {
    const a = ent()
    run('status poison duration=7', [a])
    expect(a.status?.poison).toBe(7)
    const b = ent()
    run('status poison', [b])
    expect(b.status?.poison).toBe(4) // [状態] の 持続: 4
    const c = ent()
    run('status marker', [c])
    expect(c.status?.marker).toBe(1) // 宣言なし = 従来
  })
  it('持続は上限 99 で頭打ち。0・負・NaN の duration は宣言の持続に落とす', () => {
    const a = ent()
    run('status poison duration=500', [a])
    expect(a.status?.poison).toBe(MAX_STATUS_TURNS)
    for (const bad of ['0', '-3', 'abc']) {
      const t = ent()
      run(`status poison duration=${bad}`, [t])
      expect(t.status?.poison, bad).toBe(4)
    }
  })
  it('日本語名の別名（毒 → poison）でも宣言した状態に付く', () => {
    const t = ent()
    const { log } = run('status 毒 duration=2', [t])
    expect(t.status?.poison).toBe(2)
    expect(t.status?.['毒']).toBeUndefined()
    expect(log).toEqual(['E は どく になった！'])
  })
  it('重ね掛けは後勝ちで持続を上書き（積み上がらない）', () => {
    const t = ent()
    run('status poison duration=2', [t])
    run('status poison duration=5', [t])
    expect(t.status?.poison).toBe(5)
    run('status poison duration=1', [t])
    expect(t.status?.poison).toBe(1)
  })
  it('倒れている者には付かない（宣言した状態のみ）', () => {
    const dead = ent({ hp: 0 })
    run('status poison', [dead])
    expect(dead.status?.poison).toBeUndefined()
    const alive = ent()
    run('status poison', [alive])
    expect(alive.status?.poison).toBe(4)
  })
  it('全員に付ける・自分に付ける（対象はそのまま targets）', () => {
    const party = [ent({ id: 'a' }), ent({ id: 'b' }), ent({ id: 'c' })]
    run('status zombie', party)
    expect(party.map((p) => p.status?.zombie)).toEqual([3, 3, 3])
    const self = ent({ id: 'boss' })
    run('status poison', [self], { caster: self })
    expect(self.status?.poison).toBe(4)
  })
  it('"__proto__" の id でも own-property に書き、prototype を汚染しない', () => {
    const t = ent()
    run('status __proto__ duration=3', [t])
    expect(Object.getPrototypeOf(t.status)).toBe(Object.prototype)
    expect(t.status?.['__proto__']).toBe(3)
  })
})

describe('status の付与: 成功率と耐性', () => {
  it('確率を書かず耐性もなければ必中で、乱数を使わない（旧挙動）', () => {
    const t = ent()
    const { calls } = run('status poison', [t], { rng: () => 0.999 })
    expect(t.status?.poison).toBe(4)
    expect(calls).toBe(0)
  })
  it('確率 60: 乱数 < 0.6 で付き、>= 0.6 で付かない（境界）', () => {
    const hit = ent()
    run('status poison 確率=60', [hit], { rng: () => 0.59999 })
    expect(hit.status?.poison).toBe(4)
    const miss = ent()
    const { log } = run('status poison 確率=60', [miss], { rng: () => 0.6 })
    expect(miss.status?.poison).toBeUndefined()
    expect(log).toEqual(['E には きかなかった！'])
  })
  it('確率 0 は必ず失敗（乱数を使わない）、確率 99 は乱数 0.99 で失敗する（頭打ち）', () => {
    const zero = ent()
    const r0 = run('status poison 確率=0', [zero], { rng: () => 0 })
    expect(zero.status?.poison).toBeUndefined()
    expect(r0.calls).toBe(0)
    const top = ent()
    run('status poison 確率=99', [top], { rng: () => 0.99 })
    expect(top.status?.poison).toBeUndefined()
    const top2 = ent()
    run('status poison 確率=99', [top2], { rng: () => 0.9899 })
    expect(top2.status?.poison).toBe(4)
  })
  it('確率 100 と書いても 99% に頭打ち（警告つき）', () => {
    const t = ent()
    const { log } = run('status poison 確率=100', [t], { rng: () => 0.995 })
    expect(t.status?.poison).toBeUndefined()
    expect(log[0]).toMatch(/^\(警告:/)
  })
  it('成長ぶん（statusChanceBonus）を足す。足した後も 99% で頭打ち。必中には効かない', () => {
    const caster = ent({ statusChanceBonus: 30 })
    const t1 = ent()
    run('status poison 確率=50', [t1], { caster, rng: () => 0.79 })
    expect(t1.status?.poison).toBe(4) // 50 + 30 = 80%
    const t2 = ent()
    run('status poison 確率=50', [t2], { caster, rng: () => 0.8 })
    expect(t2.status?.poison).toBeUndefined()
    const big = ent({ statusChanceBonus: 1000 })
    const t3 = ent()
    run('status poison 確率=50', [t3], { caster: big, rng: () => 0.99 })
    expect(t3.status?.poison).toBeUndefined() // 99% で頭打ち
    const t4 = ent()
    const r4 = run('status poison', [t4], { caster, rng: () => 0.999 })
    expect(t4.status?.poison).toBe(4)
    expect(r4.calls).toBe(0)
  })
  it('耐性: 無効・吸収は付かない（確率を書かなくても）', () => {
    for (const col of ['nullify', 'absorb'] as const) {
      const t = ent({ affinity: { [col]: ['poison'] } })
      const { log, calls } = run('status poison', [t], { rng: () => 0 })
      expect(t.status?.poison, col).toBeUndefined()
      expect(log, col).toEqual(['E には きかなかった！'])
      expect(calls, col).toBe(0)
    }
  })
  it('耐性: 半減は成功率 ×0.5（確率を書かなければ 50%）、弱点は ×2（上限 99%）', () => {
    const halve = ent({ affinity: { halve: ['poison'] } })
    run('status poison', [halve], { rng: () => 0.49 })
    expect(halve.status?.poison).toBe(4)
    const halve2 = ent({ affinity: { halve: ['poison'] } })
    run('status poison', [halve2], { rng: () => 0.5 })
    expect(halve2.status?.poison).toBeUndefined()
    const weak = ent({ affinity: { weak: ['poison'] } })
    run('status poison 確率=40', [weak], { rng: () => 0.79 })
    expect(weak.status?.poison).toBe(4) // 80%
    const weak2 = ent({ affinity: { weak: ['poison'] } })
    run('status poison', [weak2], { rng: () => 0.999 })
    expect(weak2.status?.poison).toBe(4) // 必中のまま（弱点でも元より下がらない）
  })
  it('耐性は状態 id（poison）で引く。日本語名で書いても宣言した id で判定する', () => {
    const t = ent({ affinity: { nullify: ['poison'] } })
    run('status 毒', [t])
    expect(t.status?.poison).toBeUndefined()
  })
  it('耐性は宣言の無い印にも効く（属性欄に書いた id は意味を持つ）', () => {
    const t = ent({ affinity: { nullify: ['marker'] } })
    run('status marker', [t])
    expect(t.status?.marker).toBeUndefined()
  })
  it('全体に付けるとき、耐性のある者だけ付かない', () => {
    const a = ent({ id: 'a' })
    const b = ent({ id: 'b', affinity: { nullify: ['poison'] } })
    run('status poison', [a, b])
    expect(a.status?.poison).toBe(4)
    expect(b.status?.poison).toBeUndefined()
  })
})

describe('cure', () => {
  it('指定した状態を解く。別名でも解ける。付いていなければ何も言わない', () => {
    const t = ent({ status: { poison: 3, zombie: 2 } })
    const r = run('cure poison', [t])
    expect(t.status).toEqual({ zombie: 2 })
    expect(r.log).toEqual(['E の どく が なおった！'])
    const t2 = ent({ status: { poison: 3 } })
    run('cure 毒', [t2])
    expect(t2.status).toEqual({})
    const none = ent({ status: { zombie: 2 } })
    expect(run('cure poison', [none]).log).toEqual([])
    expect(none.status).toEqual({ zombie: 2 })
    expect(run('cure poison', [ent()]).log).toEqual([])
  })
  it('残り 0 以下の状態は付いていない扱い', () => {
    const t = ent({ status: { poison: 0 } })
    expect(run('cure poison', [t]).log).toEqual([])
  })
  it('all は付いている状態をすべて解く（宣言の無い印も）', () => {
    const t = ent({ status: { poison: 3, zombie: 2, marker: 1, old: 0 } })
    const r = run('cure all', [t])
    expect(Object.keys(t.status ?? {})).toEqual(['old'])
    expect(r.log).toEqual(['E の 状態異常が なおった！'])
    expect(run('cure all', [ent()]).log).toEqual([])
  })
  it('宣言が無くても（規則なしでも）印を解ける', () => {
    const t = ent({ status: { poison: 3 } })
    run('cure poison', [t], { rules: undefined })
    expect(t.status).toEqual({})
  })
})

describe('回復の反転', () => {
  it('heal がダメージになる（上限 9999）', () => {
    const t = ent({ status: { healHurts: 3 } })
    const r = run('heal 30..30', [t])
    expect(t.hp).toBe(70)
    expect(r.log).toEqual(['E は 回復が さかさまに はたらき 30 のダメージ！'])
    const big = ent({ hp: 100_000, maxHp: 100_000, status: { healHurts: 3 } })
    run('heal 50000..50000', [big])
    expect(big.hp).toBe(100_000 - 9999)
  })
  it('heal_full は上限 9999 のダメージ。倒せるときは「たおれた」', () => {
    const t = ent({ hp: 40, status: { healHurts: 3 } })
    const r = run('heal_full', [t])
    expect(t.hp).toBe(0)
    expect(r.log).toEqual(['E は 回復が さかさまに はたらき 9999 のダメージ！', 'E は たおれた！'])
  })
  it('通知は damage で reversed=true。計算量が通知される', () => {
    const seen: unknown[] = []
    const t = ent({ status: { healHurts: 3 } })
    const ctx: EffectContext = {
      caster: ent(),
      targets: [t],
      rng: () => 0,
      statusRules: RULES,
      onAmount: (...args) => seen.push(args.slice(1)),
    }
    applyEffect(parseEffect('heal 12..12') as NonNullable<ReturnType<typeof parseEffect>>, ctx)
    expect(seen).toEqual([['damage', 12, true]])
  })
  it('倒れている者は何も起きない。蘇生 (revive) は反転しない', () => {
    const dead = ent({ hp: 0, status: { healHurts: 3 } })
    run('heal 30..30', [dead])
    expect(dead.hp).toBe(0)
    const dead2 = ent({ hp: 0, status: { healHurts: 3 } })
    run('revive hp=half', [dead2])
    expect(dead2.hp).toBe(50)
  })
  it('反転しない状態・状態なし・規則なしの heal は従来どおり', () => {
    const a = ent({ hp: 10, status: { dmgHeals: 3 } })
    run('heal 30..30', [a])
    expect(a.hp).toBe(40)
    const b = ent({ hp: 10 })
    run('heal 30..30', [b])
    expect(b.hp).toBe(40)
    const c = ent({ hp: 10, status: { healHurts: 3 } })
    run('heal 30..30', [c], { rules: undefined })
    expect(c.hp).toBe(40)
  })
  it('残りターン 0 の反転状態は働かない', () => {
    const t = ent({ hp: 10, status: { healHurts: 0 } })
    run('heal 30..30', [t])
    expect(t.hp).toBe(40)
  })
})

describe('ダメージの反転', () => {
  it('damage が回復になる（最大 HP で止まる）', () => {
    const t = ent({ hp: 50, status: { dmgHeals: 3 } })
    const r = run('damage 30..30', [t])
    expect(t.hp).toBe(80)
    expect(r.log).toEqual(['E は 30 回復した！'])
    run('damage 500..500', [t])
    expect(t.hp).toBe(100)
  })
  it('回復量は 9999 で頭打ち（全滅級の攻撃が回復になる）', () => {
    const t = ent({ hp: 1, maxHp: 50_000, status: { dmgHeals: 3 } })
    run('damage 99999..99999', [t])
    expect(t.hp).toBe(1 + 9999)
  })
  it('属性相性・耐性を通した最終値が回復になる（弱点 ×2・半減 ÷2）', () => {
    const weak = ent({ hp: 10, maxHp: 1000, affinity: { weak: ['fire'] }, status: { dmgHeals: 3 } })
    run('damage 20..20 type=fire', [weak])
    expect(weak.hp).toBe(10 + 40)
    const half = ent({
      hp: 10,
      maxHp: 1000,
      affinity: { halve: ['fire'] },
      status: { dmgHeals: 3 },
    })
    run('damage 20..20 type=fire', [half])
    expect(half.hp).toBe(20)
    const resist = ent({ hp: 10, maxHp: 1000, resist: { fire: 0.5 }, status: { dmgHeals: 3 } })
    run('damage 20..20 type=fire', [resist])
    expect(resist.hp).toBe(20)
  })
  it('無効（相性・耐性 0）は反転しても何も起きない。吸収は元から回復', () => {
    const nul = ent({ hp: 10, affinity: { nullify: ['fire'] }, status: { dmgHeals: 3 } })
    run('damage 20..20 type=fire', [nul])
    expect(nul.hp).toBe(10)
    const zero = ent({ hp: 10, resist: { fire: 0 }, status: { dmgHeals: 3 } })
    run('damage 20..20 type=fire', [zero])
    expect(zero.hp).toBe(10)
    const ab = ent({ hp: 10, affinity: { absorb: ['fire'] }, status: { dmgHeals: 3 } })
    run('damage 20..20 type=fire', [ab])
    expect(ab.hp).toBe(30)
  })
  it('倒れている者は生き返らない。ダメージ 0 は回復 0（HP 不変）', () => {
    const dead = ent({ hp: 0, status: { dmgHeals: 3 } })
    run('damage 30..30', [dead])
    expect(dead.hp).toBe(0)
    const t = ent({ hp: 10, status: { dmgHeals: 3 } })
    run('damage 0..0', [t])
    expect(t.hp).toBe(10)
    run('damage -5..-1', [t])
    expect(t.hp).toBe(10)
  })
  it('即死 (damage_full) は全回復。乱数を使わない', () => {
    const t = ent({ hp: 5, status: { dmgHeals: 3 } })
    const r = run('damage_full', [t], { rng: () => 0.999 })
    expect(t.hp).toBe(100)
    expect(r.log).toEqual(['E は 全回復した！'])
    expect(r.calls).toBe(0)
  })
  it('通知は heal で reversed=true', () => {
    const seen: unknown[] = []
    const t = ent({ hp: 10, status: { dmgHeals: 3 } })
    applyEffect(parseEffect('damage 12..12') as NonNullable<ReturnType<typeof parseEffect>>, {
      caster: ent(),
      targets: [t],
      rng: () => 0,
      statusRules: RULES,
      onAmount: (...args) => seen.push(args.slice(1)),
    })
    expect(seen).toEqual([['heal', 12, true]])
  })
  it('複数ヒット: ヒットごとに回復になり、onHit に reversed が付く', () => {
    const hits: unknown[] = []
    const t = ent({ hp: 10, status: { dmgHeals: 3 } })
    applyEffect(parseEffect('damage 5..5 回数=3') as NonNullable<ReturnType<typeof parseEffect>>, {
      caster: ent(),
      targets: [t],
      rng: () => 0,
      statusRules: RULES,
      onHit: (_t, kind, amount, round, reversed) => hits.push([kind, amount, round, reversed]),
    })
    expect(t.hp).toBe(25)
    expect(hits).toEqual([
      ['heal', 5, 0, true],
      ['heal', 5, 1, true],
      ['heal', 5, 2, true],
    ])
  })
  it('ゾンビ（両方向）: 回復はダメージ、ダメージは回復', () => {
    const z = ent({ hp: 50, status: { zombie: 3 } })
    run('heal 20..20', [z])
    expect(z.hp).toBe(30)
    run('damage 20..20', [z])
    expect(z.hp).toBe(50)
  })
  it('反転しない相手の damage は従来どおり。全体技で反転する者としない者が混ざる', () => {
    const z = ent({ id: 'z', hp: 50, status: { dmgHeals: 3 } })
    const n = ent({ id: 'n', hp: 50 })
    run('damage 20..20', [z, n])
    expect(z.hp).toBe(70)
    expect(n.hp).toBe(30)
  })
})

describe('状態を宣言しない効果は従来と完全に同じ', () => {
  it('規則なし: status は印だけ（既定 1・乱数なし）、反転なし', () => {
    const t = ent({ hp: 10 })
    const r = run('status poison duration=2', [t], { rules: undefined, rng: () => 0.5 })
    expect(t.status).toEqual({ poison: 2 })
    expect(r.log).toEqual(['E は poison になった！'])
    expect(r.calls).toBe(0)
    run('heal 5..5', [t], { rules: undefined })
    expect(t.hp).toBe(15)
  })
})
