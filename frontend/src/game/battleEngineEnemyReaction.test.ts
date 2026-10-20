/**
 * 敵の行動パターン P3 (#837): `反撃:`（被弾後）と `死亡時:`（倒れたとき 1 度だけ）。
 * 解釈（parseActionRule の P3 語彙・chooseEnemyReaction）と、エンジン統合（従来ターン制・ATB、全体攻撃・連続ヒット・
 * 反撃で倒れる・反撃が反撃を呼ばない・死亡時 1 回のみ・同時全滅）を決定論で確かめる。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BattleEngine } from './battleEngine'
import type { BattleState, SkillExecution, SpellExecution } from './battleEngine'
import type { BattleEntity } from './spellDsl'
import { BUILTIN_SPELLS } from './builtin'
import { parseMarkdown } from '../wasm/parser'
import { collectMasterData } from './rpgProjectFromDoc'
import {
  chooseEnemyAction,
  chooseEnemyReaction,
  createEnemyMemory,
  parseActionRule,
  parseCounterRules,
  parseDeathRules,
  toSkillExecutions,
  tracksHits,
} from './enemyAi'

function ent(over: Partial<BattleEntity> = {}): BattleEntity {
  return {
    id: 'e',
    name: 'E',
    hp: 100,
    maxHp: 100,
    mp: 0,
    maxMp: 0,
    atk: 0, // 通常攻撃の与ダメージ = 1（atk 0 でも最低 1）
    def: 0,
    agi: 2,
    exp: 1,
    gold: 1,
    ...over,
  }
}

const LANCE: SkillExecution = { name: 'こおりのやり', target: '相手単体', effect: 'damage 20..20' }
const BURST: SkillExecution = { name: 'じばく', target: '相手全体', effect: 'damage 15..15' }
const SPLASH: SkillExecution = { name: 'とびちる', target: '仲間全体', effect: 'damage 5..5' }
const SKILLS = { lance: LANCE, burst: BURST, splash: SPLASH }

const FIRE: SpellExecution = {
  name: 'ほのお',
  mp: 0,
  target: '敵単体',
  effect: 'damage 10..10 type=fire',
}
const ICE: SpellExecution = {
  name: 'こおり',
  mp: 0,
  target: '敵単体',
  effect: 'damage 10..10 type=ice',
}
const ALL: SpellExecution = { name: 'いなずま', mp: 0, target: '敵全体', effect: 'damage 10..10' }
const DOUBLE: SpellExecution = {
  name: 'にれんげき',
  mp: 0,
  target: '敵単体',
  builtin: 'test_double',
}

BUILTIN_SPELLS['test_double'] = (ctx) => {
  for (const t of ctx.targets) {
    t.hp = Math.max(0, t.hp - 5)
    t.hp = Math.max(0, t.hp - 5)
  }
  return ['にれんげき！']
}

afterEach(() => vi.restoreAllMocks())

/** 呼ばれた回数を数える rng（固定値の列。尽きたら最後の値） */
function counting(...vals: number[]): { rng: () => number; calls: () => number } {
  let i = 0
  return { rng: () => vals[Math.min(i++, vals.length - 1)] ?? 0, calls: () => i }
}

function stateOf(
  enemies: BattleEntity[],
  party: BattleEntity[] = [ent({ id: 'hero' })]
): BattleState {
  return {
    party,
    enemies,
    phase: 'party-input',
    log: [],
    logTotal: 0,
    events: [],
    eventTotal: 0,
    earnedExp: 0,
    earnedGold: 0,
    enemyMemory: enemies.map(() => ({ acted: 0 })),
  }
}

/** 戦闘ログ・イベントを (主体の側, 種類, ラベル) に要約する */
function summary(eng: BattleEngine): string[] {
  return eng
    .getState()
    .events.map((e) => `${e.actor.side}${e.actor.index}:${e.kind}${e.label ? `:${e.label}` : ''}`)
}

describe('P3 の語彙の解釈', () => {
  it.each([
    ['条件=被弾>=3 候補=墨'],
    ['条件=受けた=物理 候補=墨'],
    ['条件=受けた=魔法 候補=墨'],
    ['条件=受けた=アイテム 候補=墨'],
    ['条件=受けた=アイテム:ポーション 候補=墨'],
    ['条件=受けた=呪文:ほのお 候補=墨'],
    ['条件=受けた=系統:fire, 被弾>=2 候補=墨'],
    ['候補=墨 対象=最後に攻撃した者'],
  ])('%j は読める', (line) => {
    expect(typeof parseActionRule(line)).toBe('object')
  })

  it.each([
    ['順番=墨 > 触手', '反撃では順番が使えない'],
    ['候補=墨 上限=2', '反撃では上限が使えない'],
  ])('反撃・死亡時では %j は不正（%s）', (line) => {
    expect(typeof parseActionRule(line, 'reaction')).toBe('string')
    expect(typeof parseActionRule(line)).toBe('object') // 行動: では従来どおり読める
  })

  it('不正な行は warning を出して除かれ、同じ配列には 1 度しか出ない', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const lines = ['候補=lance', '順番=a > b', '条件=受けた=雷 候補=lance']
    expect(parseCounterRules(lines)).toHaveLength(1)
    expect(parseCounterRules(lines)).toHaveLength(1)
    expect(warn).toHaveBeenCalledTimes(2)
    expect(warn.mock.calls[0][0]).toContain('反撃')
    expect(parseDeathRules('順番=a > b')).toHaveLength(0)
    expect(warn.mock.calls[warn.mock.calls.length - 1][0]).toContain('死亡時')
  })

  it('tracksHits: 反撃・死亡時を持つ敵、行動に被弾の語彙を書いた敵だけ', () => {
    expect(tracksHits(ent())).toBe(false)
    expect(tracksHits(ent({ actions: ['条件=HP<50% 候補=墨'] }))).toBe(false)
    expect(tracksHits(ent({ counters: ['候補=こうげき'] }))).toBe(true)
    expect(tracksHits(ent({ onDeath: '候補=burst' }))).toBe(true)
    expect(tracksHits(ent({ actions: ['条件=被弾>=2 候補=墨'] }))).toBe(true)
    expect(tracksHits(ent({ actions: ['候補=墨 対象=最後に攻撃した者'] }))).toBe(true)
  })

  it('createEnemyMemory: 反撃・死亡時だけを持つ敵がいる戦闘でも作る', () => {
    expect(createEnemyMemory([ent()])).toBeUndefined()
    expect(createEnemyMemory([ent({ counters: ['候補=こうげき'] })])).toEqual([{ acted: 0 }])
    expect(createEnemyMemory([ent(), ent({ onDeath: '候補=burst' })])).toEqual([
      { acted: 0 },
      { acted: 0 },
    ])
  })
})

describe('chooseEnemyReaction（純粋関数）', () => {
  const rules = (lines: string[]) => parseCounterRules(lines)

  it('成立する行が無ければ null（通常攻撃に落とさない）。state も変えない', () => {
    const s = stateOf([ent({ counters: ['x'] })])
    s.enemyMemory![0].lastHit = { category: 'physical' }
    const before = JSON.stringify(s)
    const { rng, calls } = counting(0)
    expect(chooseEnemyReaction(s, 0, rules(['条件=受けた=魔法 候補=lance']), rng)).toBeNull()
    expect(calls()).toBe(0)
    expect(JSON.stringify(s)).toBe(before)
  })

  it('毎回先頭の行から評価する（位置を持たない）。候補が 1 つなら rng を消費しない', () => {
    const s = stateOf([ent()])
    s.enemyMemory![0].lastHit = { category: 'magic', name: 'ほのお', type: 'fire' }
    const { rng, calls } = counting(0)
    const r = rules(['条件=受けた=系統:ice 候補=burst', '条件=受けた=系統:fire 候補=lance'])
    for (let i = 0; i < 3; i++) {
      expect(chooseEnemyReaction(s, 0, r, rng)).toMatchObject({ kind: 'skill', skillId: 'lance' })
    }
    expect(calls()).toBe(0)
  })

  it('候補が複数なら重みの抽選で rng を 1 回', () => {
    const s = stateOf([ent()])
    const { rng, calls } = counting(0.9)
    const c = chooseEnemyReaction(s, 0, rules(['候補=lance:1 | burst:3']), rng)
    expect(c).toMatchObject({ kind: 'skill', skillId: 'burst' })
    expect(calls()).toBe(1)
  })

  it('受けた=: 物理 / 魔法 / 呪文:名 / 系統:x / アイテム:名 と 被弾>=N の判定', () => {
    const check = (hit: object | undefined, hits: number | undefined, line: string): boolean => {
      const s = stateOf([ent()])
      const m = s.enemyMemory![0]
      if (hit) m.lastHit = hit as never
      if (hits !== undefined) m.hits = hits
      return chooseEnemyReaction(s, 0, parseCounterRules([line]), () => 0) !== null
    }
    expect(check({ category: 'physical' }, undefined, '条件=受けた=物理 候補=lance')).toBe(true)
    expect(check({ category: 'magic' }, undefined, '条件=受けた=物理 候補=lance')).toBe(false)
    expect(check({ category: 'magic' }, undefined, '条件=受けた=魔法 候補=lance')).toBe(true)
    expect(check(undefined, undefined, '条件=受けた=魔法 候補=lance')).toBe(false)
    expect(
      check({ category: 'magic', name: 'ほのお' }, 1, '条件=受けた=呪文:ほのお 候補=lance')
    ).toBe(true)
    expect(
      check({ category: 'magic', name: 'こおり' }, 1, '条件=受けた=呪文:ほのお 候補=lance')
    ).toBe(false)
    expect(check({ category: 'magic', type: 'fire' }, 1, '条件=受けた=系統:fire 候補=lance')).toBe(
      true
    )
    expect(check({ category: 'physical' }, 1, '条件=受けた=系統:fire 候補=lance')).toBe(false)
    expect(
      check({ category: 'item', name: 'ポーション' }, 1, '条件=受けた=アイテム 候補=lance')
    ).toBe(true)
    expect(
      check({ category: 'item', name: 'ポーション' }, 1, '条件=受けた=アイテム:ぬけ 候補=lance')
    ).toBe(false)
    expect(check({ category: 'physical' }, 2, '条件=被弾>=3 候補=lance')).toBe(false)
    expect(check({ category: 'physical' }, 3, '条件=被弾>=3 候補=lance')).toBe(true)
  })

  it('狙い: 対象指定が無ければ直前の攻撃者（生きていれば）。死んでいれば指定なし', () => {
    const party = [ent({ id: 'a' }), ent({ id: 'b' })]
    const s = stateOf([ent()], party)
    s.enemyMemory![0].lastAttacker = { side: 'party', index: 1 }
    const r = rules(['候補=lance'])
    expect(chooseEnemyReaction(s, 0, r, () => 0)).toMatchObject({
      target: { side: 'party', index: 1 },
    })
    party[1].hp = 0
    expect(chooseEnemyReaction(s, 0, r, () => 0)).not.toHaveProperty('target')
  })

  it('対象=ランダム は相手が 2 人以上なら rng を 1 回消費し、攻撃者より優先する', () => {
    const s = stateOf([ent()], [ent({ id: 'a' }), ent({ id: 'b' })])
    s.enemyMemory![0].lastAttacker = { side: 'party', index: 0 }
    const { rng, calls } = counting(0.9)
    const c = chooseEnemyReaction(s, 0, rules(['候補=lance 対象=ランダム']), rng)
    expect(c).toMatchObject({ target: { side: 'party', index: 1 } })
    expect(calls()).toBe(1)
  })

  it('行動: の 対象=最後に攻撃した者 は chooseEnemyAction でも攻撃者を選ぶ（rng は消費しない）', () => {
    const e = ent({ actions: ['候補=lance 対象=最後に攻撃した者'] })
    const s = stateOf([e], [ent({ id: 'a' }), ent({ id: 'b' })])
    s.enemyMemory![0].lastAttacker = { side: 'party', index: 1 }
    const { rng, calls } = counting(0)
    expect(chooseEnemyAction(s, 0, rng)).toMatchObject({
      kind: 'skill',
      skillId: 'lance',
      targetOverride: '相手単体',
      target: { side: 'party', index: 1 },
    })
    expect(calls()).toBe(0)
  })
})

describe('反撃: エンジン統合（従来ターン制）', () => {
  it('属性カウンター: 火で攻撃されると氷の特技で反撃し、物理では反撃しない', () => {
    const hero = ent({ id: 'hero', hp: 500, maxHp: 500 })
    const boss = ent({
      id: 'boss',
      hp: 900,
      maxHp: 900,
      counters: ['条件=受けた=系統:fire 候補=lance'],
    })
    const eng = new BattleEngine([hero], [boss], { rng: () => 0, skills: SKILLS })
    eng.selectAttack() // 物理 → 反撃なし。敵ターンの通常攻撃 1
    expect(summary(eng)).toEqual(['party0:attack', 'enemy0:attack'])
    expect(hero.hp).toBe(499)
    eng.selectSpell(FIRE) // 火 → 反撃（やり 20）→ 敵ターンの通常攻撃 1
    expect(summary(eng).slice(2)).toEqual([
      'party0:spell:ほのお',
      'enemy0:skill:こおりのやり',
      'enemy0:attack',
    ])
    expect(hero.hp).toBe(499 - 20 - 1)
    expect(boss.hp).toBe(900 - 1 - 10) // 物理 1 + 火 10
    eng.selectSpell(ICE) // 氷では反撃しない
    expect(summary(eng).slice(5)).toEqual(['party0:spell:こおり', 'enemy0:attack'])
  })

  it('反撃はダメージ確定後に起き、被弾の記憶（被弾回数・直前の被弾・攻撃者）を残す。行動回数は進めない', () => {
    const boss = ent({
      id: 'boss',
      hp: 900,
      maxHp: 900,
      counters: ['条件=受けた=系統:fire 候補=lance'],
    })
    const eng = new BattleEngine([ent({ id: 'hero', hp: 500, maxHp: 500 })], [boss], {
      rng: () => 0,
      skills: SKILLS,
    })
    eng.selectSpell(FIRE)
    const ev = eng.getState().events
    // 反撃の時点で味方の被弾（敵 HP の確定）は済んでいる: 味方の呪文の hit が先、反撃が後
    expect(ev[0].hits[0]).toMatchObject({ kind: 'damage', hpBefore: 900, hpAfter: 890 })
    expect(ev[1].actor).toEqual({ side: 'enemy', index: 0 })
    expect(ev.map((e) => e.seq)).toEqual([0, 1, 2]) // 演出キューの通し番号は連続
    expect(eng.getState().enemyMemory![0]).toEqual({
      acted: 1, // 敵ターンの通常攻撃 1 回だけ。反撃は数えない
      hits: 1,
      lastHit: { category: 'magic', name: 'ほのお', type: 'fire' },
      lastAttacker: { side: 'party', index: 0 },
    })
  })

  it('被弾>=N: N 回目の被弾から反撃する', () => {
    const hero = ent({ id: 'hero', hp: 500, maxHp: 500 })
    const boss = ent({ id: 'boss', hp: 900, maxHp: 900, counters: ['条件=被弾>=2 候補=lance'] })
    const eng = new BattleEngine([hero], [boss], { rng: () => 0, skills: SKILLS })
    eng.selectAttack()
    expect(summary(eng)).toEqual(['party0:attack', 'enemy0:attack']) // 1 回目: 反撃なし
    eng.selectAttack()
    expect(summary(eng).slice(2)).toEqual([
      'party0:attack',
      'enemy0:skill:こおりのやり',
      'enemy0:attack',
    ])
  })

  it('反撃の候補が通常攻撃なら、攻撃者を殴る（行動回数・順番は動かない）', () => {
    const hero = ent({ id: 'hero', hp: 500, maxHp: 500 })
    const boss = ent({ id: 'boss', hp: 900, maxHp: 900, atk: 10, counters: ['候補=こうげき'] })
    const eng = new BattleEngine([hero], [boss], { rng: () => 0, skills: SKILLS })
    eng.selectAttack()
    expect(summary(eng)).toEqual(['party0:attack', 'enemy0:attack', 'enemy0:attack'])
    expect(eng.getState().log).toContain('E の はんげき！')
  })

  it('全体攻撃は被弾した敵ごとに 1 回ずつ反撃する（倒れた敵は反撃しない）', () => {
    const hero = ent({ id: 'hero', hp: 500, maxHp: 500 })
    const a = ent({ id: 'a', name: 'A', hp: 100, counters: ['候補=lance'] })
    const b = ent({ id: 'b', name: 'B', hp: 100, counters: ['候補=lance'] })
    const dead = ent({ id: 'c', name: 'C', hp: 5, counters: ['候補=lance'] })
    const eng = new BattleEngine([hero], [a, b, dead], { rng: () => 0, skills: SKILLS })
    eng.selectSpell(ALL)
    const counters = summary(eng).filter((s) => s.includes('skill'))
    expect(counters).toEqual(['enemy0:skill:こおりのやり', 'enemy1:skill:こおりのやり'])
    expect(hero.hp).toBe(500 - 20 - 20 - 2) // 反撃 2 回 + 生き残った敵 2 体の通常攻撃
  })

  it('1 行動で同じ敵に複数ヒットしても反撃は 1 回', () => {
    const hero = ent({ id: 'hero', hp: 500, maxHp: 500 })
    const boss = ent({ id: 'boss', hp: 900, maxHp: 900, counters: ['候補=lance'] })
    const eng = new BattleEngine([hero], [boss], { rng: () => 0, skills: SKILLS })
    eng.selectSpell(DOUBLE)
    expect(boss.hp).toBe(890)
    expect(summary(eng).filter((s) => s.includes('skill'))).toHaveLength(1)
    expect(eng.getState().enemyMemory![0].hits).toBe(1)
  })

  it('反撃で味方が全滅したら敗北。そのあとの敵ターンは始まらない', () => {
    const hero = ent({ id: 'hero', hp: 15, maxHp: 15 })
    const boss = ent({ id: 'boss', hp: 900, maxHp: 900, counters: ['候補=lance'] })
    const other = ent({ id: 'other', hp: 100 })
    const eng = new BattleEngine([hero], [boss, other], { rng: () => 0, skills: SKILLS })
    eng.selectAttack()
    expect(eng.getState().phase).toBe('defeat')
    expect(hero.hp).toBe(0)
    expect(summary(eng)).toEqual(['party0:attack', 'enemy0:skill:こおりのやり']) // 敵ターンの通常攻撃は無い
    expect(eng.getState().log.filter((l) => l === 'ぜんめつ してしまった……')).toHaveLength(1)
  })

  it('反撃は反撃を起こさない（反撃が仲間の敵に当たっても、その敵は反撃せず被弾も数えない）', () => {
    const hero = ent({ id: 'hero', hp: 500, maxHp: 500 })
    const a = ent({ id: 'a', name: 'A', hp: 900, counters: ['候補=splash'] })
    const b = ent({ id: 'b', name: 'B', hp: 900, counters: ['候補=lance'] })
    const eng = new BattleEngine([hero], [a, b], { rng: () => 0, skills: SKILLS })
    eng.selectAttack() // 攻撃は A に当たる（先頭の生存敵）
    expect(a.hp).toBe(900 - 1 - 5) // 物理 1 + 自分の反撃（仲間全体）の 5
    expect(b.hp).toBe(900 - 5)
    expect(summary(eng).filter((s) => s.includes('skill'))).toEqual(['enemy0:skill:とびちる'])
    expect(eng.getState().enemyMemory![0].hits).toBe(1) // 自分の反撃の巻き添えは被弾に数えない
    expect(eng.getState().enemyMemory![1].hits).toBeUndefined()
  })

  it('反撃の rng 消費: 候補が 1 つなら 0 回。反撃の無い敵・行動の記憶は不変', () => {
    const hero = ent({ id: 'hero', hp: 500, maxHp: 500 })
    const plain = ent({ id: 'p', hp: 900 })
    const withCounter = ent({ id: 'c', hp: 900, counters: ['条件=受けた=魔法 候補=lance'] })
    const { rng, calls } = counting(0)
    const eng = new BattleEngine([hero], [withCounter, plain], { rng, skills: SKILLS })
    eng.selectAttack() // 味方 1 + 敵 2 の通常攻撃 = 3 回。物理なので反撃の抽選は無い
    expect(calls()).toBe(3)
    expect(eng.getState().enemyMemory).toEqual([
      {
        acted: 1,
        hits: 1,
        lastHit: { category: 'physical' },
        lastAttacker: { side: 'party', index: 0 },
      },
      { acted: 1 }, // 反撃・死亡時・被弾の語彙を使わない敵の記憶は変わらない
    ])
  })

  it('エンジンに無い特技 id の反撃は通常攻撃に落ちる', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const hero = ent({ id: 'hero', hp: 500, maxHp: 500 })
    const boss = ent({ id: 'boss', hp: 900, counters: ['候補=nothing'] })
    const eng = new BattleEngine([hero], [boss], { rng: () => 0, skills: SKILLS })
    eng.selectAttack()
    expect(summary(eng)).toEqual(['party0:attack', 'enemy0:attack', 'enemy0:attack'])
  })
})

describe('死亡時: エンジン統合', () => {
  it('倒されたときに 1 度だけ実行する。後の行動で再び実行されない', () => {
    const hero = ent({ id: 'hero', atk: 100, hp: 500, maxHp: 500 })
    const bomb = ent({ id: 'bomb', name: 'ボム', hp: 5, onDeath: '候補=burst' })
    const boss = ent({ id: 'boss', hp: 900 })
    const eng = new BattleEngine([hero], [bomb, boss], { rng: () => 0, skills: SKILLS })
    eng.selectAttack() // ボムを倒す（攻撃力 100）→ 自爆 15 → 敵ターン: ボスの通常攻撃 1
    expect(summary(eng)).toEqual(['party0:attack', 'enemy0:skill:じばく', 'enemy1:attack'])
    expect(hero.hp).toBe(500 - 15 - 1)
    expect(eng.getState().enemyMemory![0].died).toBe(true)
    eng.selectSpell(ALL) // ボスだけ当たる。倒れたボムは再び自爆しない
    expect(summary(eng).filter((s) => s.includes('じばく'))).toHaveLength(1)
  })

  it('倒れた敵本人が使う（HP 0 のまま）。死亡時の行動で味方が倒れることもある', () => {
    const hero = ent({ id: 'hero', atk: 100, hp: 10, maxHp: 10 })
    const bomb = ent({ id: 'bomb', hp: 5, onDeath: '候補=burst' })
    const boss = ent({ id: 'boss', hp: 900 })
    const eng = new BattleEngine([hero], [bomb, boss], { rng: () => 0, skills: SKILLS })
    eng.selectAttack()
    expect(bomb.hp).toBe(0)
    expect(hero.hp).toBe(0)
    expect(eng.getState().phase).toBe('defeat')
    expect(summary(eng)).toEqual(['party0:attack', 'enemy0:skill:じばく']) // ボスの敵ターンは無い
  })

  it('最後の 1 体の死亡時の行動も実行され、そのうえで勝利は 1 度だけ判定される', () => {
    const hero = ent({ id: 'hero', atk: 100, hp: 500, maxHp: 500 })
    const bomb = ent({ id: 'bomb', hp: 5, exp: 7, gold: 3, onDeath: '候補=burst' })
    const eng = new BattleEngine([hero], [bomb], { rng: () => 0, skills: SKILLS })
    eng.selectAttack()
    expect(eng.getState().phase).toBe('victory')
    expect(hero.hp).toBe(485)
    expect(summary(eng)).toEqual(['party0:attack', 'enemy0:skill:じばく'])
    const log = eng.getState().log
    expect(log.filter((l) => l.startsWith('けいけんち'))).toHaveLength(1)
    expect(eng.getState().earnedExp).toBe(7)
  })

  it('同時全滅: 従来ターン制は敗北（最後の敵の死亡時の行動で味方も全滅）', () => {
    const hero = ent({ id: 'hero', atk: 100, hp: 10, maxHp: 10 })
    const bomb = ent({ id: 'bomb', hp: 5, onDeath: '候補=burst' })
    const eng = new BattleEngine([hero], [bomb], { rng: () => 0, skills: SKILLS })
    eng.selectAttack()
    expect(eng.getState().phase).toBe('defeat')
    expect(eng.getState().log.filter((l) => l.startsWith('けいけんち'))).toHaveLength(0)
  })

  it('同時全滅: ATB も敗北（味方全滅を優先、#877）', () => {
    const hero = ent({ id: 'hero', atk: 100, hp: 10, maxHp: 10, agi: 25 })
    const bomb = ent({ id: 'bomb', hp: 5, agi: 1, onDeath: '候補=burst' })
    const eng = new BattleEngine([hero], [bomb], {
      rng: () => 0,
      skills: SKILLS,
      atb: { initialGauges: { party: [1000] } },
    })
    eng.selectAttack()
    expect(eng.getState().phase).toBe('defeat')
    expect(hero.hp).toBe(0)
    expect(eng.getState().atb!.queue).toEqual([])
    expect(eng.getState().log.filter((l) => l.startsWith('けいけんち'))).toHaveLength(0)
  })

  it('死亡時の行動で別の敵が倒れたら、その敵の死亡時の行動も続けて 1 度ずつ実行する', () => {
    const hero = ent({ id: 'hero', atk: 100, hp: 500, maxHp: 500 })
    const a = ent({ id: 'a', name: 'A', hp: 5, onDeath: '候補=splash' }) // 仲間全体（自分含む）に 5
    const b = ent({ id: 'b', name: 'B', hp: 5, onDeath: '候補=burst' })
    const c = ent({ id: 'c', name: 'C', hp: 900 })
    const eng = new BattleEngine([hero], [a, b, c], { rng: () => 0, skills: SKILLS })
    eng.selectAttack()
    expect(summary(eng).filter((s) => s.includes('skill'))).toEqual([
      'enemy0:skill:とびちる',
      'enemy1:skill:じばく',
    ])
    expect(eng.getState().enemyMemory![0].died).toBe(true)
    expect(eng.getState().enemyMemory![1].died).toBe(true)
  })

  it('死亡時の候補が通常攻撃なら攻撃者を殴る。条件が成立しなければ何もせず、それでも 1 度きり', () => {
    const hero = ent({ id: 'hero', atk: 100, hp: 500, maxHp: 500 })
    const a = ent({ id: 'a', hp: 5, atk: 10, onDeath: '候補=こうげき' })
    const b = ent({ id: 'b', hp: 5, onDeath: '条件=HP>=50% 候補=burst' }) // 倒れたあとは HP 0 なので不成立
    const c = ent({ id: 'c', hp: 900 })
    const eng = new BattleEngine([hero], [a, b, c], { rng: () => 0, skills: SKILLS })
    eng.selectSpell(ALL) // 威力 10: A・B とも倒れる
    expect(summary(eng)).toEqual(['party0:spell:いなずま', 'enemy0:attack', 'enemy2:attack'])
    expect(eng.getState().enemyMemory![1].died).toBe(true)
    expect(eng.getState().log).toContain('E の さいごの あがき！')
  })

  it('味方の攻撃で倒れた敵は反撃せず、死亡時の行動だけを使う', () => {
    const hero = ent({ id: 'hero', atk: 100, hp: 500, maxHp: 500 })
    const a = ent({ id: 'a', hp: 5, counters: ['候補=lance'], onDeath: '候補=burst' })
    const c = ent({ id: 'c', hp: 900 })
    const eng = new BattleEngine([hero], [a, c], { rng: () => 0, skills: SKILLS })
    eng.selectAttack()
    expect(summary(eng).filter((s) => s.includes('skill'))).toEqual(['enemy0:skill:じばく'])
  })
})

describe('ATB との整合 (#745 の演出キューに積む)', () => {
  it('ATB: 味方の呪文のあとに反撃が積まれ、反撃で倒れた行動者はキュー・ゲージから外れる', () => {
    const h1 = ent({ id: 'h1', hp: 15, maxHp: 15, agi: 1 })
    const h2 = ent({ id: 'h2', hp: 500, maxHp: 500, agi: 1 })
    const boss = ent({ id: 'boss', hp: 900, agi: 1, counters: ['候補=lance'] })
    const eng = new BattleEngine([h1, h2], [boss], {
      rng: () => 0,
      skills: SKILLS,
      atb: { initialGauges: { party: [1000, 1000] } },
    })
    expect(eng.getCurrentActorIndex()).toBe(0)
    eng.selectSpell(FIRE)
    expect(summary(eng)).toEqual(['party0:spell:ほのお', 'enemy0:skill:こおりのやり'])
    const st = eng.getState()
    expect(h1.hp).toBe(0)
    expect(st.atb!.queue).toEqual([1]) // 倒れた h1 は外れ、h2 がコマンド待ち
    expect(st.atb!.partyGauge[0]).toBe(0)
    expect(st.phase).toBe('party-input')
    expect(eng.getCurrentActorIndex()).toBe(1)
  })

  it('ATB: 反撃で味方が全滅したら敗北', () => {
    const h1 = ent({ id: 'h1', hp: 15, maxHp: 15, agi: 1 })
    const boss = ent({ id: 'boss', hp: 900, agi: 1, counters: ['候補=lance'] })
    const eng = new BattleEngine([h1], [boss], {
      rng: () => 0,
      skills: SKILLS,
      atb: { initialGauges: { party: [1000] } },
    })
    eng.selectAttack()
    expect(eng.getState().phase).toBe('defeat')
  })

  it('ATB: 敵の特技で倒れた仲間の死亡時の行動が実行される（キューも整う）', () => {
    const hero = ent({ id: 'hero', hp: 500, maxHp: 500, agi: 1 })
    const killer = ent({ id: 'k', name: 'K', hp: 900, agi: 25, actions: ['候補=wipe'] })
    const bomb = ent({ id: 'b', hp: 5, agi: 1, onDeath: '候補=burst' })
    const wipe: SkillExecution = { name: 'なぎはらい', target: '仲間全体', effect: 'damage 50..50' }
    const eng = new BattleEngine([hero], [killer, bomb], {
      rng: () => 0,
      skills: { ...SKILLS, wipe },
      atb: {},
    })
    eng.tick(1000)
    expect(summary(eng)).toEqual(['enemy0:skill:なぎはらい', 'enemy1:skill:じばく'])
    expect(hero.hp).toBe(500 - 15)
  })

  it('従来ターン制: 敵の特技で倒れた仲間の死亡時の行動もその場で実行される', () => {
    const hero = ent({ id: 'hero', hp: 500, maxHp: 500 })
    const killer = ent({ id: 'k', hp: 900, actions: ['候補=wipe'] })
    const bomb = ent({ id: 'b', hp: 5, onDeath: '候補=burst' })
    const wipe: SkillExecution = { name: 'なぎはらい', target: '仲間全体', effect: 'damage 50..50' }
    const eng = new BattleEngine([hero], [killer, bomb], {
      rng: () => 0,
      skills: { ...SKILLS, wipe },
    })
    eng.selectAttack() // 先頭の生存敵（K）を殴る
    expect(summary(eng)).toEqual([
      'party0:attack',
      'enemy0:skill:なぎはらい',
      'enemy1:skill:じばく',
    ])
  })
})

describe('反撃・死亡時を書かない敵・P2 までの敵は不変（回帰）', () => {
  it('行動: だけの敵の記憶は { acted } のまま、乱数の消費も変わらない', () => {
    const hero = ent({ id: 'hero', hp: 500, maxHp: 500 })
    const e = ent({ id: 'e', hp: 900, actions: ['条件=初手 候補=lance'] })
    const { rng, calls } = counting(0)
    const eng = new BattleEngine([hero], [e], { rng, skills: SKILLS })
    eng.selectAttack() // 味方 1 + 敵（特技は rng 無し）0
    expect(calls()).toBe(1)
    expect(eng.getState().enemyMemory).toEqual([{ acted: 1 }])
    eng.selectSpell(FIRE)
    expect(eng.getState().enemyMemory).toEqual([{ acted: 2 }])
  })

  it('反撃・死亡時の無い戦闘に enemyMemory は作られず、敵が倒れても何も起きない', () => {
    const hero = ent({ id: 'hero', atk: 100, hp: 500, maxHp: 500 })
    const eng = new BattleEngine([hero], [ent({ id: 'x', hp: 5 }), ent({ id: 'y' })], {
      rng: () => 0,
      skills: SKILLS,
    })
    eng.selectAttack()
    expect(eng.getState().enemyMemory).toBeUndefined()
    expect(summary(eng)).toEqual(['party0:attack', 'enemy1:attack'])
  })
})

describe('Markdown から parser（wasm）経由で反撃・死亡時を読む', () => {
  it('反撃: 死亡時: が MonsterDef.counters / onDeath になり、エンジンで動く', async () => {
    const src = `---
engine: name-name
chapter: 1
title: "test"
---
## data: マスター

[特技 lance]
名前: こおりのやり
対象: 相手単体
効果: damage 20..20
[/特技]

[モンスター warden]
名前: ばんにん
HP: 100
反撃: 条件=受けた=系統:fire 候補=lance
死亡時: 候補=こうげき
[/モンスター]
`
    const doc = await parseMarkdown(src)
    const master = collectMasterData(doc)
    const def = master.monsters['warden']
    expect(def.counters).toEqual(['条件=受けた=系統:fire 候補=lance'])
    expect(def.onDeath).toBe('候補=こうげき')
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
      counters: def.counters,
      onDeath: def.onDeath,
    }
    const hero = ent({ id: 'hero', hp: 500, maxHp: 500 })
    const eng = new BattleEngine([hero], [enemy], {
      rng: () => 0,
      skills: toSkillExecutions(master.skills),
    })
    eng.selectSpell(FIRE)
    expect(summary(eng)).toEqual([
      'party0:spell:ほのお',
      'enemy0:skill:こおりのやり',
      'enemy0:attack',
    ])
  })
})

describe('倒れた使い手は自分を効果の対象にできない (#837)', () => {
  const HEAL_SELF: SkillExecution = { name: 'いやし', target: '自分', effect: 'heal 50..50' }
  const HEAL_ALLY: SkillExecution = {
    name: 'いやしの風',
    target: '仲間全体',
    effect: 'heal 30..30',
  }
  const skills = { ...SKILLS, heal_self: HEAL_SELF, heal_ally: HEAL_ALLY }

  it('死亡時に自分向けの回復を書いても生き返らない。died は立ったまま、勝利は覆らない', () => {
    const hero = ent({ id: 'hero', atk: 100, hp: 500, maxHp: 500 })
    const imp = ent({ id: 'imp', hp: 5, onDeath: '候補=heal_self' })
    const eng = new BattleEngine([hero], [imp], { rng: () => 0, skills })
    eng.selectAttack()
    expect(imp.hp).toBe(0)
    expect(eng.getState().enemyMemory![0].died).toBe(true)
    expect(eng.getState().phase).toBe('victory')
  })

  it('仲間全体の回復でも倒れた本人は戻らず、生きている仲間は回復する', () => {
    const hero = ent({ id: 'hero', atk: 100, hp: 500, maxHp: 500 })
    const imp = ent({ id: 'imp', hp: 5, onDeath: '候補=heal_ally' })
    const other = ent({ id: 'other', hp: 50, maxHp: 100 })
    const eng = new BattleEngine([hero], [imp, other], { rng: () => 0, skills })
    eng.selectAttack()
    expect(imp.hp).toBe(0)
    expect(other.hp).toBe(80) // 敵の other は回復だけ受ける
  })

  it('蘇生の仲間単体: 本人が倒れた別の仲間より前にいても、本人を飛ばして別の仲間を蘇生する', () => {
    const REVIVE: SkillExecution = { name: 'よみがえり', target: '仲間単体', effect: 'revive' }
    const hero = ent({ id: 'hero', atk: 100, hp: 500, maxHp: 500 })
    const a = ent({ id: 'a', name: 'A', hp: 5, onDeath: '候補=revive_ally' })
    const b = ent({ id: 'b', name: 'B', hp: 0, maxHp: 80 })
    const c = ent({ id: 'c', name: 'C', hp: 900 })
    const eng = new BattleEngine([hero], [a, b, c], {
      rng: () => 0,
      skills: { ...SKILLS, revive_ally: REVIVE },
    })
    eng.selectAttack()
    expect(a.hp).toBe(0) // 本人は戻らない
    expect(b.hp).toBe(80) // 倒れていた別の仲間が蘇生する
    expect(eng.getState().enemyMemory![0].died).toBe(true)
  })
})
