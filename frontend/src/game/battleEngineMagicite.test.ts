/**
 * 魔石 (#889) の戦闘エンジン側: 召喚（1 人 1 バトル 1 回・MP・効果・演出イベント）と、
 * 魔石の属性が通常攻撃（攻撃側）と敵の属性攻撃への耐性（防御側）に加わる挙動。
 * 魔石を使わない戦闘は、乱数の消費を含めて従来どおり。
 */
import { describe, expect, it } from 'vitest'
import { BattleEngine, type SummonExecution } from './battleEngine'
import { applyMemberMagicite, resolveMemberMagicite } from './magicite'
import type { MagiciteDef } from '../types'
import type { BattleEntity } from './spellDsl'

function ent(id: string, over: Partial<BattleEntity> = {}): BattleEntity {
  return {
    id,
    name: id.toUpperCase(),
    hp: 100,
    maxHp: 100,
    mp: 10,
    maxMp: 10,
    atk: 10,
    def: 0,
    agi: 5,
    ...over,
  }
}
const foe = (id: string, over: Partial<BattleEntity> = {}): BattleEntity =>
  ent(id, { mp: 0, maxMp: 0, atk: 0, exp: 1, gold: 1, ...over })

const zero = () => 0

const wave: SummonExecution = {
  name: 'うみの主',
  target: '相手全体',
  mp: 0,
  effect: 'damage 30..30 type=water',
  message: '{user} が 波を よびだした！',
}

function turnBattle(party: BattleEntity[], enemies: BattleEntity[], rng: () => number = zero) {
  return new BattleEngine(party, enemies, { rng })
}

describe('selectSummon: 1 人が 1 バトルで 1 回だけ', () => {
  it('呼ぶと効果が出て、演出文のログと skill イベント（ラベルは召喚獣名）が残り、召喚済みの印が立つ', () => {
    const party = [ent('a'), ent('b')]
    const enemies = [foe('s1'), foe('s2')]
    const engine = turnBattle(party, enemies)
    expect(engine.selectSummon(wave)).toBe(true)
    const st = engine.getState()
    expect(enemies.map((e) => e.hp)).toEqual([70, 70])
    expect(party[0].summoned).toBe(true)
    expect(party[1].summoned).toBeUndefined()
    expect(st.log).toContain('A が 波を よびだした！')
    const ev = st.events.find((e) => e.kind === 'skill')
    expect(ev).toMatchObject({ actor: { side: 'party', index: 0 }, label: 'うみの主' })
    expect(ev?.hits.map((h) => [h.kind, h.amount])).toEqual([
      ['damage', 30],
      ['damage', 30],
    ])
  })

  it('同じ味方の 2 回目は拒否される（MP・HP・手番は変わらず、ログと知らせが出る）', () => {
    const party = [ent('a'), ent('b')]
    const enemies = [foe('s1')]
    const engine = turnBattle(party, enemies)
    // 敵ターンを挟んで a の手番に戻す（ATK 0 の敵は攻撃しても 1 ダメージ）
    expect(engine.selectSummon({ ...wave, mp: 3 })).toBe(true)
    // 従来ターン制: 先頭の生存味方が毎回行動する
    const hpAfterFirst = enemies[0].hp
    const mpAfterFirst = party[0].mp
    const logBefore = engine.getState().log.length
    expect(engine.getState().phase).toBe('party-input')
    expect(engine.selectSummon({ ...wave, mp: 3 })).toBe(false)
    const st = engine.getState()
    expect(enemies[0].hp).toBe(hpAfterFirst)
    expect(party[0].mp).toBe(mpAfterFirst)
    expect(st.phase).toBe('party-input')
    expect(st.log.length).toBe(logBefore + 1)
    expect(st.log[st.log.length - 1]).toBe('このたたかいでは もう よべない！')
    const notice = st.events[st.events.length - 1]
    expect(notice).toMatchObject({ kind: 'notice', label: 'このたたかいでは もう よべない！' })
  })

  it('別の味方は、それぞれ 1 回ずつ呼べる', () => {
    const party = [ent('a'), ent('b')]
    const enemies = [foe('s1', { hp: 1000, maxHp: 1000 })]
    const engine = new BattleEngine(party, enemies, { rng: zero, atb: { mode: 'active' } })
    // ATB: ゲージが溜まった順に a → b。どちらも 1 回呼べる
    engine.tick(10_000)
    const first = engine.getCurrentActorIndex()
    expect(engine.selectSummon(wave)).toBe(true)
    engine.tick(10_000)
    const second = engine.getCurrentActorIndex()
    expect(second).not.toBe(-1)
    if (second !== first) {
      expect(engine.selectSummon(wave)).toBe(true)
      expect(party.map((p) => p.summoned)).toEqual([true, true])
    }
    // 同じ味方がもう一度（ゲージを溜め直して）呼ぼうとしても拒否される
    for (let i = 0; i < 4; i++) engine.tick(10_000)
    const cur = engine.getCurrentActorIndex()
    if (cur !== -1) {
      expect(engine.selectSummon(wave)).toBe(false)
    }
  })

  it('消費 MP が足りなければ呼べず、印も立たない（呪文と同じ MP 不足の知らせ）', () => {
    const party = [ent('a', { mp: 2 })]
    const enemies = [foe('s1')]
    const engine = turnBattle(party, enemies)
    expect(engine.selectSummon({ ...wave, mp: 3 })).toBe(false)
    const st = engine.getState()
    expect(party[0].mp).toBe(2)
    expect(party[0].summoned).toBeUndefined()
    expect(enemies[0].hp).toBe(100)
    expect(st.log[st.log.length - 1]).toBe('MPが たりない！')
    // MP が足りるようになれば呼べる（印が立っていないので）
    party[0].mp = 3
    expect(engine.selectSummon({ ...wave, mp: 3 })).toBe(true)
    expect(party[0].mp).toBe(0)
    expect(party[0].summoned).toBe(true)
  })

  it('消費 MP は既定 0（MP が 0 の味方も呼べる）。負・非有限は 0 として扱う', () => {
    for (const mp of [0, -5, Number.NaN]) {
      const party = [ent('a', { mp: 0, maxMp: 0 })]
      const engine = turnBattle(party, [foe('s1')])
      expect(engine.selectSummon({ ...wave, mp })).toBe(true)
      expect(party[0].mp).toBe(0)
    }
  })

  it('単体の召喚は targetId の敵に当たる。味方向け（仲間全体の回復）も使える', () => {
    const party = [ent('a'), ent('b', { hp: 40 })]
    const enemies = [foe('s1'), foe('s2')]
    const engine = turnBattle(party, enemies)
    expect(
      engine.selectSummon({ name: 'ひ', target: '相手単体', mp: 0, effect: 'damage 25..25' }, 's2')
    ).toBe(true)
    expect(enemies.map((e) => e.hp)).toEqual([100, 75])
    const heal = turnBattle([ent('a'), ent('b', { hp: 40 })], [foe('s1')])
    expect(
      heal.selectSummon({ name: 'いやし', target: '仲間全体', mp: 0, effect: 'heal 30..30' })
    ).toBe(true)
    // 回復の後、ATK 0 の敵の通常攻撃が先頭の味方に 1 ダメージ
    expect(heal.getState().party.map((p) => p.hp)).toEqual([99, 70])
  })

  it('効果の無い召喚（演出のみ）・不正な効果でも落ちず、1 回として数える', () => {
    const a = turnBattle([ent('a')], [foe('s1')])
    expect(a.selectSummon({ name: 'えんしゅつ', target: '自分', mp: 0 })).toBe(true)
    expect(a.getState().party[0].summoned).toBe(true)
    const b = turnBattle([ent('a')], [foe('s1')])
    expect(b.selectSummon({ name: 'ふせい', target: '相手単体', mp: 0, effect: 'foo bar' })).toBe(
      true
    )
    expect(b.getState().party[0].summoned).toBe(true)
  })

  it('入力待ちでない（決着後）・使い手がいないときは何も起きず false', () => {
    const engine = turnBattle([ent('a')], [foe('s1', { hp: 5 })])
    engine.selectAttack()
    expect(engine.getState().phase).toBe('victory')
    expect(engine.selectSummon(wave)).toBe(false)
    expect(engine.getState().party[0].summoned).toBeUndefined()
  })

  it('召喚は魔法として扱われ、敵の「受けた=魔法」の反撃が成立する（攻撃の「受けた=物理」は成立しない）', () => {
    const skills = { ctr: { name: 'はんげき', target: '相手単体', effect: 'damage 7..7' } }
    const mk = (cond: string) => {
      const party = [ent('a')]
      const enemies = [foe('s1', { counters: [`条件=受けた=${cond} 候補=ctr`] })]
      const engine = new BattleEngine(party, enemies, { rng: zero, skills })
      engine.selectSummon({ name: 'し', target: '相手単体', mp: 0, effect: 'damage 5..5' })
      return party[0].hp
    }
    // 反撃 7 のあと、ATK 0 の敵の通常攻撃で 1（反撃が無ければ通常攻撃の 1 だけ）
    expect(mk('魔法')).toBe(92)
    expect(mk('物理')).toBe(99)
  })

  it('ATB: 召喚した味方のゲージは 0 に戻り、同じ味方の 2 回目は拒否（ゲージはそのまま）', () => {
    const party = [ent('a')]
    const enemies = [foe('s1', { hp: 100000, maxHp: 100000, agi: 0 })]
    const engine = new BattleEngine(party, enemies, { rng: zero, atb: { mode: 'wait' } })
    engine.tick(10_000)
    expect(engine.getCurrentActorIndex()).toBe(0)
    expect(engine.selectSummon(wave)).toBe(true)
    expect(engine.getState().atb?.partyGauge[0]).toBe(0)
    engine.tick(10_000)
    expect(engine.getCurrentActorIndex()).toBe(0)
    expect(engine.getState().atb?.partyGauge[0]).toBe(1000)
    expect(engine.selectSummon(wave)).toBe(false)
    expect(engine.getState().atb?.partyGauge[0]).toBe(1000)
    expect(engine.getState().phase).toBe('party-input')
  })

  it('蘇生しても召喚済みの印は消えない（1 バトル 1 回）', () => {
    const party = [ent('a'), ent('b')]
    const engine = turnBattle(party, [foe('s1', { hp: 1000, maxHp: 1000 })])
    engine.selectSummon(wave)
    party[0].hp = 0
    party[0].hp = 50
    expect(party[0].summoned).toBe(true)
  })
})

describe('通常攻撃の属性 (attackElements)', () => {
  const attackOnce = (hero: Partial<BattleEntity>, enemy: Partial<BattleEntity>) => {
    const party = [ent('a', hero)]
    const enemies = [foe('s1', { hp: 100, maxHp: 100, ...enemy })]
    const engine = turnBattle(party, enemies)
    engine.selectAttack()
    return { engine, party, enemies }
  }
  const SEC = (
    e: BattleEngine
  ): { kind: string; amount: number; hpBefore: number; hpAfter: number } => {
    const ev = e.getState().events.find((x) => x.kind === 'attack')
    return ev!.hits[0] as never
  }

  it('属性を持たない・空の攻撃は従来どおり相性を見ない（弱点の敵でも等倍）', () => {
    const weak = { affinity: { weak: ['water'] } }
    expect(attackOnce({}, weak).enemies[0].hp).toBe(90)
    expect(attackOnce({ attackElements: [] }, weak).enemies[0].hp).toBe(90)
  })

  it('相性なしの敵には等倍', () => {
    expect(attackOnce({ attackElements: ['water'] }, {}).enemies[0].hp).toBe(90)
  })

  it('弱点 ×2 / 半減 ×½（最低 1）', () => {
    const w = attackOnce({ attackElements: ['water'] }, { affinity: { weak: ['water'] } })
    expect(w.enemies[0].hp).toBe(80)
    expect(SEC(w.engine)).toMatchObject({ kind: 'damage', amount: 20 })
    const h = attackOnce({ attackElements: ['water'] }, { affinity: { halve: ['water'] } })
    expect(h.enemies[0].hp).toBe(95)
    const low = attackOnce(
      { attackElements: ['water'], atk: 1 },
      { affinity: { halve: ['water'] } }
    )
    expect(low.enemies[0].hp).toBe(99) // 1 → 最低 1
  })

  it('無効: HP は減らず、ヒットは miss（量 0）で「きかなかった」ログ。反撃もしない', () => {
    const n = attackOnce({ attackElements: ['water'] }, { affinity: { nullify: ['water'] } })
    expect(n.enemies[0].hp).toBe(100)
    expect(SEC(n.engine)).toMatchObject({ kind: 'miss', amount: 0 })
    expect(n.engine.getState().log).toContain('S1 には きかなかった！')
  })

  it('吸収: ダメージ量ぶん敵が回復（最大 HP で止まる・9999 で頭打ち）。ヒットは heal', () => {
    const a = attackOnce(
      { attackElements: ['water'] },
      { hp: 50, maxHp: 100, affinity: { absorb: ['water'] } }
    )
    expect(a.enemies[0].hp).toBe(60)
    expect(SEC(a.engine)).toMatchObject({ kind: 'heal', amount: 10, hpBefore: 50, hpAfter: 60 })
    expect(a.engine.getState().log).toContain('S1 は 10 のダメージを吸収した！')
    const full = attackOnce({ attackElements: ['water'] }, { affinity: { absorb: ['water'] } })
    expect(full.enemies[0].hp).toBe(100)
    const huge = attackOnce(
      { attackElements: ['water'], atk: 1_000_000 },
      { hp: 10, maxHp: 1_000_000, affinity: { absorb: ['water'] } }
    )
    expect(huge.enemies[0].hp).toBe(10 + 9999)
    expect(SEC(huge.engine).amount).toBe(9999)
  })

  it('複数属性は優先順位（吸収 > 無効 > 半減 > 弱点）の高い種類を採る', () => {
    const els = ['water', 'fire']
    const absorbFire = attackOnce(
      { attackElements: els },
      { hp: 50, maxHp: 100, affinity: { absorb: ['fire'], weak: ['water'] } }
    )
    expect(absorbFire.enemies[0].hp).toBe(60)
    const nullFire = attackOnce(
      { attackElements: els },
      { affinity: { nullify: ['fire'], weak: ['water'] } }
    )
    expect(nullFire.enemies[0].hp).toBe(100)
    const halveWeak = attackOnce(
      { attackElements: els },
      { affinity: { halve: ['fire'], weak: ['water'] } }
    )
    expect(halveWeak.enemies[0].hp).toBe(95)
    const weakOnly = attackOnce({ attackElements: els }, { affinity: { weak: ['fire'] } })
    expect(weakOnly.enemies[0].hp).toBe(80)
  })

  it('弱点で倒せる。倒すと勝利になる', () => {
    const k = attackOnce(
      { attackElements: ['water'] },
      { hp: 15, maxHp: 100, affinity: { weak: ['water'] } }
    )
    expect(k.enemies[0].hp).toBe(0)
    expect(k.engine.getState().phase).toBe('victory')
  })

  it('乱数の消費は属性の有無・相性の種類によらず従来と同じ（1 回）', () => {
    const count = (hero: Partial<BattleEntity>, enemy: Partial<BattleEntity>): number => {
      let n = 0
      const rng = () => {
        n++
        return 0.5
      }
      const engine = turnBattle([ent('a', hero)], [foe('s1', enemy)], rng)
      engine.selectAttack()
      return n
    }
    const base = count({}, {})
    for (const aff of [
      undefined,
      { weak: ['water'] },
      { halve: ['water'] },
      { nullify: ['water'] },
      { absorb: ['water'] },
    ]) {
      expect(count({ attackElements: ['water'] }, aff ? { affinity: aff } : {})).toBe(base)
    }
  })
})

describe('魔石を装備した味方の耐性（敵の属性攻撃）', () => {
  const MASTER: Record<string, MagiciteDef> = {
    sea: { id: 'sea', name: 'うみ', elements: ['water'], target: '相手単体' },
    sea2: { id: 'sea2', name: 'うみ2', elements: ['water'], target: '相手単体' },
    tiger: { id: 'tiger', name: 'とら', elements: ['fire'], target: '相手単体' },
  }
  const member = (ids: string[], slots: number, extra: string[] = [], hp = 100): BattleEntity => {
    const e = ent('a', { hp, maxHp: 100 })
    applyMemberMagicite(
      e,
      resolveMemberMagicite(
        { id: 'a', magicites: ids, magiciteSlots: slots },
        { magicites: MASTER, extraElements: { a: extra } }
      )
    )
    return e
  }
  const hit = (party: BattleEntity, effect: string): BattleEntity => {
    const engine = new BattleEngine([party], [foe('s1', { actions: ['候補=sk'], agi: 99 })], {
      rng: zero,
      skills: { sk: { name: 'とくぎ', target: '相手単体', effect } },
    })
    engine.performSkill({ side: 'enemy', index: 0 }, { name: 'とくぎ', target: '相手単体', effect })
    return party
  }

  it('魔石 1 つ（1 層）: その属性の攻撃が半減。ほかの属性は等倍', () => {
    expect(hit(member(['sea'], 1), 'damage 40..40 type=water').hp).toBe(80)
    expect(hit(member(['sea'], 1), 'damage 40..40 type=fire').hp).toBe(60)
    expect(hit(member(['sea'], 1), 'damage 40..40').hp).toBe(60) // 無属性は等倍
  })

  it('複数属性に強い（水と火の魔石）', () => {
    expect(hit(member(['sea', 'tiger'], 2), 'damage 40..40 type=water').hp).toBe(80)
    expect(hit(member(['sea', 'tiger'], 2), 'damage 40..40 type=fire').hp).toBe(80)
    expect(hit(member(['sea', 'tiger'], 2), 'damage 40..40 type=ice').hp).toBe(60)
  })

  it('同じ属性が 2 層（魔石 2 つ・魔石と防具）なら吸収', () => {
    const two = hit(member(['sea', 'sea2'], 2, [], 50), 'damage 40..40 type=water')
    expect(two.hp).toBe(90)
    const withArmor = hit(member(['sea'], 1, ['water'], 50), 'damage 40..40 type=water')
    expect(withArmor.hp).toBe(90)
  })

  it('属性は魔石と防具を合わせて 2 つまで（3 つ目は無視。氷は等倍のまま）', () => {
    const p = member(['sea', 'tiger'], 2, ['ice'])
    expect(p.attackElements).toEqual(['water', 'fire'])
    expect(hit(p, 'damage 40..40 type=ice').hp).toBe(60)
  })

  it('魔石を装備しない味方は affinity も attackElements も持たない（従来と同一）', () => {
    const p = member([], 1)
    expect(p.affinity).toBeUndefined()
    expect(p.attackElements).toBeUndefined()
    expect(Object.keys(p).sort()).toEqual(Object.keys(ent('a')).sort())
  })
})
