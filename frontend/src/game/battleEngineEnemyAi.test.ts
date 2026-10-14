/**
 * 敵の行動パターン P1 (#835) のエンジン統合: 従来ターン制と ATB の両方で `行動:` が効く・acted が同じ意味・
 * 行動を書かない敵の挙動と rng の消費が不変、を確かめる。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BattleEngine } from './battleEngine'
import type { BattleEngineOptions, SkillExecution } from './battleEngine'
import type { BattleEntity } from './spellDsl'
import { parseMarkdown } from '../wasm/parser'
import { collectMasterData } from './rpgProjectFromDoc'
import { toSkillExecutions } from './enemyAi'
import { BUILTIN_SPELLS } from './builtin'

function ent(over: Partial<BattleEntity> = {}): BattleEntity {
  return {
    id: 'e',
    name: 'E',
    hp: 100,
    maxHp: 100,
    mp: 0,
    maxMp: 0,
    atk: 8, // 通常攻撃の与ダメージ = 8 + floor(rng*3)（def 0）
    def: 0,
    agi: 2,
    exp: 1,
    gold: 1,
    ...over,
  }
}

const INK: SkillExecution = {
  name: '墨',
  target: '相手全体',
  effect: 'damage 5..5',
  message: '{user}は 墨を はいた！',
}
const TENT: SkillExecution = { name: '触手', target: '相手単体', effect: 'damage 12..12' }
const SKILLS = { ink: INK, tent: TENT }

/** 呼ばれた回数を数える rng（固定値の列。尽きたら最後の値） */
function counting(...vals: number[]): { rng: () => number; calls: () => number } {
  let i = 0
  return { rng: () => vals[Math.min(i++, vals.length - 1)] ?? 0, calls: () => i }
}

afterEach(() => vi.restoreAllMocks())

describe('行動を書かない敵は挙動・乱数の消費とも不変', () => {
  it('enemyMemory は作られない（actions 無し / 空配列）', () => {
    const e1 = new BattleEngine([ent({ id: 'h' })], [ent({ id: 'a' })], { rng: () => 0 })
    expect(e1.getState().enemyMemory).toBeUndefined()
    const e2 = new BattleEngine([ent({ id: 'h' })], [ent({ id: 'a', actions: [] })], {
      rng: () => 0,
    })
    expect(e2.getState().enemyMemory).toBeUndefined()
  })

  it('従来ターン制: 敵 2 体の通常攻撃。ダメージの乱数 1 回ずつだけを消費し、先頭の生存者を殴る（固定値）', () => {
    const { rng, calls } = counting(0, 0.5, 0.99)
    const hero = ent({ id: 'hero', name: 'ゆうしゃ' })
    const mage = ent({ id: 'mage', name: 'まほうつかい' })
    const eng = new BattleEngine(
      [hero, mage],
      [ent({ id: 'a', name: 'A', hp: 999, maxHp: 999 }), ent({ id: 'b', name: 'B' })],
      { rng, skills: SKILLS } // 渡しても actions が無ければ使われない
    )
    eng.selectAttack() // 味方の攻撃: rng 1 回 (0)
    expect(calls()).toBe(3) // 味方 1 + 敵 2。それ以外の消費は無い
    // A が hero に 8+floor(0.5*3)=9、B が 8+floor(0.99*3)=10
    expect(hero.hp).toBe(100 - 9 - 10)
    expect(mage.hp).toBe(100)
    expect(eng.getState().log.slice(-4)).toEqual([
      'A の こうげき！',
      'ゆうしゃ は 9 の ダメージを うけた！',
      'B の こうげき！',
      'ゆうしゃ は 10 の ダメージを うけた！',
    ])
  })

  it('ATB: 敵の通常攻撃は、狙い 1 回 + ダメージ 1 回の乱数（従来どおり）', () => {
    const { rng, calls } = counting(0)
    const hero = ent({ id: 'hero', agi: 1 })
    const foe = ent({ id: 'foe', agi: 25 })
    const eng = new BattleEngine([hero], [foe], { rng, atb: {} })
    eng.tick(1000) // 敵ゲージ: 25 * 0.04 * 1000 = 1000 で満タン → 行動
    expect(hero.hp).toBe(92)
    expect(calls()).toBe(2)
    expect(eng.getState().enemyMemory).toBeUndefined()
  })
})

describe('行動: を持つ敵と持たない敵が同じ戦闘にいるとき', () => {
  it('持たない敵の狙いと乱数の消費は従来どおり（ターン制: 先頭の生存者・ダメージの 1 回だけ）', () => {
    const hero = ent({ id: 'hero', hp: 500, maxHp: 500 })
    const mage = ent({ id: 'mage', hp: 500, maxHp: 500 })
    const withAi = ent({ id: 'a', hp: 999, maxHp: 999, actions: ['条件=初手 候補=tent'] })
    const plain = ent({ id: 'b', hp: 999, maxHp: 999 })
    // 味方の攻撃 0、A: 候補 1 つ（抽選なし）の特技は乱数を使わない、B: ダメージ 8+floor(0.5*3)=9
    const { rng, calls } = counting(0, 0.5)
    const eng = new BattleEngine([hero, mage], [withAi, plain], { rng, skills: SKILLS })
    eng.selectAttack()
    expect(calls()).toBe(2)
    expect(hero.hp).toBe(500 - 12 - 9)
    expect(mage.hp).toBe(500)
    expect(eng.getState().enemyMemory).toEqual([{ acted: 1 }, { acted: 1 }])
  })

  it('ATB: 持たない敵は従来どおり狙い 1 回 + ダメージ 1 回', () => {
    const h1 = ent({ id: 'h1', hp: 500, maxHp: 500, agi: 1 })
    const h2 = ent({ id: 'h2', hp: 500, maxHp: 500, agi: 1 })
    const withAi = ent({ id: 'a', hp: 999, maxHp: 999, agi: 1, actions: ['候補=tent'] })
    const plain = ent({ id: 'b', hp: 999, maxHp: 999, agi: 25 })
    // 狙い 0.9 → 生存 2 人のうち index 1、ダメージ 0 → 8
    const { rng, calls } = counting(0.9, 0)
    const eng = new BattleEngine([h1, h2], [withAi, plain], { rng, atb: {}, skills: SKILLS })
    eng.tick(1000)
    expect(calls()).toBe(2)
    expect(h2.hp).toBe(492)
    expect(h1.hp).toBe(500)
    expect(eng.getState().enemyMemory).toEqual([{ acted: 0 }, { acted: 1 }])
  })
})

describe('対象= の上書きは単体の特技だけ', () => {
  it('相手全体の特技は 対象=HP最小 でも全員に当たり、単体の特技は HP 最小の味方に当たる', () => {
    const h1 = ent({ id: 'h1', hp: 100, maxHp: 100 })
    const h2 = ent({ id: 'h2', hp: 30, maxHp: 100 })
    const foe = ent({
      id: 'foe',
      hp: 999,
      maxHp: 999,
      actions: ['条件=初手 候補=ink 対象=HP最小', '候補=tent 対象=HP最小'],
    })
    const eng = new BattleEngine([h1, h2], [foe], { rng: () => 0, skills: SKILLS })
    eng.selectAttack()
    expect([h1.hp, h2.hp]).toEqual([95, 25]) // 墨は全体のまま
    eng.selectAttack()
    expect([h1.hp, h2.hp]).toEqual([95, 13]) // 触手（単体）は HP 最小の h2
  })

  it('自分の特技・全体の特技は 対象=全体 / 仲間 でも上書きされない。単体の特技は 対象=自分 で自分に向く', () => {
    const hero = ent({ id: 'hero', hp: 500, maxHp: 500 })
    const heal: SkillExecution = { name: '回復', target: '自分', effect: 'heal 10..10' }
    const foe = ent({ id: 'foe', hp: 50, maxHp: 100, actions: ['候補=heal 対象=全体'] })
    const eng = new BattleEngine([hero], [foe], { rng: () => 0, skills: { heal, tent: TENT } })
    eng.selectAttack()
    expect(foe.hp).toBe(50 - 8 + 10) // 味方の攻撃 8 のあと、自分の回復 10（全体指定で相手に向かない）
    expect(hero.hp).toBe(500)
    const foe2 = ent({ id: 'foe2', hp: 50, maxHp: 100, actions: ['候補=tent 対象=自分'] })
    const hero2 = ent({ id: 'hero2', hp: 500, maxHp: 500 })
    new BattleEngine([hero2], [foe2], { rng: () => 0, skills: SKILLS }).selectAttack()
    expect(hero2.hp).toBe(500)
    expect(foe2.hp).toBe(50 - 8 - 12) // 触手（単体）が 対象=自分 で自分に向く
  })
})

describe('仲間向けの特技は ランダム / HP最小 / 全体 で相手側に向かない', () => {
  it.each(['ランダム', 'HP最小', '全体'])(
    '仲間単体の回復に 対象=%s を付けても敵がプレイヤーを回復しない',
    (t) => {
      const mend: SkillExecution = { name: '手当て', target: '仲間単体', effect: 'heal 20..20' }
      const hero = ent({ id: 'hero', hp: 50, maxHp: 500 })
      const foe = ent({
        id: 'foe',
        hp: 100,
        maxHp: 500,
        actions: [`候補=mend 対象=${t}`],
      })
      const eng = new BattleEngine([hero], [foe], { rng: () => 0, skills: { mend } })
      eng.selectAttack()
      expect(hero.hp).toBe(50) // プレイヤーは回復しない
      expect(foe.hp).toBe(100 - 8 + 20) // 味方の攻撃 8 のあと、敵側の仲間（ここでは自分）が回復
    }
  )

  it('仲間全体・自分の特技も同様。対象=仲間 / 自分 は上書きする', () => {
    const mendAll: SkillExecution = { name: '手当て', target: '仲間全体', effect: 'heal 20..20' }
    const hero = ent({ id: 'hero', hp: 50, maxHp: 500 })
    const foe = ent({ id: 'foe', hp: 100, maxHp: 500, actions: ['候補=mendAll 対象=HP最小'] })
    new BattleEngine([hero], [foe], { rng: () => 0, skills: { mendAll } }).selectAttack()
    expect(hero.hp).toBe(50)
    expect(foe.hp).toBe(112)
    // 相手全体の特技に 対象=自分 を付けると自分に向く
    const hero2 = ent({ id: 'hero2', hp: 500, maxHp: 500 })
    const foe2 = ent({ id: 'foe2', hp: 100, maxHp: 500, actions: ['候補=ink 対象=自分'] })
    new BattleEngine([hero2], [foe2], { rng: () => 0, skills: SKILLS }).selectAttack()
    expect(hero2.hp).toBe(500)
    expect(foe2.hp).toBe(100 - 8 - 5)
  })
})

describe('同時全滅の判定（現状の挙動を固定）', () => {
  it('ターン制は敗北、ATB は勝利', () => {
    BUILTIN_SPELLS['test_mutual'] = (ctx) => {
      for (const t of ctx.targets) t.hp = 0
      ctx.caster.hp = 0
      return []
    }
    try {
      const mutual: SkillExecution = { name: '道連れ', target: '相手全体', builtin: 'test_mutual' }
      const hero = ent({ id: 'hero', hp: 500, maxHp: 500, agi: 1 })
      const foe = ent({ id: 'foe', hp: 999, maxHp: 999, actions: ['候補=mutual'] })
      const turn = new BattleEngine([hero], [foe], { rng: () => 0, skills: { mutual } })
      turn.selectAttack()
      expect(hero.hp).toBe(0)
      expect(foe.hp).toBe(0)
      expect(turn.getState().phase).toBe('defeat')

      const hero2 = ent({ id: 'hero2', hp: 500, maxHp: 500, agi: 1 })
      const foe2 = ent({ id: 'foe2', hp: 999, maxHp: 999, agi: 25, actions: ['候補=mutual'] })
      const atb = new BattleEngine([hero2], [foe2], { rng: () => 0, atb: {}, skills: { mutual } })
      atb.tick(1000)
      expect(hero2.hp).toBe(0)
      expect(foe2.hp).toBe(0)
      expect(atb.getState().phase).toBe('victory')
    } finally {
      delete BUILTIN_SPELLS['test_mutual']
    }
  })
})

describe('特技が見つからない警告は 1 度だけ', () => {
  it('同じ id の候補が何度選ばれても警告は 1 回', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const hero = ent({ id: 'hero', hp: 900, maxHp: 900 })
    const foe = ent({ id: 'foe', hp: 999, maxHp: 999, actions: ['候補=nothing'] })
    const eng = new BattleEngine([hero], [foe], { rng: () => 0, skills: SKILLS })
    eng.selectAttack()
    eng.selectAttack()
    eng.selectAttack()
    expect(warn).toHaveBeenCalledTimes(1)
  })
})

describe('従来ターン制: 行動: が効く', () => {
  it('初手だけ墨 → 以降は通常攻撃。acted は行動のたびに増える', () => {
    const hero = ent({ id: 'hero', name: 'ゆうしゃ', hp: 500, maxHp: 500 })
    const foe = ent({
      id: 'foe',
      name: 'タコ',
      hp: 999,
      maxHp: 999,
      actions: ['条件=初手 候補=ink'],
    })
    const eng = new BattleEngine([hero], [foe], { rng: () => 0, skills: SKILLS })
    expect(eng.getState().enemyMemory).toEqual([{ acted: 0 }])
    eng.selectAttack()
    expect(eng.getState().log).toContain('タコは 墨を はいた！')
    expect(hero.hp).toBe(495)
    expect(eng.getState().enemyMemory).toEqual([{ acted: 1 }])
    eng.selectAttack()
    expect(hero.hp).toBe(487) // 2 ターン目は通常攻撃 8
    expect(eng.getState().enemyMemory).toEqual([{ acted: 2 }])
    const kinds = eng
      .getState()
      .events.filter((e) => e.actor.side === 'enemy')
      .map((e) => e.kind)
    expect(kinds).toEqual(['skill', 'attack'])
  })

  it('HP<50% で行動が変わる（味方の攻撃で半分を割った次の敵ターンから）', () => {
    const hero = ent({ id: 'hero', atk: 30, hp: 900, maxHp: 900 })
    const foe = ent({
      id: 'foe',
      name: 'タコ',
      hp: 100,
      maxHp: 100,
      actions: ['条件=HP<50% 候補=tent'],
    })
    const eng = new BattleEngine([hero], [foe], { rng: () => 0, skills: SKILLS })
    eng.selectAttack() // foe 100 → 70。まだ 50% 以上 → 通常攻撃 8
    expect(foe.hp).toBe(70)
    expect(hero.hp).toBe(892)
    eng.selectAttack() // 70 → 40。50% 未満 → 触手 12
    expect(foe.hp).toBe(40)
    expect(hero.hp).toBe(880)
    expect(eng.getState().log).toContain('タコ は 触手 を つかった！')
  })

  it('仲間の数で行動が変わる（1 体だけになったら）。倒れた敵の acted は増えない', () => {
    const hero = ent({ id: 'hero', atk: 400, hp: 900, maxHp: 900 })
    const a = ent({ id: 'a', name: 'A', hp: 50, maxHp: 50, actions: ['条件=仲間<=0 候補=tent'] })
    const b = ent({
      id: 'b',
      name: 'B',
      hp: 500,
      maxHp: 500,
      actions: ['条件=仲間<=0 候補=tent'],
    })
    const eng = new BattleEngine([hero], [a, b], { rng: () => 0, skills: SKILLS })
    eng.selectAttack() // A を倒す。B は仲間 0 になって触手
    expect(a.hp).toBe(0)
    expect(hero.hp).toBe(900 - 12)
    expect(eng.getState().enemyMemory).toEqual([{ acted: 0 }, { acted: 1 }])
  })

  it('味方の生存数で行動が変わる', () => {
    const h1 = ent({ id: 'h1', name: 'H1', hp: 100, maxHp: 100 })
    const h2 = ent({ id: 'h2', name: 'H2', hp: 100, maxHp: 100 })
    const foe = ent({
      id: 'foe',
      name: 'F',
      hp: 999,
      maxHp: 999,
      actions: ['条件=味方<=1 候補=ink'],
    })
    const eng = new BattleEngine([h1, h2], [foe], { rng: () => 0, skills: SKILLS })
    eng.selectAttack() // 味方 2 人 → 通常攻撃（先頭の h1 に 8）
    expect(h1.hp).toBe(92)
    h2.hp = 0
    eng.selectAttack() // 味方 1 人 → 墨（相手全体 5）
    expect(h1.hp).toBe(87)
  })

  it('重み付き抽選は注入した rng で決まる（候補 2 つなら敵の行動ごとに 1 回消費）', () => {
    const hero = ent({ id: 'hero', hp: 500, maxHp: 500 })
    const foe = ent({ id: 'foe', hp: 999, maxHp: 999, actions: ['候補=ink:1 | tent:3'] })
    // 味方の攻撃 0、敵の抽選 0.1（総重み 4 の 0.4 → ink）、味方 0、抽選 0.5（2.0 → tent）。固定ダメージの効果は乱数を使わない
    const { rng, calls } = counting(0, 0.1, 0, 0.5)
    const eng = new BattleEngine([hero], [foe], { rng, skills: SKILLS })
    eng.selectAttack()
    expect(hero.hp).toBe(495)
    eng.selectAttack()
    expect(hero.hp).toBe(483)
    expect(calls()).toBe(4)
  })

  it('特技が見つからない候補は警告して通常攻撃になる', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const hero = ent({ id: 'hero', hp: 500, maxHp: 500 })
    const foe = ent({ id: 'foe', hp: 999, maxHp: 999, actions: ['候補=nothing'] })
    const eng = new BattleEngine([hero], [foe], { rng: () => 0, skills: SKILLS })
    eng.selectAttack()
    expect(hero.hp).toBe(492)
    expect(warn).toHaveBeenCalled()
    expect(eng.getState().enemyMemory).toEqual([{ acted: 1 }])
  })

  it('対象=HP最小 の通常攻撃は HP の少ない味方を殴る', () => {
    const h1 = ent({ id: 'h1', hp: 90 })
    const h2 = ent({ id: 'h2', hp: 20 })
    const foe = ent({
      id: 'foe',
      hp: 999,
      maxHp: 999,
      actions: ['候補=こうげき 対象=HP最小'],
    })
    const eng = new BattleEngine([h1, h2], [foe], { rng: () => 0 })
    eng.selectAttack()
    expect(h1.hp).toBe(90)
    expect(h2.hp).toBe(12)
  })

  it('特技で味方が全滅したら敗北。敵が自分の特技で全滅したら勝利', () => {
    const hero = ent({ id: 'hero', hp: 4, maxHp: 100 })
    const foe = ent({ id: 'foe', hp: 999, maxHp: 999, actions: ['候補=ink'] })
    const eng = new BattleEngine([hero], [foe], { rng: () => 0, skills: SKILLS })
    eng.selectAttack()
    expect(eng.getState().phase).toBe('defeat')

    const hero2 = ent({ id: 'hero2', atk: 1, hp: 500, maxHp: 500 })
    const foe2 = ent({ id: 'foe2', hp: 3, maxHp: 100, def: 99, actions: ['候補=boom'] })
    const boom: SkillExecution = { name: '自爆', target: '自分', effect: 'damage 99..99' }
    const eng2 = new BattleEngine([hero2], [foe2], { rng: () => 0, skills: { boom } })
    eng2.selectAttack() // 最低 1 ダメージで foe2 は 2 残り → 敵ターンに自爆
    expect(foe2.hp).toBe(0)
    expect(eng2.getState().phase).toBe('victory')
  })
})

describe('ATB: 同じ行動: が効き、acted の意味が同じ', () => {
  const FULL = 1000 // agi 25 は 1 秒で満タン

  it('初手 → 以降の流れが従来ターン制と同じ（敵の行動回数で数える）', () => {
    const hero = ent({ id: 'hero', name: 'ゆうしゃ', hp: 500, maxHp: 500, agi: 1 })
    const foe = ent({
      id: 'foe',
      name: 'タコ',
      hp: 999,
      maxHp: 999,
      agi: 25,
      actions: ['条件=初手 候補=ink'],
    })
    const eng = new BattleEngine([hero], [foe], { rng: () => 0, atb: {}, skills: SKILLS })
    eng.tick(FULL)
    expect(hero.hp).toBe(495) // 墨 5
    expect(eng.getState().enemyMemory).toEqual([{ acted: 1 }])
    eng.tick(FULL)
    expect(hero.hp).toBe(487) // 通常攻撃 8
    expect(eng.getState().enemyMemory).toEqual([{ acted: 2 }])
    expect(
      eng
        .getState()
        .events.filter((e) => e.actor.side === 'enemy')
        .map((e) => e.kind)
    ).toEqual(['skill', 'attack'])
  })

  it('特技で倒れた味方はコマンド待ちから外れ、全滅で敗北', () => {
    const h1 = ent({ id: 'h1', hp: 5, maxHp: 100, agi: 25 })
    const h2 = ent({ id: 'h2', hp: 5, maxHp: 100, agi: 1 })
    const foe = ent({ id: 'foe', hp: 999, maxHp: 999, agi: 25, actions: ['候補=ink'] })
    const eng = new BattleEngine([h1, h2], [foe], { rng: () => 0, atb: {}, skills: SKILLS })
    eng.tick(FULL) // h1 と foe が同時に満タン。墨 5 で h1・h2 とも倒れる
    expect(h1.hp).toBe(0)
    expect(h2.hp).toBe(0)
    expect(eng.getState().phase).toBe('defeat')
    expect(eng.getState().atb?.queue).toEqual([])
  })

  it('HP<50% の条件が ATB でも効く', () => {
    const hero = ent({ id: 'hero', hp: 500, maxHp: 500, agi: 1 })
    const foe = ent({
      id: 'foe',
      name: 'タコ',
      hp: 40,
      maxHp: 100,
      agi: 25,
      actions: ['条件=HP<50% 候補=tent'],
    })
    const eng = new BattleEngine([hero], [foe], { rng: () => 0, atb: {}, skills: SKILLS })
    eng.tick(FULL)
    expect(hero.hp).toBe(488)
  })

  it('対象=HP最小 の通常攻撃は狙いの乱数を使わず、選んだ相手を殴る', () => {
    const h1 = ent({ id: 'h1', hp: 90, agi: 1 })
    const h2 = ent({ id: 'h2', hp: 20, agi: 1 })
    const foe = ent({
      id: 'foe',
      hp: 999,
      maxHp: 999,
      agi: 25,
      actions: ['候補=こうげき 対象=HP最小'],
    })
    const { rng, calls } = counting(0)
    const eng = new BattleEngine([h1, h2], [foe], { rng, atb: {} })
    eng.tick(FULL)
    expect(h2.hp).toBe(12)
    expect(h1.hp).toBe(90)
    expect(calls()).toBe(1) // ダメージの乱数だけ
  })
})

describe('マスター（Markdown）→ MonsterDef.actions → 実際の戦闘', () => {
  it('[モンスター] の 行動: が parser を通って敵に届き、[特技] を使う', async () => {
    const src = `---
engine: name-name
chapter: 1
title: "t"
---
## data: マスター

[特技 ink]
名前: 墨
対象: 相手全体
効果: damage 5..5
メッセージ: {user}は 墨を はいた！
[/特技]

[モンスター kraken]
名前: タコ
HP: 100
ATK: 8
DEF: 0
AGI: 2
行動: 条件=初手 候補=ink
行動: 条件=HP<50% 候補=ink:1 | こうげき:1 対象=HP最小
[/モンスター]
`
    const doc = await parseMarkdown(src)
    const master = collectMasterData(doc)
    const def = master.monsters['kraken']
    expect(def.actions).toEqual([
      '条件=初手 候補=ink',
      '条件=HP<50% 候補=ink:1 | こうげき:1 対象=HP最小',
    ])
    const enemy: BattleEntity = {
      id: def.id,
      name: def.name,
      hp: def.hp,
      maxHp: def.hp,
      mp: 0,
      maxMp: 0,
      atk: def.atk,
      def: def.def,
      agi: def.agi,
      actions: def.actions,
    }
    const hero = ent({ id: 'hero', hp: 500, maxHp: 500 })
    const opts: BattleEngineOptions = { rng: () => 0, skills: toSkillExecutions(master.skills) }
    const eng = new BattleEngine([hero], [enemy], opts)
    eng.selectAttack()
    expect(eng.getState().log).toContain('タコは 墨を はいた！')
    expect(eng.getState().enemyMemory).toEqual([{ acted: 1 }])
  })
})
