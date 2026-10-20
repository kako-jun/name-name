/**
 * 敵の条件 `ダメージ…` (#871): 直前の被弾で受けたダメージ（画面に出る数字の合計）の奇数・偶数・倍数・閾値・ちょうど・桁数。
 * 解釈・純粋関数 chooseEnemyReaction・エンジン統合（従来ターン制・ATB、複数ヒット、オーバーキル、即死、固定ダメージ、
 * `行動:` `反撃:` `死亡時:`、条件を書かない敵が従来どおりであること）を決定論で確かめる。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BattleEngine } from './battleEngine'
import type { BattleState, SkillExecution, SpellExecution } from './battleEngine'
import type { BattleEntity } from './spellDsl'
import {
  chooseEnemyAction,
  chooseEnemyReaction,
  parseActionRule,
  parseCounterRules,
  tracksDamage,
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
    atk: 0,
    def: 0,
    agi: 2,
    exp: 1,
    gold: 1,
    ...over,
  }
}

const ODD: SkillExecution = { name: 'きすう', target: '相手単体', effect: 'damage 3..3' }
const EVEN: SkillExecution = { name: 'ぐうすう', target: '相手単体', effect: 'damage 4..4' }
const BURST: SkillExecution = { name: 'じばく', target: '相手全体', effect: 'damage 15..15' }
const SKILLS = { odd: ODD, even: EVEN, burst: BURST }

const spell = (name: string, effect: string, target = '敵単体'): SpellExecution => ({
  name,
  mp: 0,
  target,
  effect,
})
const SEVEN = spell('ななつ', 'damage 7..7')
const EIGHT = spell('やっつ', 'damage 8..8')
const DOUBLE_ODD = spell('にれんだ', 'damage 7..7 回数=2') // 7 + 7 = 14（偶数）
const OVERKILL = spell('とどめ', 'damage 50..50')
const KILL = spell('デス', 'damage_full')
const HUNDRED = spell('ひゃく', 'damage 100..100')
const THOUSAND = spell('せん', 'damage 1000..1000')

afterEach(() => vi.restoreAllMocks())

function stateOf(enemies: BattleEntity[]): BattleState {
  return {
    party: [ent({ id: 'hero' })],
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

/** 反撃が使った特技の id を順に取り出す（イベントのラベルから） */
function skillLabels(eng: BattleEngine): string[] {
  return eng
    .getState()
    .events.filter((e) => e.kind === 'skill')
    .map((e) => e.label as string)
}

function fight(counters: string[], hp = 900, extra: Partial<BattleEntity> = {}) {
  const hero = ent({ id: 'hero', hp: 5000, maxHp: 5000 })
  const boss = ent({ id: 'boss', hp, maxHp: hp, counters, ...extra })
  const eng = new BattleEngine([hero], [boss], { rng: () => 0, skills: SKILLS })
  return { eng, hero, boss }
}

describe('ダメージ条件の解釈', () => {
  it.each([
    ['条件=ダメージ=奇数 候補=odd'],
    ['条件=ダメージ=偶数 候補=odd'],
    ['条件=ダメージ=3の倍数 候補=odd'],
    ['条件=ダメージ>=100 候補=odd'],
    ['条件=ダメージ<10 候補=odd'],
    ['条件=ダメージ=777 候補=odd'],
    ['条件=ダメージ桁数>=3 候補=odd'],
    ['条件=ダメージ桁数=1, 受けた=魔法 候補=odd'],
    ['条件=ダメージ = 偶数 候補=odd'],
  ])('%j は読める', (line) => {
    expect(typeof parseActionRule(line)).toBe('object')
    expect(typeof parseActionRule(line, 'reaction')).toBe('object')
  })

  it.each([
    ['条件=ダメージ 候補=odd'],
    ['条件=ダメージ奇数 候補=odd'],
    ['条件=ダメージ>=奇数 候補=odd'],
    ['条件=ダメージ=0の倍数 候補=odd'],
    ['条件=ダメージ=-3 候補=odd'],
    ['条件=ダメージ桁数=奇数 候補=odd'],
    ['条件=ダメージ桁数 候補=odd'],
    ['条件=ダメージ=abc 候補=odd'],
  ])('%j は不正', (line) => {
    expect(typeof parseActionRule(line)).toBe('string')
  })

  it('tracksHits / tracksDamage: 書いた敵だけ', () => {
    expect(tracksDamage(ent())).toBe(false)
    expect(tracksDamage(ent({ counters: ['条件=受けた=物理 候補=odd'] }))).toBe(false)
    expect(tracksDamage(ent({ counters: ['条件=ダメージ=奇数 候補=odd'] }))).toBe(true)
    expect(tracksDamage(ent({ actions: ['条件=ダメージ>=10 候補=odd'] }))).toBe(true)
    expect(tracksDamage(ent({ onDeath: '条件=ダメージ=偶数 候補=odd' }))).toBe(true)
    expect(tracksDamage(ent({ counters: ['条件=ダメージ=abc 候補=odd'] }))).toBe(false)
    // `行動:` にだけ書いた敵も被弾を記憶する
    expect(tracksHits(ent({ actions: ['条件=ダメージ=奇数 候補=odd'] }))).toBe(true)
    expect(tracksHits(ent({ actions: ['条件=HP<50% 候補=odd'] }))).toBe(false)
  })
})

describe('chooseEnemyReaction / chooseEnemyAction（純粋関数）', () => {
  const holds = (damage: number | undefined, cond: string): boolean => {
    const s = stateOf([ent()])
    if (damage !== undefined) s.enemyMemory![0].lastDamage = damage
    return chooseEnemyReaction(s, 0, parseCounterRules([`条件=${cond} 候補=odd`]), () => 0) !== null
  }

  it('奇数・偶数・倍数', () => {
    expect(holds(7, 'ダメージ=奇数')).toBe(true)
    expect(holds(8, 'ダメージ=奇数')).toBe(false)
    expect(holds(8, 'ダメージ=偶数')).toBe(true)
    expect(holds(0, 'ダメージ=偶数')).toBe(true)
    expect(holds(9, 'ダメージ=3の倍数')).toBe(true)
    expect(holds(10, 'ダメージ=3の倍数')).toBe(false)
  })

  it('閾値・ちょうど・桁数の境界', () => {
    expect(holds(99, 'ダメージ>=100')).toBe(false)
    expect(holds(100, 'ダメージ>=100')).toBe(true)
    expect(holds(100, 'ダメージ>100')).toBe(false)
    expect(holds(9, 'ダメージ<10')).toBe(true)
    expect(holds(10, 'ダメージ<10')).toBe(false)
    expect(holds(777, 'ダメージ=777')).toBe(true)
    expect(holds(778, 'ダメージ=777')).toBe(false)
    expect(holds(999, 'ダメージ桁数=3')).toBe(true)
    expect(holds(1000, 'ダメージ桁数=3')).toBe(false)
    expect(holds(1000, 'ダメージ桁数>=4')).toBe(true)
    expect(holds(9999, 'ダメージ桁数>=4')).toBe(true)
    expect(holds(0, 'ダメージ桁数=1')).toBe(true)
  })

  it('値が無い（被弾前・数字が出なかった被弾）は、どの比較も不成立（<10 や偶数でも）', () => {
    for (const c of [
      'ダメージ=奇数',
      'ダメージ=偶数',
      'ダメージ<10',
      'ダメージ>=0',
      'ダメージ桁数>=1',
    ]) {
      expect(holds(undefined, c)).toBe(false)
    }
  })

  it('AND: 受けた= と併用できる。state を変えず rng も消費しない', () => {
    const s = stateOf([ent()])
    s.enemyMemory![0].lastDamage = 7
    s.enemyMemory![0].lastHit = { category: 'magic' }
    const before = JSON.stringify(s)
    let calls = 0
    const rng = () => (calls++, 0)
    const r = parseCounterRules(['条件=受けた=魔法, ダメージ=奇数 候補=odd'])
    expect(chooseEnemyReaction(s, 0, r, rng)).toMatchObject({ skillId: 'odd' })
    expect(calls).toBe(0)
    expect(JSON.stringify(s)).toBe(before)
  })

  it('行動: でも使える（直前に受けたダメージで行動が変わる）', () => {
    const enemy = ent({ actions: ['条件=ダメージ=奇数 候補=odd', '候補=even'] })
    const s = stateOf([enemy])
    expect(chooseEnemyAction(s, 0, () => 0)).toMatchObject({ skillId: 'even' }) // 被弾前
    s.enemyMemory![0].lastDamage = 5
    expect(chooseEnemyAction(s, 0, () => 0)).toMatchObject({ skillId: 'odd' })
    s.enemyMemory![0].lastDamage = 6
    expect(chooseEnemyAction(s, 0, () => 0)).toMatchObject({ skillId: 'even' })
  })
})

describe('エンジン統合（従来ターン制）', () => {
  it('固定ダメージ 7（奇数）と 8（偶数）で反撃が分かれる（推理バトルの型）', () => {
    const { eng } = fight(['条件=ダメージ=奇数 候補=odd', '条件=ダメージ=偶数 候補=even'])
    eng.selectSpell(SEVEN)
    expect(skillLabels(eng)).toEqual(['きすう'])
    eng.selectSpell(EIGHT)
    expect(skillLabels(eng)).toEqual(['きすう', 'ぐうすう'])
    expect(eng.getState().enemyMemory![0].lastDamage).toBe(8)
  })

  it('通常攻撃の数字（atk 1 → 1 ダメージ）でも判定される', () => {
    const hero = ent({ id: 'hero', atk: 10, hp: 5000, maxHp: 5000 })
    const boss = ent({
      id: 'boss',
      hp: 900,
      maxHp: 900,
      counters: ['条件=ダメージ=偶数 候補=even'],
    })
    const eng = new BattleEngine([hero], [boss], { rng: () => 0, skills: SKILLS })
    eng.selectAttack() // atk 10 - def 0 = 10（rng 0 で乱数分 0）→ 偶数
    expect(boss.hp).toBe(890)
    expect(eng.getState().enemyMemory![0].lastDamage).toBe(10)
    expect(skillLabels(eng)).toEqual(['ぐうすう'])
  })

  it('複数ヒットは表示された数字の合計で判定する（7 + 7 = 14 → 偶数）', () => {
    const { eng } = fight(['条件=ダメージ=奇数 候補=odd', '条件=ダメージ=偶数 候補=even'])
    eng.selectSpell(DOUBLE_ODD)
    expect(eng.getState().enemyMemory![0].lastDamage).toBe(14)
    expect(skillLabels(eng)).toEqual(['ぐうすう'])
  })

  it('閾値・桁数・ちょうど', () => {
    const { eng } = fight(
      [
        '条件=ダメージ桁数>=4 候補=burst',
        '条件=ダメージ>=100 候補=even',
        '条件=ダメージ=7 候補=odd',
      ],
      5000
    )
    eng.selectSpell(SEVEN)
    eng.selectSpell(HUNDRED)
    eng.selectSpell(THOUSAND)
    expect(skillLabels(eng)).toEqual(['きすう', 'ぐうすう', 'じばく'])
  })

  it('オーバーキルは表示される数字（50）で判定する。倒した一撃で死亡時の行動が条件を見られる', () => {
    const hero = ent({ id: 'hero', hp: 5000, maxHp: 5000 })
    const boss = ent({
      id: 'boss',
      hp: 3,
      maxHp: 3,
      onDeath: '条件=ダメージ>=50 候補=burst',
    })
    const eng = new BattleEngine([hero], [boss, ent({ id: 'x', hp: 900, maxHp: 900 })], {
      rng: () => 0,
      skills: SKILLS,
    })
    eng.selectSpell(OVERKILL)
    expect(eng.getState().events[0].hits[0].amount).toBe(50)
    expect(skillLabels(eng)).toEqual(['じばく'])
  })

  it('即死は数字を持たないので、どのダメージ条件も不成立（条件なしの死亡時は動く）', () => {
    const run = (onDeath: string): string[] => {
      const hero = ent({ id: 'hero', hp: 5000, maxHp: 5000 })
      const boss = ent({ id: 'boss', hp: 300, maxHp: 300, onDeath })
      const eng = new BattleEngine([hero], [boss, ent({ id: 'x', hp: 900, maxHp: 900 })], {
        rng: () => 0,
        skills: SKILLS,
      })
      eng.selectSpell(KILL)
      return skillLabels(eng)
    }
    expect(run('条件=ダメージ>=0 候補=burst')).toEqual([])
    expect(run('条件=ダメージ=偶数 候補=burst')).toEqual([])
    expect(run('候補=burst')).toEqual(['じばく'])
  })

  it('即死の被弾は前の被弾の値を残さない（7 のあとの即死で `ダメージ=奇数` の死亡時は動かない）', () => {
    const hero = ent({ id: 'hero', hp: 5000, maxHp: 5000 })
    const boss = ent({
      id: 'boss',
      hp: 300,
      maxHp: 300,
      onDeath: '条件=ダメージ=奇数 候補=burst',
    })
    const eng = new BattleEngine([hero], [boss, ent({ id: 'x', hp: 900, maxHp: 900 })], {
      rng: () => 0,
      skills: SKILLS,
    })
    eng.selectSpell(SEVEN)
    expect(eng.getState().enemyMemory![0].lastDamage).toBe(7)
    eng.selectSpell(KILL)
    expect(boss.hp).toBe(0)
    expect(skillLabels(eng)).toEqual([])
    expect(eng.getState().enemyMemory![0]).not.toHaveProperty('lastDamage')
  })

  it('全体攻撃は敵ごとの数字で判定する（弱点で倍率が変わる敵だけ偶奇が変わる）', () => {
    const hero = ent({ id: 'hero', hp: 5000, maxHp: 5000 })
    const plain = ent({
      id: 'a',
      name: 'A',
      hp: 900,
      maxHp: 900,
      counters: ['条件=ダメージ=奇数 候補=odd'],
    })
    const weak = ent({
      id: 'b',
      name: 'B',
      hp: 900,
      maxHp: 900,
      affinity: { weak: ['fire'] },
      counters: ['条件=ダメージ=奇数 候補=even'],
    })
    const eng = new BattleEngine([hero], [plain, weak], { rng: () => 0, skills: SKILLS })
    eng.selectSpell(spell('ほのおの うみ', 'damage 7..7 type=fire', '敵全体'))
    const mem = eng.getState().enemyMemory!
    expect(mem[0].lastDamage).toBe(7)
    expect(mem[1].lastDamage).not.toBe(7) // 弱点の倍率がかかり、固定の 7 ではなくなる
    expect(skillLabels(eng)[0]).toBe('きすう')
  })

  it('次の被弾で値が更新される', () => {
    const { eng } = fight(['条件=ダメージ=奇数 候補=odd'])
    eng.selectSpell(SEVEN)
    eng.selectSpell(EIGHT)
    eng.selectSpell(SEVEN)
    expect(skillLabels(eng)).toEqual(['きすう', 'きすう']) // 8 のときは反撃しない
  })

  it('`行動:` に書いた敵は、被弾後の自分の手番でその値を見る', () => {
    const { eng, hero } = fight([], 900, {
      actions: ['条件=ダメージ=奇数 候補=odd', '条件=ダメージ=偶数 候補=even'],
    })
    eng.selectSpell(SEVEN) // 敵の手番: 奇数 → きすう（3）
    expect(hero.hp).toBe(5000 - 3)
    eng.selectSpell(EIGHT) // 偶数 → ぐうすう（4）
    expect(hero.hp).toBe(5000 - 3 - 4)
  })
})

describe('旧挙動不変', () => {
  it('ダメージ条件を書かない敵の記憶に lastDamage は増えない', () => {
    const { eng } = fight(['条件=受けた=魔法 候補=odd'])
    eng.selectSpell(SEVEN)
    const m = eng.getState().enemyMemory![0]
    expect(m).not.toHaveProperty('lastDamage')
    expect(m.hits).toBe(1)
  })

  it('反撃なしの敵の戦闘は enemyMemory も作られない', () => {
    const eng = new BattleEngine([ent({ id: 'hero', hp: 5000, maxHp: 5000 })], [ent({ hp: 900 })], {
      rng: () => 0,
    })
    eng.selectSpell(SEVEN)
    expect(eng.getState().enemyMemory).toBeUndefined()
  })

  it('ダメージ条件を書いても書かなくても、同じ入力で乱数列・HP は同じ（反撃の有無以外）', () => {
    const play = (counters: string[]): number[] => {
      const seq: number[] = []
      let i = 0
      const rng = () => {
        seq.push(i)
        return (i++ % 10) / 10
      }
      const hero = ent({ id: 'hero', atk: 20, hp: 5000, maxHp: 5000 })
      const boss = ent({ id: 'boss', hp: 900, maxHp: 900, atk: 30, counters })
      const eng = new BattleEngine([hero], [boss], { rng, skills: SKILLS })
      eng.selectAttack()
      eng.selectSpell(SEVEN)
      return [boss.hp, hero.hp, seq.length]
    }
    // 条件が一度も成立しない書き方（ダメージ >= 99999）なら、書かない敵と同じ結果
    expect(play(['条件=ダメージ>=99999 候補=odd'])).toEqual(play(['条件=受けた=雷 候補=odd']))
  })
})

describe('エンジン統合（ATB）', () => {
  it('ATB でも味方の行動の被弾でダメージ条件が働く', () => {
    const hero = ent({ id: 'hero', hp: 5000, maxHp: 5000, agi: 25 })
    const boss = ent({
      id: 'boss',
      hp: 900,
      maxHp: 900,
      agi: 1,
      counters: ['条件=ダメージ=奇数 候補=odd', '条件=ダメージ=偶数 候補=even'],
    })
    const eng = new BattleEngine([hero], [boss], {
      rng: () => 0,
      skills: SKILLS,
      atb: { initialGauges: { party: [1000] } },
    })
    eng.selectSpell(SEVEN)
    expect(skillLabels(eng)).toEqual(['きすう'])
    expect(eng.getState().enemyMemory![0].lastDamage).toBe(7)
  })
})

/**
 * 数字が出なかった手番では、前回の値を持ち越さない (#871)。
 * 8（偶数）を当てたあと、HP が減らない被弾（MISS・無効・吸収・表示 0）や、即死・その行動の対象外の手番を挟んでも、
 * `行動:` の `ダメージ=偶数` が前回の値で成立してはならない。画面に出た数字だけを見て推理できることが目的
 */
describe('数字が出なかった手番で前回の値を残さない', () => {
  const NULLIFY = spell('みずでっぽう', 'damage 5..5 type=water')
  const ABSORB = spell('かみなり', 'damage 5..5 type=thunder')
  const ZERO = spell('からぶり', 'damage 0..0')
  const waiting = ['条件=ダメージ=偶数 候補=even', '条件=ダメージ=奇数 候補=odd', '候補=こうげき']

  const duel = (extra: Partial<BattleEntity> = {}) => {
    const hero = ent({ id: 'hero', hp: 5000, maxHp: 5000 })
    const boss = ent({
      id: 'boss',
      name: 'ボス',
      hp: 900,
      maxHp: 900,
      actions: waiting,
      affinity: { nullify: ['water'], absorb: ['thunder'] },
      ...extra,
    })
    const eng = new BattleEngine([hero], [boss], { rng: () => 0, skills: SKILLS })
    return { eng, hero, boss }
  }

  /** 8 を当てて偶数トリガー（ぐうすう）が引かれたことを確かめてから、`next` を撃つ。次の手番の敵の行動ラベルを返す */
  const afterEight = (next: (eng: BattleEngine) => void, extra: Partial<BattleEntity> = {}) => {
    const { eng, boss } = duel(extra)
    eng.selectSpell(EIGHT)
    expect(skillLabels(eng)).toEqual(['ぐうすう'])
    expect(eng.getState().enemyMemory![0].lastDamage).toBe(8)
    boss.hp = boss.maxHp
    next(eng)
    return { eng, labels: skillLabels(eng).slice(1) }
  }

  it('無効（MISS 表示）のあとは値なし。偶数のトリガーは再発動しない', () => {
    const { eng, labels } = afterEight((e) => e.selectSpell(NULLIFY))
    const hit = eng.getState().events.filter((e) => e.kind === 'spell')[1].hits[0]
    expect(hit.kind).toBe('miss')
    expect(eng.getState().enemyMemory![0]).not.toHaveProperty('lastDamage')
    expect(labels).toEqual([]) // 条件が一つも成立しない → 通常攻撃
  })

  it('吸収（回復になる）のあとは値なし', () => {
    const { eng, labels } = afterEight((e) => e.selectSpell(ABSORB))
    const hit = eng.getState().events.filter((e) => e.kind === 'spell')[1].hits[0]
    expect(hit.kind).toBe('heal')
    expect(eng.getState().enemyMemory![0]).not.toHaveProperty('lastDamage')
    expect(labels).toEqual([])
  })

  it('表示が 0 のダメージは値 0。「0 は偶数」なので偶数が成立し、ダメージ=0 も成立する', () => {
    const { eng, labels } = afterEight((e) => e.selectSpell(ZERO))
    expect(eng.getState().enemyMemory![0].lastDamage).toBe(0)
    expect(labels).toEqual(['ぐうすう'])
    const zero = duel({ actions: ['条件=ダメージ=0 候補=odd', '候補=even'] })
    zero.eng.selectSpell(SEVEN)
    expect(skillLabels(zero.eng)).toEqual(['ぐうすう']) // 7 は 0 でない
    zero.eng.selectSpell(ZERO)
    expect(skillLabels(zero.eng)).toEqual(['ぐうすう', 'きすう'])
  })

  it('奇数 7 のあとの値 0 では奇数が成立しない（前回の 7 を使わない）', () => {
    const { eng } = duel()
    eng.selectSpell(SEVEN)
    eng.selectSpell(ZERO)
    expect(skillLabels(eng)).toEqual(['きすう', 'ぐうすう'])
  })

  it('別の敵への攻撃（この行動の対象外）では、対象外の敵の前回の値を持ち越さない', () => {
    const hero = ent({ id: 'hero', hp: 5000, maxHp: 5000 })
    const a = ent({ id: 'a', name: 'A', hp: 900, maxHp: 900, actions: waiting })
    const b = ent({ id: 'b', name: 'B', hp: 900, maxHp: 900 })
    const eng = new BattleEngine([hero], [a, b], { rng: () => 0, skills: SKILLS })
    eng.selectSpell(EIGHT, 'a')
    expect(eng.getState().enemyMemory![0].lastDamage).toBe(8)
    expect(skillLabels(eng)).toEqual(['ぐうすう'])
    eng.selectSpell(SEVEN, 'b') // A には当たらない
    expect(eng.getState().enemyMemory![0]).not.toHaveProperty('lastDamage')
    expect(skillLabels(eng).slice(1)).toEqual([]) // A は偶数のトリガーを再発動しない
  })

  it('複数ヒットは画面に出た数字の合計。無効な敵は値なし、当たった敵は合計（全体）', () => {
    const hero = ent({ id: 'hero', hp: 5000, maxHp: 5000 })
    const a = ent({ id: 'a', name: 'A', hp: 900, maxHp: 900, actions: waiting })
    const b = ent({
      id: 'b',
      name: 'B',
      hp: 900,
      maxHp: 900,
      actions: waiting,
      affinity: { nullify: ['water'] },
    })
    const eng = new BattleEngine([hero], [a, b], { rng: () => 0, skills: SKILLS })
    eng.selectSpell(spell('みずのれんだ', 'damage 5..5 回数=3 type=water', '敵全体'))
    const mem = eng.getState().enemyMemory!
    expect(mem[0].lastDamage).toBe(15)
    expect(mem[1]).not.toHaveProperty('lastDamage')
  })

  it('ダメージ条件を書かない敵には lastDamage を書かない（記憶・乱数は不変）', () => {
    const { eng } = fight(['条件=受けた=魔法 候補=odd'])
    eng.selectSpell(SEVEN)
    eng.selectSpell(ZERO)
    expect(eng.getState().enemyMemory![0]).not.toHaveProperty('lastDamage')
  })
})
