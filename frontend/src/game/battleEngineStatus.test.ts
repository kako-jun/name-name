/** 戦闘エンジンの状態異常 (#870): 継続ダメージ・行動不能・混乱・満了・解除・反転・手番の進み方・旧挙動不変 */
import { describe, it, expect } from 'vitest'
import { BattleEngine, type BattleActionEvent, type SkillExecution } from './battleEngine'
import type { BattleEntity } from './spellDsl'
import type { StatusDef } from '../types'

function ent(over: Partial<BattleEntity> = {}): BattleEntity {
  return {
    id: 'e',
    name: 'E',
    hp: 100,
    maxHp: 100,
    mp: 9,
    maxMp: 9,
    atk: 1,
    def: 1,
    agi: 2,
    exp: 1,
    gold: 1,
    ...over,
  }
}

const def = (id: string, over: Partial<StatusDef> = {}): StatusDef => ({ id, name: id, ...over })

const STATUSES: Record<string, StatusDef> = {
  poison: def('poison', { name: 'どく', duration: '3', tickDamage: '10' }),
  sleep: def('sleep', { name: 'ねむり', duration: '2', action: '不能' }),
  // 殴られると起きる眠り・混乱
  nap: def('nap', { name: 'うたたね', duration: '5', action: '不能', cure: '被ダメージ' }),
  mad: def('mad', { name: 'こんらん', duration: '2', action: '混乱' }),
  shock: def('shock', { name: 'ぼうぜん', duration: '5', action: '混乱', cure: '被ダメージ' }),
  doom: def('doom', { name: 'しのせんこく', duration: '2', expire: '戦闘不能' }),
  zombie: def('zombie', { name: 'ゾンビ', duration: '5', reverse: '回復, ダメージ' }),
}

/** 乱数を呼んだ回数を数える（定数列で決定論的） */
function makeRng(values: number[] = [0]) {
  let n = 0
  const rng = () => values[n++ % values.length]
  return { rng, calls: () => n }
}

function statusEvents(e: BattleEngine): BattleActionEvent[] {
  return e.getState().events.filter((ev) => ev.kind === 'status')
}

describe('継続ダメージ（従来ターン制）', () => {
  it('味方の手番の終わりにダメージ→持続 -1。尽きたら解ける。ダメージは status イベントになる', () => {
    const hero = ent({ id: 'hero', name: 'ゆうしゃ', hp: 1000, maxHp: 1000, status: { poison: 2 } })
    const e = new BattleEngine([hero], [ent({ id: 's', hp: 9999, maxHp: 9999, atk: 0 })], {
      rng: () => 0,
      statuses: STATUSES,
    })
    e.selectAttack()
    expect(statusEvents(e)).toHaveLength(1)
    const ev = statusEvents(e)[0]
    expect(ev.actor).toEqual({ side: 'party', index: 0 })
    expect(ev.label).toBe('どく')
    expect(ev.hits).toEqual([
      {
        target: { side: 'party', index: 0 },
        kind: 'damage',
        amount: 10,
        hpBefore: 1000,
        hpAfter: 990,
      },
    ])
    expect(hero.status).toEqual({ poison: 1 })
    expect(e.getState().log).toContain('ゆうしゃ は どく で 10 のダメージ！')
    e.selectAttack()
    expect(hero.status).toEqual({}) // 持続 2 = 継続ダメージ 2 回で尽きる
    expect(statusEvents(e)).toHaveLength(2)
    expect(e.getState().log).toContain('ゆうしゃ の どく が とけた！')
    e.selectAttack()
    expect(statusEvents(e)).toHaveLength(2) // 解けた後は出ない
  })

  it('割合は最大 HP の num/den（切り捨て・最低 1）。固定幅は乱数を 1 回使う', () => {
    const frac: Record<string, StatusDef> = {
      p: def('p', { name: 'どく', duration: '9', tickDamage: '1/16' }),
    }
    const small = ent({ id: 'a', hp: 10, maxHp: 10, status: { p: 9 } })
    const big = ent({ id: 'b', hp: 1600, maxHp: 1600, status: { p: 9 } })
    const e = new BattleEngine([small, big], [ent({ id: 's', hp: 9999, maxHp: 9999, atk: 0 })], {
      rng: () => 0,
      statuses: frac,
    })
    e.selectAttack()
    const amounts = statusEvents(e).map((ev) => ev.hits[0].amount)
    expect(amounts).toEqual([1, 100]) // floor(10/16)=0 → 最低 1 / 1600/16 = 100
    const range: Record<string, StatusDef> = {
      p: def('p', { name: 'どく', duration: '9', tickDamage: '5..8' }),
    }
    const r = makeRng([0.999])
    const hero = ent({ id: 'h', hp: 1000, maxHp: 1000, status: { p: 9 } })
    const e2 = new BattleEngine([hero], [ent({ id: 's', hp: 9999, maxHp: 9999, atk: 0 })], {
      rng: r.rng,
      statuses: range,
    })
    const before = r.calls()
    e2.selectAttack()
    expect(r.calls() - before).toBeGreaterThanOrEqual(1)
    expect(hero.hp).toBeLessThanOrEqual(1000 - 5)
  })

  it('1 回のダメージは 9999 で頭打ち', () => {
    const hero = ent({ id: 'h', hp: 50_000, maxHp: 50_000, status: { p: 3 } })
    const e = new BattleEngine([hero], [ent({ id: 's', hp: 9999, maxHp: 9999, atk: 0 })], {
      rng: () => 0,
      statuses: { p: def('p', { name: 'どく', tickDamage: '999999' }) },
    })
    e.selectAttack()
    expect(statusEvents(e)[0].hits[0].amount).toBe(9999)
    expect(statusEvents(e)[0].hits[0].hpAfter).toBe(50_000 - 9999)
    void hero
  })

  it('継続ダメージで倒れる。状態は消え、全員倒れたら敗北（敵ターンは来ない）', () => {
    const hero = ent({ id: 'h', name: 'ゆうしゃ', hp: 5, maxHp: 100, status: { poison: 3 } })
    const enemy = ent({ id: 's', hp: 9999, maxHp: 9999, atk: 50 })
    const e = new BattleEngine([hero], [enemy], { rng: () => 0, statuses: STATUSES })
    e.selectAttack()
    expect(hero.hp).toBe(0)
    expect(hero.status).toEqual({})
    expect(e.getState().phase).toBe('defeat')
    expect(e.getState().log).toContain('ゆうしゃ は たおれた！')
    // 敵の通常攻撃は起きていない（イベントは 味方の攻撃 + どく）
    expect(e.getState().events.map((ev) => ev.kind)).toEqual(['attack', 'status'])
  })

  it('敵の手番の終わりにも進む。継続ダメージで最後の敵が倒れたら勝利', () => {
    const enemy = ent({
      id: 's',
      name: 'スライム',
      hp: 5,
      maxHp: 100,
      atk: 0,
      status: { poison: 3 },
    })
    const hero = ent({ id: 'h', hp: 1000, maxHp: 1000, atk: 0 })
    const e = new BattleEngine([hero], [enemy], { rng: () => 0, statuses: STATUSES })
    e.selectAttack() // 攻撃 1 ダメージ (atk 0 → 最低 1)、敵の手番の終わりに毒 10
    expect(enemy.hp).toBe(0)
    expect(e.getState().phase).toBe('victory')
    expect(statusEvents(e)).toHaveLength(1)
    expect(statusEvents(e)[0].actor).toEqual({ side: 'enemy', index: 0 })
  })

  it('属性相性の欄に状態 id: 無効 = なし / 吸収 = 回復 / 半減 ×½ / 弱点 ×2', () => {
    const run = (affinity: BattleEntity['affinity']) => {
      const enemy = ent({ id: 's', hp: 500, maxHp: 1000, atk: 0, status: { poison: 3 }, affinity })
      const e = new BattleEngine([ent({ id: 'h', atk: 0, hp: 9999, maxHp: 9999 })], [enemy], {
        rng: () => 0,
        statuses: STATUSES,
      })
      e.selectAttack()
      return { hp: enemy.hp, evs: statusEvents(e) }
    }
    // 通常攻撃 (atk 0, def 1 → 1 ダメージ) を引いた値で比べる
    expect(run(undefined).hp).toBe(500 - 1 - 10)
    expect(run({ nullify: ['poison'] })).toMatchObject({ hp: 499, evs: [] })
    expect(run({ halve: ['poison'] }).hp).toBe(500 - 1 - 5)
    expect(run({ weak: ['poison'] }).hp).toBe(500 - 1 - 20)
    const ab = run({ absorb: ['poison'] })
    expect(ab.hp).toBe(500 - 1 + 10)
    expect(ab.evs[0].hits[0]).toMatchObject({ kind: 'heal', amount: 10 })
  })

  it('倒れた者は状態を失い、蘇生しても残らない（宣言の無い印は触らない）', () => {
    const hero = ent({ id: 'h', hp: 1, maxHp: 100, status: { poison: 3, marker: 4 } })
    const mage = ent({ id: 'm', hp: 100, maxHp: 100, atk: 0 })
    const e = new BattleEngine([hero, mage], [ent({ id: 's', hp: 9999, maxHp: 9999, atk: 5 })], {
      rng: () => 0,
      statuses: STATUSES,
    })
    e.selectAttack()
    expect(hero.hp).toBe(0)
    expect(hero.status).toEqual({ marker: 4 })
  })
})

describe('継続ダメージ（ATB）', () => {
  it('本人の行動の直後に進む。ほかの者の行動では進まない', () => {
    const hero = ent({ id: 'h', hp: 1000, maxHp: 1000, agi: 25, status: { poison: 3 } })
    const mage = ent({ id: 'm', hp: 1000, maxHp: 1000, agi: 5 })
    const enemy = ent({ id: 's', hp: 9999, maxHp: 9999, agi: 1, atk: 0 })
    const e = new BattleEngine([hero, mage], [enemy], {
      rng: () => 0,
      atb: { mode: 'wait' },
      statuses: STATUSES,
    })
    e.tick(1100) // hero のゲージが満タン（1000ms）
    expect(e.getState().phase).toBe('party-input')
    expect(hero.hp).toBe(1000)
    e.selectAttack()
    expect(hero.hp).toBe(990)
    expect(hero.status).toEqual({ poison: 2 })
    expect(mage.hp).toBe(1000)
  })
})

describe('行動不能（睡眠）', () => {
  it('最初から眠っている先頭の味方は、入力を待たず自動で手番を過ごす（持続ぶん）', () => {
    const hero = ent({ id: 'h', name: 'ゆうしゃ', hp: 1000, maxHp: 1000, status: { sleep: 2 } })
    const e = new BattleEngine([hero], [ent({ id: 's', hp: 9999, maxHp: 9999, atk: 1 })], {
      rng: () => 0,
      statuses: STATUSES,
    })
    // 持続 2: 手番を 2 回飛ばしたあとコマンド待ちになる
    expect(e.getState().phase).toBe('party-input')
    expect(hero.status).toEqual({})
    const notices = e.getState().events.filter((ev) => ev.kind === 'notice')
    expect(notices).toHaveLength(2)
    expect(notices[0].label).toBe('うごけない！')
    expect(e.getState().log.filter((l) => l === 'ゆうしゃ は ねむり で うごけない！')).toHaveLength(
      2
    )
    // 敵は 2 回殴った（味方が動かない間も敵の手番は来る）
    expect(hero.hp).toBe(1000 - 2 * 1)
    // 起きたあとは通常どおり攻撃できる
    e.selectAttack()
    expect(e.getState().events[e.getState().events.length - 2]?.kind).toBe('attack')
  })

  it('従来ターン制: 敵が付けた睡眠（持続 1）は、次の味方の手番を飛ばす（その手番より前に消えない）', () => {
    const hero = ent({ id: 'h', name: 'ゆうしゃ', hp: 1000, maxHp: 1000, atk: 0 })
    const skills: Record<string, SkillExecution> = {
      lullaby: { name: 'ララバイ', target: '相手単体', effect: 'status sleep duration=1' },
    }
    const enemy = ent({
      id: 's',
      name: 'ねむり',
      hp: 9999,
      maxHp: 9999,
      atk: 0,
      actions: ['候補=lullaby'],
    })
    const e = new BattleEngine([hero], [enemy], { rng: () => 0, statuses: STATUSES, skills })
    e.selectAttack() // 味方の攻撃 → 敵が睡眠を付ける → 味方の手番は眠りで飛ばされる → 敵がまた付ける…
    const log = e.getState().log
    expect(log).toContain('ゆうしゃ は ねむり になった！')
    expect(log).toContain('ゆうしゃ は ねむり で うごけない！')
    // 眠りの間に、味方はこちらから動けない（常に自動解決）
    expect(e.getState().phase).toBe('party-input')
  })

  it('ATB: ゲージが満タンになった眠っている味方は手番を飛ばされ、時間は止まらない（wait でも）', () => {
    const hero = ent({
      id: 'h',
      name: 'ゆうしゃ',
      hp: 1000,
      maxHp: 1000,
      agi: 25,
      status: { sleep: 2 },
    })
    const enemy = ent({ id: 's', hp: 9999, maxHp: 9999, agi: 1, atk: 0 })
    const e = new BattleEngine([hero], [enemy], {
      rng: () => 0,
      atb: { mode: 'wait' },
      statuses: STATUSES,
    })
    e.tick(3500) // 1000ms ごとに満タン: 1000・2000 で眠りの手番を 2 回、3000 でコマンド待ち
    expect(hero.status).toEqual({})
    expect(e.getState().events.filter((ev) => ev.kind === 'notice')).toHaveLength(2)
    expect(e.getState().phase).toBe('party-input')
    expect(e.getState().atb?.queue).toEqual([0])
    e.tick(5000) // wait: コマンド待ちの間は時間が止まる（従来どおり）
    expect(e.getState().atb?.queue).toEqual([0])
  })

  it('敵が眠ると行動せず（通常攻撃もしない）、手番の終わりに進む。行動回数の記憶は進まない', () => {
    const hero = ent({ id: 'h', hp: 1000, maxHp: 1000, atk: 0 })
    const enemy = ent({
      id: 's',
      hp: 9999,
      maxHp: 9999,
      atk: 50,
      status: { sleep: 1 },
      actions: ['候補=こうげき'],
    })
    const e = new BattleEngine([hero], [enemy], { rng: () => 0, statuses: STATUSES })
    const acted = e.getState().enemyMemory?.[0].acted
    e.selectAttack() // 敵は眠りで飛ばされる
    expect(hero.hp).toBe(1000)
    expect(enemy.status).toEqual({})
    expect(e.getState().enemyMemory?.[0].acted).toBe(acted)
    e.selectAttack() // 起きた敵は殴る（ただし睡眠の「被ダメージで解除」は 1 回目の攻撃では効かない = すでに手番で解けた）
    expect(hero.hp).toBeLessThan(1000)
  })

  it('被ダメージで解ける: 眠っている敵は殴られて起きる', () => {
    const hero = ent({ id: 'h', hp: 1000, maxHp: 1000, atk: 20 })
    const enemy = ent({
      id: 's',
      name: 'ねぼすけ',
      hp: 9999,
      maxHp: 9999,
      atk: 50,
      status: { nap: 5 },
    })
    const e = new BattleEngine([hero], [enemy], { rng: () => 0, statuses: STATUSES })
    e.selectAttack()
    expect(enemy.status).toEqual({})
    expect(e.getState().log).toContain('ねぼすけ の うたたね が なおった！')
    // 起きたので同じ手番の敵は殴る
    expect(hero.hp).toBeLessThan(1000)
  })

  it('被ダメージで解けない状態は、殴られても残る。ダメージ 0・倒れた場合は「解ける」ログを出さない', () => {
    const hero = ent({ id: 'h', hp: 1000, maxHp: 1000, atk: 20 })
    const enemy = ent({ id: 's', hp: 9999, maxHp: 9999, atk: 0, status: { poison: 5 } })
    const e = new BattleEngine([hero], [enemy], { rng: () => 0, statuses: STATUSES })
    e.selectAttack()
    expect(enemy.status?.poison).toBeGreaterThan(0)
    const dying = ent({ id: 'd', hp: 1, maxHp: 100, atk: 0, status: { nap: 5 } })
    const e2 = new BattleEngine([ent({ id: 'h2', atk: 50 })], [dying], {
      rng: () => 0,
      statuses: STATUSES,
    })
    e2.selectAttack()
    expect(e2.getState().log.some((l) => l.includes('なおった'))).toBe(false)
  })
})

describe('混乱', () => {
  it('混乱した味方は自陣営の生存者（自分を含む）をランダムに殴る。敵の反撃は起きない', () => {
    const hero = ent({
      id: 'h',
      name: 'ゆうしゃ',
      hp: 1000,
      maxHp: 1000,
      atk: 20,
      status: { mad: 2 },
    })
    const mage = ent({ id: 'm', name: 'まほうつかい', hp: 1000, maxHp: 1000, atk: 0 })
    const enemy = ent({ id: 's', hp: 9999, maxHp: 9999, atk: 0, counters: ['候補=こうげき'] })
    const r = makeRng([0.99]) // 末尾の生存者 = mage
    const e = new BattleEngine([hero, mage], [enemy], { rng: r.rng, statuses: STATUSES })
    const ev = e.getState().events.find((x) => x.kind === 'attack')
    expect(ev).toBeDefined()
    expect(ev?.actor).toEqual({ side: 'party', index: 0 })
    expect(ev?.hits[0].target).toEqual({ side: 'party', index: 1 })
    expect(ev?.hits[0].hpAfter).toBe(1000 - (ev?.hits[0].amount ?? 0))
    expect(mage.hp).toBeLessThan(1000)
    expect(ev?.hits[0].amount).toBeGreaterThanOrEqual(20)
    expect(e.getState().log).toContain('ゆうしゃ は こんらん で あばれた！')
    expect(enemy.hp).toBe(9999) // 敵は殴られていない
  })

  it('乱数 0 なら先頭の生存者（自分）を殴る。倒れた味方は選ばない', () => {
    const hero = ent({ id: 'h', hp: 1000, maxHp: 1000, atk: 20, status: { mad: 1 } })
    const mage = ent({ id: 'm', hp: 0 })
    const e = new BattleEngine([hero, mage], [ent({ id: 's', hp: 9999, maxHp: 9999, atk: 0 })], {
      rng: () => 0.99,
      statuses: STATUSES,
    })
    const ev = e.getState().events.find((x) => x.kind === 'attack')
    expect(ev?.hits[0].target).toEqual({ side: 'party', index: 0 }) // 生存者は自分だけ
  })

  it('混乱は持続ぶんだけで終わる。殴られる側が眠っていれば殴られて起きる', () => {
    const hero = ent({ id: 'h', hp: 1000, maxHp: 1000, atk: 20, status: { mad: 1 } })
    const mage = ent({
      id: 'm',
      name: 'まほう',
      hp: 1000,
      maxHp: 1000,
      atk: 0,
      status: { nap: 3 },
    })
    const e = new BattleEngine([hero, mage], [ent({ id: 's', hp: 9999, maxHp: 9999, atk: 0 })], {
      rng: () => 0.99,
      statuses: STATUSES,
    })
    expect(hero.status).toEqual({})
    expect(mage.status?.sleep ?? 0).toBeLessThan(3)
    expect(mage.status?.sleep).toBeUndefined() // 殴られて起きた
    expect(e.getState().phase).toBe('party-input')
  })

  it('混乱した敵は敵陣営の生存者（自分を含む）を殴る。味方は殴られない', () => {
    const hero = ent({ id: 'h', hp: 1000, maxHp: 1000, atk: 0 })
    const a = ent({ id: 'a', name: 'A', hp: 500, maxHp: 500, atk: 30, status: { mad: 2 } })
    const b = ent({ id: 'b', name: 'B', hp: 500, maxHp: 500, atk: 0 })
    const e = new BattleEngine([hero], [a, b], { rng: () => 0.99, statuses: STATUSES })
    e.selectAttack()
    const own = e
      .getState()
      .events.find((x) => x.kind === 'attack' && x.actor.side === 'enemy' && x.actor.index === 0)
    expect(own?.hits[0].target.side).toBe('enemy') // 混乱した A は敵陣営を殴る
    expect(b.hp).toBeLessThan(500)
  })

  it('混乱した敵が同士討ちで全滅したら勝利（ATB）', () => {
    const a = ent({ id: 'a', hp: 1, maxHp: 10, agi: 25, atk: 30, status: { mad: 5 } })
    const hero = ent({ id: 'h', hp: 1000, maxHp: 1000, agi: 1, atk: 0 })
    const e = new BattleEngine([hero], [a], {
      rng: () => 0,
      atb: { mode: 'wait' },
      statuses: STATUSES,
    })
    e.tick(2000) // a が満タン → 自分を殴って倒れる
    expect(a.hp).toBe(0)
    expect(e.getState().phase).toBe('victory')
  })

  it('行動不能は混乱に優先する', () => {
    const hero = ent({ id: 'h', hp: 1000, maxHp: 1000, atk: 20, status: { mad: 1, sleep: 1 } })
    const e = new BattleEngine([hero], [ent({ id: 's', hp: 9999, maxHp: 9999, atk: 0 })], {
      rng: () => 0,
      statuses: STATUSES,
    })
    expect(e.getState().events.some((x) => x.kind === 'attack' && x.actor.side === 'party')).toBe(
      false
    )
    expect(e.getState().events.some((x) => x.kind === 'notice')).toBe(true)
  })
})

describe('満了で戦闘不能（死の宣告）', () => {
  it('持続が尽きたら戦闘不能。数字なしの即死の記録（instantDeath）になる', () => {
    const hero = ent({ id: 'h', name: 'ゆうしゃ', hp: 300, maxHp: 300, atk: 0 })
    const mage = ent({ id: 'm', name: 'まほう', hp: 300, maxHp: 300, atk: 0, status: { doom: 2 } })
    const e = new BattleEngine([hero, mage], [ent({ id: 's', hp: 9999, maxHp: 9999, atk: 0 })], {
      rng: () => 0,
      statuses: STATUSES,
    })
    e.selectAttack()
    expect(mage.hp).toBe(300) // 敵は先頭のゆうしゃを殴る。1 手番目はカウント 2 → 1
    expect(mage.status?.doom).toBe(1)
    e.selectAttack()
    expect(mage.hp).toBe(0)
    expect(mage.status).toEqual({})
    const ev = statusEvents(e)[statusEvents(e).length - 1]
    expect(ev?.hits[0]).toMatchObject({ kind: 'damage', hpAfter: 0, instantDeath: true })
    expect(e.getState().log).toContain('まほう の しのせんこく の カウントが つきた……')
    expect(e.getState().phase).not.toBe('defeat') // 全滅ではない（ゆうしゃが生きている）
  })

  it('即死耐性（death の無効・吸収）の者は助かり、単に解ける', () => {
    for (const col of ['nullify', 'absorb'] as const) {
      const hero = ent({
        id: 'h',
        hp: 300,
        maxHp: 300,
        atk: 0,
        status: { doom: 1 },
        affinity: { [col]: ['death'] },
      })
      const e = new BattleEngine([hero], [ent({ id: 's', hp: 9999, maxHp: 9999, atk: 0 })], {
        rng: () => 0,
        statuses: STATUSES,
      })
      e.selectAttack()
      expect(hero.hp, col).toBeGreaterThan(0)
      expect(hero.status, col).toEqual({})
      expect(e.getState().log, col).toContain('E の しのせんこく が とけた！')
    }
  })

  it('cure で解けば倒れない', () => {
    const hero = ent({ id: 'h', hp: 300, maxHp: 300, atk: 0, status: { doom: 1 } })
    const e = new BattleEngine([hero], [ent({ id: 's', hp: 9999, maxHp: 9999, atk: 0 })], {
      rng: () => 0,
      statuses: STATUSES,
    })
    e.selectItem({ name: 'エスナ', effect: 'cure doom' })
    expect(hero.hp).toBeGreaterThan(0)
    expect(hero.status).toEqual({})
  })
})

describe('回復の反転の記録', () => {
  it('ゾンビへの回復はダメージとして記録され reversed が付く。ダメージは回復として記録される', () => {
    const hero = ent({ id: 'h', hp: 50, maxHp: 100, status: { zombie: 5 } })
    const e = new BattleEngine([hero], [ent({ id: 's', hp: 9999, maxHp: 9999, atk: 0 })], {
      rng: () => 0,
      statuses: STATUSES,
    })
    e.selectSpell({ name: 'ケアル', mp: 1, target: '味方単体', effect: 'heal 20..20' })
    const heal = e.getState().events.find((x) => x.kind === 'spell')
    expect(heal?.hits[0]).toMatchObject({ kind: 'damage', amount: 20, reversed: true })
    expect(hero.hp).toBeLessThanOrEqual(30)
    const hp = hero.hp
    // 全滅級の攻撃（敵の特技）が回復になる
    const skills: Record<string, SkillExecution> = {
      doom: { name: 'メテオ', target: '相手全体', effect: 'damage 9999..9999' },
    }
    const boss = ent({ id: 'b', hp: 9999, maxHp: 9999, atk: 0, actions: ['候補=doom'] })
    const hero2 = ent({ id: 'h2', hp: 50, maxHp: 1000, status: { zombie: 5 } })
    const hero3 = ent({ id: 'h3', hp: 50, maxHp: 1000 })
    const e2 = new BattleEngine([hero2, hero3], [boss], {
      rng: () => 0,
      statuses: STATUSES,
      skills,
    })
    e2.selectAttack()
    const meteor = e2.getState().events.find((x) => x.kind === 'skill')
    expect(meteor?.hits.map((h) => [h.target.index, h.kind, h.reversed ?? false])).toEqual([
      [0, 'heal', true],
      [1, 'damage', false],
    ])
    expect(hero2.hp).toBeGreaterThan(50) // 回復して生き延びた
    expect(hero3.hp).toBe(0) // 反転していない者は倒れた
    void hp
  })

  it('複数ヒットでも反転した向きとフラグがヒットごとに残る', () => {
    const hero = ent({ id: 'h', hp: 10, maxHp: 1000, status: { zombie: 5 } })
    const skills: Record<string, SkillExecution> = {
      rain: { name: 'れんぞく', target: '相手単体', effect: 'damage 5..5 回数=3' },
    }
    const boss = ent({ id: 'b', hp: 9999, maxHp: 9999, atk: 0, actions: ['候補=rain'] })
    const e = new BattleEngine([hero], [boss], { rng: () => 0, statuses: STATUSES, skills })
    e.selectAttack()
    const ev = e.getState().events.find((x) => x.kind === 'skill')
    expect(ev?.hits.map((h) => [h.kind, h.amount, h.round, h.reversed])).toEqual([
      ['heal', 5, 0, true],
      ['heal', 5, 1, true],
      ['heal', 5, 2, true],
    ])
  })
})

describe('宣言の無い状態（印だけ）・旧挙動不変', () => {
  it('宣言の無い id は手番が進んでも減らず、継続ダメージも行動不能も起きない', () => {
    const hero = ent({ id: 'h', hp: 1000, maxHp: 1000, status: { marker: 3, sleep: 2 } })
    const e = new BattleEngine([hero], [ent({ id: 's', hp: 9999, maxHp: 9999, atk: 0 })], {
      rng: () => 0,
      statuses: { poison: STATUSES.poison },
    })
    for (let i = 0; i < 4; i++) e.selectAttack()
    expect(hero.status).toEqual({ marker: 3, sleep: 2 })
    expect(e.getState().events.every((ev) => ev.kind === 'attack')).toBe(true)
  })

  /** 状態を使わない同じ戦闘を、宣言あり/なしで回して、状態・ログ・イベント・乱数の消費まで一致することを確かめる */
  const scripted = (statuses: Record<string, StatusDef> | undefined, atb: boolean) => {
    const r = makeRng([0.1, 0.9, 0.5, 0.3, 0.7, 0.2])
    const skills: Record<string, SkillExecution> = {
      ink: { name: 'すみ', target: '相手全体', effect: 'damage 3..9' },
    }
    const party = [ent({ id: 'h', hp: 200, maxHp: 200, atk: 12, agi: 9 }), ent({ id: 'm', atk: 3 })]
    const enemies = [
      ent({ id: 'a', hp: 90, maxHp: 90, atk: 9, actions: ['候補=ink | こうげき'] }),
      ent({ id: 'b', hp: 60, maxHp: 60, atk: 7 }),
    ]
    const e = new BattleEngine(party, enemies, {
      rng: r.rng,
      skills,
      ...(atb ? { atb: { mode: 'wait' as const } } : {}),
      ...(statuses ? { statuses } : {}),
    })
    for (let i = 0; i < 60 && !e.isOver(); i++) {
      if (atb) {
        e.tick(700)
        if (e.getState().phase === 'party-input') {
          if (i % 3 === 0)
            e.selectSpell({ name: 'メラ', mp: 1, target: '敵全体', effect: 'damage 4..8' })
          else e.selectAttack()
        }
      } else if (i % 3 === 0) {
        e.selectSpell({ name: 'メラ', mp: 1, target: '敵全体', effect: 'damage 4..8' })
      } else e.selectAttack()
    }
    return JSON.stringify({ s: e.getState(), calls: r.calls() })
  }
  it.each([false, true])('状態を使わない戦闘は、宣言を足しても完全に同じ（ATB=%s）', (atb) => {
    const plain = scripted(undefined, atb)
    expect(scripted({}, atb)).toBe(plain)
    expect(scripted(STATUSES, atb)).toBe(plain)
  })
})

describe('永久ロックの安全弁', () => {
  it('敵が毎ターン睡眠を付け直し続けても、エンジンは固まらず（有限の手数で）制御を返す', () => {
    const hero = ent({ id: 'h', hp: 1_000_000, maxHp: 1_000_000, atk: 0, status: { sleep: 99 } })
    const skills: Record<string, SkillExecution> = {
      lull: { name: 'ララバイ', target: '相手単体', effect: 'status sleep duration=99' },
    }
    const boss = ent({ id: 'b', hp: 9999, maxHp: 9999, atk: 0, actions: ['候補=lull'] })
    const e = new BattleEngine([hero], [boss], { rng: () => 0, statuses: STATUSES, skills })
    // 1000 手番の安全弁で止まる。まだ眠ったままでコマンド待ち
    expect(e.getState().phase).toBe('party-input')
    expect(hero.status?.sleep).toBeGreaterThan(0)
    // 眠ったままの入力は無効で、再び解決を試みても例外なく戻る
    expect(() => e.selectAttack()).not.toThrow()
    expect(
      e.getState().events.every((ev) => ev.kind !== 'attack' || ev.actor.side === 'enemy')
    ).toBe(true)
  })

  it('持続が有限なら睡眠は必ず明ける（99 ターンで解ける）', () => {
    const hero = ent({ id: 'h', hp: 1_000_000, maxHp: 1_000_000, atk: 0, status: { sleep: 99 } })
    const e = new BattleEngine([hero], [ent({ id: 's', hp: 9999, maxHp: 9999, atk: 0 })], {
      rng: () => 0,
      statuses: STATUSES,
    })
    expect(hero.status).toEqual({})
    expect(e.getState().eventTotal).toBeGreaterThanOrEqual(99 + 99) // 99 手番ぶんの知らせと、敵の通常攻撃
  })
})

describe('自分に付ける・付けたばかりの状態', () => {
  it('敵が自分に付けた状態は、付けた手番の終わりに減らない', () => {
    const hero = ent({ id: 'h', hp: 1000, maxHp: 1000, atk: 0 })
    const skills: Record<string, SkillExecution> = {
      guard: { name: 'ぼうぎょ', target: '自分', effect: 'status poison duration=3' },
    }
    const boss = ent({ id: 'b', hp: 9999, maxHp: 9999, atk: 0, actions: ['候補=guard'] })
    const e = new BattleEngine([hero], [boss], { rng: () => 0, statuses: STATUSES, skills })
    e.selectAttack()
    expect(boss.status?.poison).toBe(3) // 付けた手番の終わりでは 3 のまま
    e.selectAttack()
    // 2 手番目: 付け直し（3）。付けた手番の終わりでは減らない
    expect(boss.status?.poison).toBe(3)
  })

  it('従来ターン制: 味方が仲間に付けた状態も、味方側の手番の終わりに減らない', () => {
    const hero = ent({ id: 'h', hp: 1000, maxHp: 1000, atk: 0 })
    const mage = ent({ id: 'm', hp: 1000, maxHp: 1000, atk: 0 })
    const e = new BattleEngine([hero, mage], [ent({ id: 's', hp: 9999, maxHp: 9999, atk: 0 })], {
      rng: () => 0,
      statuses: STATUSES,
    })
    e.selectSpell({ name: 'どく', mp: 1, target: '味方全体', effect: 'status poison duration=3' })
    expect(hero.status?.poison).toBe(3)
    expect(mage.status?.poison).toBe(3)
    e.selectAttack() // 次の味方の手番の終わりに初めて 3 → 2
    expect(hero.status?.poison).toBe(2)
    expect(mage.status?.poison).toBe(2)
  })

  it('全員に付ける（こちら全員がゾンビ）：味方全体への付与で全員が反転する', () => {
    const party = [ent({ id: 'a', hp: 50, maxHp: 100 }), ent({ id: 'b', hp: 50, maxHp: 100 })]
    const skills: Record<string, SkillExecution> = {
      curse: { name: 'のろい', target: '相手全体', effect: 'status zombie' },
    }
    const boss = ent({ id: 'x', hp: 9999, maxHp: 9999, atk: 0, actions: ['候補=curse'] })
    const e = new BattleEngine(party, [boss], { rng: () => 0, statuses: STATUSES, skills })
    e.selectAttack()
    expect(party.map((p) => p.status?.zombie)).toEqual([5, 5])
  })
})

describe('付与の成功率（エンジン経由）', () => {
  it('耐性を持つ敵には付かず、付かなかったときは「きかなかった」', () => {
    const boss = ent({
      id: 'b',
      name: 'ボス',
      hp: 9999,
      maxHp: 9999,
      atk: 0,
      affinity: { nullify: ['sleep'] },
    })
    const e = new BattleEngine([ent({ id: 'h' })], [boss], { rng: () => 0, statuses: STATUSES })
    e.selectSpell({ name: 'スリプル', mp: 1, target: '敵単体', effect: 'status sleep 確率=99' })
    expect(boss.status?.sleep).toBeUndefined()
    expect(e.getState().log).toContain('ボス には きかなかった！')
  })

  it('成長ぶん（statusChanceBonus）は使い手の値が効く', () => {
    const cast = (bonus: number | undefined) => {
      const boss = ent({ id: 'b', hp: 9999, maxHp: 9999, atk: 0 })
      const hero = ent({ id: 'h', ...(bonus !== undefined ? { statusChanceBonus: bonus } : {}) })
      const e = new BattleEngine([hero], [boss], { rng: () => 0.85, statuses: STATUSES })
      e.selectSpell({ name: 'スリプル', mp: 1, target: '敵単体', effect: 'status sleep 確率=50' })
      return boss.status?.sleep
    }
    expect(cast(undefined)).toBeUndefined() // 50% < 0.85 で外れる
    expect(cast(40)).toBe(1) // 50 + 40 = 90% > 0.85 で付く。宣言の持続 2 のうち、眠った敵の最初の手番で 1 減る
  })
})

describe('状態を付ける・解く行動の記録（MISS にしない）', () => {
  const run = (effect: string, enemyOver: Partial<BattleEntity> = {}) => {
    const boss = ent({ id: 'b', hp: 9999, maxHp: 9999, atk: 0, ...enemyOver })
    const hero = ent({ id: 'h', status: { poison: 3 } })
    const e = new BattleEngine([hero], [boss], { rng: () => 0, statuses: STATUSES })
    e.selectSpell({ name: 'テスト', mp: 1, target: '敵単体', effect })
    return e.getState().events.find((x) => x.kind === 'spell')
  }
  it('付いたときは hits に MISS を出さない', () => {
    expect(run('status poison')?.hits).toEqual([])
  })
  it('効かなかった（耐性・確率外れ）ときは従来どおり MISS', () => {
    expect(
      run('status poison', { affinity: { nullify: ['poison'] } })?.hits.map((h) => h.kind)
    ).toEqual(['miss'])
  })
  it('解いたときも MISS にしない。付いていなければ MISS', () => {
    expect(run('cure poison', { status: { poison: 2 } })?.hits).toEqual([])
    expect(run('cure poison')?.hits.map((h) => h.kind)).toEqual(['miss'])
  })
  it('宣言の無い印は従来どおり MISS のまま（旧挙動不変）', () => {
    expect(run('status marker')?.hits.map((h) => h.kind)).toEqual(['miss'])
  })
})

describe('反撃・死亡時の行動で付けた状態は、その手番の終わりに減らない', () => {
  const skills: Record<string, SkillExecution> = {
    lull: { name: 'ララバイ', target: '相手単体', effect: 'status sleep duration=1' },
  }
  const mkBoss = (over: Partial<BattleEntity> = {}) =>
    ent({ id: 'b', name: 'ボス', hp: 9999, maxHp: 9999, atk: 0, counters: ['候補=lull'], ...over })

  it('従来ターン制: 反撃で付いた睡眠 1 は次の味方の手番を飛ばす（付いた手番では解けない）', () => {
    const hero = ent({ id: 'h', name: 'ゆうしゃ', hp: 1000, maxHp: 1000, atk: 20 })
    const e = new BattleEngine([hero], [mkBoss()], { rng: () => 0, statuses: STATUSES, skills })
    e.selectAttack()
    const log = e.getState().log
    const slept = log.indexOf('ゆうしゃ は ねむり になった！')
    const woke = log.indexOf('ゆうしゃ の ねむり が とけた！')
    const bossAttack = log.indexOf('ボス の こうげき！')
    expect(slept).toBeGreaterThanOrEqual(0)
    expect(bossAttack).toBeGreaterThan(slept)
    expect(woke).toBeGreaterThan(bossAttack) // 敵の手番のあと、飛ばされた次の手番の終わりで解ける
  })

  it('ATB: 反撃で付いた睡眠 1 は、行動した本人の手番の終わりには減らない', () => {
    const hero = ent({ id: 'h', name: 'ゆうしゃ', hp: 1000, maxHp: 1000, atk: 20, agi: 50 })
    const boss = mkBoss({ agi: 1 })
    const e = new BattleEngine([hero], [boss], {
      rng: () => 0,
      statuses: STATUSES,
      skills,
      atb: { mode: 'wait' },
    })
    for (let i = 0; i < 20 && e.getState().phase !== 'party-input'; i++) e.tick(700)
    expect(e.getState().phase).toBe('party-input')
    e.selectAttack()
    expect(hero.status?.sleep).toBe(1) // 付いた手番の終わりでは 1 のまま
  })

  it('従来ターン制: 宣言のある状態を敵が味方に付けたときは従来どおり、味方の次の手番まで減らない', () => {
    const hero = ent({ id: 'h', name: 'ゆうしゃ', hp: 1000, maxHp: 1000, atk: 20 })
    const skl: Record<string, SkillExecution> = {
      lull2: { name: 'ララバイ', target: '相手単体', effect: 'status sleep duration=1' },
    }
    const boss = ent({
      id: 'b',
      name: 'ボス',
      hp: 9999,
      maxHp: 9999,
      atk: 0,
      actions: ['候補=lull2'],
    })
    const e = new BattleEngine([hero], [boss], { rng: () => 0, statuses: STATUSES, skills: skl })
    e.selectAttack() // 味方の手番 → 敵が眠らせる
    const log = e.getState().log
    expect(log.indexOf('ゆうしゃ の ねむり が とけた！')).toBeGreaterThan(
      log.indexOf('ゆうしゃ は ねむり になった！')
    )
    // 眠らされた手番の次の味方の手番は、飛ばされてから解ける（敵が付けた分は味方の次の手番まで減らない）
    const stuck = log.indexOf('ゆうしゃ は ねむり で うごけない！')
    expect(stuck).toBeGreaterThan(log.indexOf('ゆうしゃ は ねむり になった！'))
    expect(log.indexOf('ゆうしゃ の ねむり が とけた！')).toBeGreaterThan(stuck)
  })
})

describe('死亡時の行動で後ろの敵に付けた状態は、通常の行動と同じ数え方', () => {
  const MARK: Record<string, StatusDef> = {
    ...STATUSES,
    mark: def('mark', { name: 'しるし', duration: '3' }),
  }
  const skills: Record<string, SkillExecution> = {
    brand: { name: 'しるし', target: '仲間全体', effect: 'status mark duration=1' },
  }
  // A は毒の継続ダメージで倒れ、死亡時の行動で仲間（B）へ持続 1 の印を付ける
  const mkA = () =>
    ent({
      id: 'a',
      name: 'A',
      hp: 5,
      maxHp: 5,
      atk: 0,
      agi: 50,
      status: { poison: 3 },
      onDeath: '候補=brand',
    })
  const mkB = (agi: number) =>
    ent({ id: 'b', name: 'B', hp: 9999, maxHp: 9999, atk: 0, agi, def: 9999 })

  it('従来ターン制: 毒で倒れた敵の死亡時の行動で後ろの敵に付いた持続 1 は、その敵の手番の終わりに解ける', () => {
    const hero = ent({ id: 'h', name: 'ゆうしゃ', hp: 1000, maxHp: 1000, atk: 0, def: 9999 })
    const b = mkB(1)
    const e = new BattleEngine([hero], [mkA(), b], { rng: () => 0, statuses: MARK, skills })
    e.selectAttack('b')
    expect(e.getState().log).toContain('B の こうげき！')
    expect(b.status?.mark).toBeUndefined()
  })

  it('ATB: 毒で倒れた敵の死亡時の行動で後ろの敵に付いた持続 1 は、その敵の手番の終わりに解ける', () => {
    const hero = ent({ id: 'h', name: 'ゆうしゃ', hp: 1000, maxHp: 1000, atk: 0, agi: 1 })
    const b = mkB(20)
    const e = new BattleEngine([hero], [mkA(), b], {
      rng: () => 0,
      statuses: MARK,
      skills,
      atb: { mode: 'wait' },
    })
    for (let i = 0; i < 60 && !e.getState().log.includes('B の こうげき！'); i++) e.tick(300)
    expect(e.getState().log).toContain('B は しるし になった！')
    expect(e.getState().log).toContain('B の こうげき！')
    expect(b.status?.mark).toBeUndefined()
  })
})

describe('状態名の控え（イベントの statusLabels）', () => {
  it('宣言だけして一度も状態が付かない戦闘では、イベントに付かない（旧挙動不変）', () => {
    const e = new BattleEngine(
      [ent({ atk: 20 })],
      [ent({ id: 's', hp: 9999, maxHp: 9999, atk: 0 })],
      {
        rng: () => 0,
        statuses: STATUSES,
      }
    )
    e.selectAttack()
    expect(e.getState().events.every((ev) => !('statusLabels' in ev))).toBe(true)
  })
  it('状態が付いたら、その行動を記録した時点の全員の状態名が付く。全員から消えたことも伝える', () => {
    const hero = ent({ id: 'h', hp: 1000, maxHp: 1000, atk: 20, status: { poison: 1 } })
    const e = new BattleEngine([hero], [ent({ id: 's', hp: 9999, maxHp: 9999, atk: 0 })], {
      rng: () => 0,
      statuses: STATUSES,
    })
    e.selectAttack()
    const evs = e.getState().events
    expect(evs[0].statusLabels).toEqual({ party: [['どく']], enemies: [[]] })
    e.selectAttack()
    expect(e.getState().events[e.getState().events.length - 1]?.statusLabels).toEqual({
      party: [[]],
      enemies: [[]],
    })
  })
})
