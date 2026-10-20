/**
 * 検証ハーネスのシナリオ生成 (#877 段階 3)。総当たり（規則の組み合わせの直積）と、seed 固定のランダム合成。
 * 生成は決定論的: 同じ引数なら同じシナリオ列になる。
 *
 * 対象は**現状エンジンに実装があるものだけ**: 効果 DSL の全動詞 × 耐性・属性相性 × HP × 範囲 × 複数ヒット `回数=N`、
 * 状態/バフの重ね順、反撃・死亡時・敵の行動、ATB、宣言した状態異常 (#870。継続ダメージ・行動不能・混乱・満了・回復の反転 × 付与の確率・持続・耐性)。
 */
import type { SkillExecution } from '../battleEngine'
import type { BattleEntity } from '../spellDsl'
import type { StatusDef } from '../../types'
import { lcg } from './rng'
import type { Op, Scenario } from './scenario'

export type Family =
  | 'effect-matrix'
  | 'enemy-skill'
  | 'stack-order'
  | 'reaction-chain'
  | 'random'
  | 'status-matrix'
  | 'random-status'

/** 効果 DSL の文字列。動詞ごとに通常値と境界値（0・負・min>max・極大・不正値）を並べる */
export const EFFECTS: readonly string[] = [
  'damage 0..0',
  'damage 1..1',
  'damage 10..20 type=fire',
  'damage 20..10 type=fire',
  'damage -5..-1',
  'damage -1000000..-1 type=fire',
  'damage 100000..100000 type=fire',
  'damage 999999999..999999999',
  'damage 5..9 type=fire 回数=2',
  'damage 5..9 type=fire 回数=99',
  'damage 5000..9000 type=fire 回数=99',
  'damage 5..9 回数=100',
  'damage 5..9 回数=0',
  'damage 5..9 回数=abc',
  'heal 0..0',
  'heal 10..20',
  'heal -5..-1',
  'heal -1000000..-1',
  'heal 99999999..99999999',
  'heal_full',
  'damage_full',
  'damage_full 回数=3',
  'buff atk=+5 duration=3',
  'buff atk=+999999999',
  'buff def=-999999999',
  'debuff agi=-3 duration=0',
  'debuff atk=5 duration=-1',
  'status poison duration=3',
  'status paralysis duration=0',
  'status sleep duration=-1',
  'status __proto__',
  'revive',
  'revive hp=half',
  'escape_battle',
  'escape_dungeon',
  'damage',
  'buff',
]

/** 状態/バフの重ね順に使う小さい集合 */
export const STACK_EFFECTS: readonly string[] = [
  'buff atk=+5 duration=2',
  'buff atk=+1000000',
  'debuff atk=-1000000',
  'status poison duration=3',
  'heal 50..50',
  'damage 30..30 type=fire',
]

/** 反撃・死亡時・行動に使う小さい集合 */
const REACTION_EFFECTS: readonly string[] = [
  'damage 30..30',
  'damage 5000..9000 回数=3',
  'damage 100000..100000',
  'damage_full',
  'heal 100..100',
  'heal -50..-1',
  'status poison duration=3',
  'buff atk=+999999',
]

const SPELL_SCOPES = ['敵単体', '敵全体', '味方単体', '味方全体', '自分'] as const
const SKILL_SCOPES = ['相手単体', '相手全体', '自分', '仲間単体', '仲間全体'] as const

/** 相手側（耐性・属性相性）の変種 */
const DEFENDER_VARIANTS: ReadonlyArray<{ name: string; over: Partial<BattleEntity> }> = [
  { name: 'plain', over: {} },
  { name: 'resist0', over: { resist: { fire: 0 } } },
  { name: 'resist0.5', over: { resist: { fire: 0.5 } } },
  { name: 'resist2', over: { resist: { fire: 2 } } },
  { name: 'resist-1', over: { resist: { fire: -1 } } },
  { name: 'resist1e9', over: { resist: { fire: 1e9 } } },
  { name: 'absorb', over: { affinity: { absorb: ['fire', 'death'] } } },
  { name: 'nullify', over: { affinity: { nullify: ['fire', 'death'] } } },
  { name: 'halve', over: { affinity: { halve: ['fire', 'death'] } } },
  { name: 'weak', over: { affinity: { weak: ['fire', 'death'] } } },
]

/** HP の変種（0 = 倒れている）。maxHp は固定で、hp だけ変える（maxHp 超過のないように hp <= maxHp） */
const HP_VARIANTS: ReadonlyArray<{ name: string; hp: number; maxHp: number }> = [
  { name: 'hp0', hp: 0, maxHp: 100 },
  { name: 'hp1', hp: 1, maxHp: 100 },
  { name: 'hp100', hp: 100, maxHp: 100 },
  { name: 'hp50000', hp: 50_000, maxHp: 50_000 },
  { name: 'hp1e9', hp: 1_000_000_000, maxHp: 1_000_000_000 },
]

export function entity(id: string, over: Partial<BattleEntity> = {}): BattleEntity {
  return {
    id,
    name: id.toUpperCase(),
    hp: 100,
    maxHp: 100,
    mp: 999,
    maxMp: 999,
    atk: 10,
    def: 0,
    agi: 5,
    ...over,
  }
}

function foe(id: string, over: Partial<BattleEntity> = {}): BattleEntity {
  return entity(id, { mp: 0, maxMp: 0, exp: 7, gold: 3, ...over })
}

const ATK: Op = { t: 'attack' }

/** 効果 × 対象の範囲 × 相手の耐性/相性 × 相手の HP。味方が呪文を 3 回撃ち、そのあと決着まで進める */
export function effectMatrix(): Scenario[] {
  const out: Scenario[] = []
  EFFECTS.forEach((effect, ei) => {
    for (const scope of SPELL_SCOPES) {
      for (const dv of DEFENDER_VARIANTS) {
        for (const hv of HP_VARIANTS) {
          // 敵 2 体（1 体目が variant、2 体目は 1 体目と同じ変種だが常に生存）、味方 2 体にも同じ耐性を付ける
          const defender = { ...dv.over, hp: hv.hp, maxHp: hv.maxHp }
          out.push({
            id: `effect-matrix/e${ei}/${scope}/${dv.name}/${hv.name}`,
            seed: 1000 + out.length,
            party: [entity('a', defender), entity('b', { ...dv.over })],
            enemies: [foe('s', defender), foe('t', { ...dv.over, hp: 500, maxHp: 500 })],
            spells: [{ name: 'テスト', mp: 0, target: scope, effect }],
            items: [],
            ops: [{ t: 'spell', s: 0 }, { t: 'spell', s: 0 }, { t: 'spell', s: 0 }, ATK],
          })
        }
      }
    }
  })
  return out
}

/** 敵が特技として同じ効果を使う（`行動:`）。味方側に耐性/相性・HP の変種を付ける */
export function enemySkillMatrix(): Scenario[] {
  const out: Scenario[] = []
  EFFECTS.forEach((effect, ei) => {
    for (const scope of SKILL_SCOPES) {
      for (const dv of DEFENDER_VARIANTS) {
        // hp0（味方が倒れている）は外す: 味方 HP 0 だと戦闘が始まらないので、実質 HP 1 の hp1 と重複する。10 億 HP も敵スキルでは不要
        for (const hv of HP_VARIANTS.filter((h) => h.hp > 0 && h.hp <= 50_000)) {
          const skill: SkillExecution = { name: 'とくぎ', target: scope, effect }
          out.push({
            id: `enemy-skill/e${ei}/${scope}/${dv.name}/${hv.name}`,
            seed: 5000 + out.length,
            party: [
              entity('a', { ...dv.over, hp: hv.hp, maxHp: hv.maxHp }),
              entity('b', { ...dv.over }),
            ],
            enemies: [
              foe('s', { hp: 300, maxHp: 300, actions: ['候補=sk'], agi: 9 }),
              foe('t', { hp: 300, maxHp: 300, ...dv.over }),
            ],
            skills: { sk: skill },
            spells: [],
            items: [],
            ops: [ATK, ATK, ATK, ATK],
          })
        }
      }
    }
  })
  return out
}

/** 状態/バフ/回復/ダメージの重ね順（長さ N の列の総当たり）。ATB の有無で 2 倍 */
export function stackOrders(length = 4): Scenario[] {
  const out: Scenario[] = []
  const total = STACK_EFFECTS.length ** length
  for (const atb of [false, true]) {
    for (let n = 0; n < total; n++) {
      const seq: number[] = []
      let x = n
      for (let k = 0; k < length; k++) {
        seq.push(x % STACK_EFFECTS.length)
        x = Math.floor(x / STACK_EFFECTS.length)
      }
      const ops: Op[] = []
      for (const s of seq) {
        ops.push({ t: 'spell', s })
        if (atb) ops.push({ t: 'tick', ms: 5000 })
      }
      ops.push(ATK)
      out.push({
        id: `stack-order/${atb ? 'atb' : 'turn'}/${seq.join('')}`,
        seed: 20_000 + out.length,
        party: [entity('a', { hp: 300, maxHp: 300 }), entity('b', { hp: 300, maxHp: 300 })],
        enemies: [foe('s', { hp: 400, maxHp: 400 }), foe('t', { hp: 400, maxHp: 400 })],
        atb: atb ? { mode: 'active' } : undefined,
        spells: STACK_EFFECTS.map((effect, i) => ({
          name: `s${i}`,
          mp: 0,
          // 偶数番は自分（味方）、奇数番は敵単体に向ける。両方向の重ね掛けを見る
          target: i % 2 === 0 ? '自分' : '敵単体',
          effect,
        })),
        items: [],
        ops,
      })
    }
  }
  return out
}

/** 敵の `行動:` `反撃:` `死亡時:` に別々の特技を割り当てた組み合わせ。ATB の有無で 2 倍 */
export function reactionChains(): Scenario[] {
  const out: Scenario[] = []
  const eff = REACTION_EFFECTS
  for (const atb of [false, true]) {
    for (const [ai, ac] of eff.entries()) {
      for (const [ci, co] of eff.entries()) {
        for (const [di, de] of eff.entries()) {
          out.push({
            id: `reaction-chain/${atb ? 'atb' : 'turn'}/a${ai}c${ci}d${di}`,
            seed: 40_000 + out.length,
            party: [entity('a', { hp: 800, maxHp: 800 }), entity('b', { hp: 800, maxHp: 800 })],
            enemies: [
              foe('s', {
                hp: 60,
                maxHp: 60,
                actions: ['候補=act'],
                counters: ['候補=ctr'],
                onDeath: '候補=dth',
              }),
              foe('t', { hp: 60, maxHp: 60, counters: ['候補=ctr'] }),
            ],
            atb: atb ? { mode: 'active' } : undefined,
            skills: {
              act: { name: 'こうどう', target: '相手単体', effect: ac },
              ctr: { name: 'はんげき', target: '相手単体', effect: co },
              dth: { name: 'あがき', target: '相手全体', effect: de },
            },
            spells: [],
            items: [],
            ops: [ATK, { t: 'tick', ms: 3000 }, ATK, { t: 'tick', ms: 3000 }, ATK],
          })
        }
      }
    }
  }
  return out
}

/**
 * 宣言した状態 (#870) の集合。継続ダメージ（割合・固定幅・上限超え）・行動不能・混乱・被ダメージで解除・満了で戦闘不能・
 * 回復/ダメージの反転・長い持続（永久気味）・全部入り・不正な値だらけの宣言を含む（不正な宣言は警告して既定に落ちるだけで壊れてはならない）
 */
export const STATUS_SET: Readonly<Record<string, StatusDef>> = {
  poison: { id: 'poison', name: 'どく', duration: '3', tickDamage: '1/16' },
  venom: { id: 'venom', name: 'もうどく', duration: '9', tickDamage: '1..99999' },
  sleep: { id: 'sleep', name: 'ねむり', duration: '2', action: '不能', cure: '被ダメージ' },
  coma: { id: 'coma', name: 'こんすい', duration: '99', action: '不能' },
  mad: { id: 'mad', name: 'こんらん', duration: '3', action: '混乱' },
  shock: { id: 'shock', name: 'ぼうぜん', duration: '5', action: '混乱', cure: '被ダメージ' },
  doom: { id: 'doom', name: 'しのせんこく', duration: '2', expire: '戦闘不能' },
  zombie: { id: 'zombie', name: 'ゾンビ', duration: '99', reverse: '回復, ダメージ' },
  healrev: { id: 'healrev', name: 'かいふくぎゃく', reverse: '回復' },
  dmgrev: { id: 'dmgrev', name: 'ダメージかいふく', reverse: 'ダメージ' },
  kitchen: {
    id: 'kitchen',
    name: 'ぜんぶいり',
    duration: '4',
    tickDamage: '5..20',
    action: '混乱',
    reverse: '回復, ダメージ',
    cure: '被ダメージ',
    expire: '戦闘不能',
  },
  weird: {
    id: 'weird',
    name: 'ふせい',
    duration: 'abc',
    tickDamage: '1/0',
    action: '???',
    reverse: '??',
    cure: '??',
    expire: '??',
  },
}

const STATUS_IDS = Object.keys(STATUS_SET)

/** 状態の効果 DSL（付与の持続・確率の境界、解除、反転の対象になる回復/ダメージ）。ids は `STATUS_SET` の id から作る */
function statusEffects(ids: readonly string[]): string[] {
  const out: string[] = []
  for (const id of ids) {
    out.push(
      `status ${id}`,
      `status ${id} duration=1`,
      `status ${id} duration=99`,
      `status ${id} duration=100`,
      `status ${id} duration=0`,
      `status ${id} 確率=50`,
      `status ${id} 確率=99`,
      `status ${id} 確率=0`,
      `status ${id} 確率=100`,
      `status ${id} 確率=abc`,
      `cure ${id}`
    )
  }
  out.push(
    'cure all',
    'cure',
    'heal 30..30',
    'heal_full',
    'heal -5..-1',
    'damage 30..30',
    'damage 30..30 type=fire',
    'damage_full',
    'damage 5..9 回数=3',
    'revive',
    'status marker duration=3' // 宣言の無い印は何も起きない
  )
  return out
}

/** 状態の耐性変種（属性相性の欄に状態 id と `death` を書く） */
const STATUS_AFFINITIES: ReadonlyArray<{
  name: string
  over: (id: string) => Partial<BattleEntity>
}> = [
  { name: 'plain', over: () => ({}) },
  { name: 'nullify', over: (id) => ({ affinity: { nullify: [id, 'death'] } }) },
  { name: 'absorb', over: (id) => ({ affinity: { absorb: [id, 'death'] } }) },
  { name: 'halve', over: (id) => ({ affinity: { halve: [id, 'death'] } }) },
  { name: 'weak', over: (id) => ({ affinity: { weak: [id, 'death'] } }) },
]

const MODES: ReadonlyArray<{ name: string; atb?: Scenario['atb'] }> = [
  { name: 'turn' },
  { name: 'atb-wait', atb: { mode: 'wait' } },
  { name: 'atb-active', atb: { mode: 'active' } },
]

/**
 * 宣言した状態の総当たり (#870)。状態 × 付与の持続 × 確率 × 相手の耐性 × 進行方式。
 * 味方が呪文で敵単体・自分・味方全体へ付け、敵が特技で味方全体・自分へ付ける。そのあと決着まで進めて、ロック・無限ループ・不変条件違反を見る
 */
export function statusMatrix(): Scenario[] {
  const out: Scenario[] = []
  for (const mode of MODES) {
    for (const id of STATUS_IDS) {
      for (const dur of ['', ' duration=1', ' duration=99', ' duration=100']) {
        for (const chance of ['', ' 確率=50', ' 確率=99']) {
          for (const aff of STATUS_AFFINITIES) {
            const effect = `status ${id}${dur}${chance}`
            const spell = (target: string) => ({ name: `s-${target}`, mp: 0, target, effect })
            out.push({
              id: `status-matrix/${mode.name}/${id}${dur.replace(/\s|=/g, '')}${chance.replace(/\s|=/g, '')}/${aff.name}`,
              seed: 60_000 + out.length,
              party: [
                entity('a', { hp: 300, maxHp: 300, agi: 12, ...aff.over(id) }),
                entity('b', { hp: 300, maxHp: 300, agi: 8 }),
              ],
              enemies: [
                foe('s', {
                  hp: 400,
                  maxHp: 400,
                  agi: 9,
                  actions: ['候補=sk'],
                  ...aff.over(id),
                }),
                foe('t', { hp: 400, maxHp: 400, agi: 6, ...aff.over(id) }),
              ],
              ...(mode.atb ? { atb: mode.atb } : {}),
              statuses: { ...STATUS_SET },
              skills: { sk: { name: 'のろい', target: '相手全体', effect } },
              spells: [spell('敵単体'), spell('自分'), spell('味方全体'), spell('敵全体')],
              items: [],
              ops: [
                { t: 'spell', s: 0 },
                { t: 'tick', ms: 4000 },
                { t: 'spell', s: 1 },
                { t: 'tick', ms: 4000 },
                { t: 'spell', s: 2 },
                { t: 'spell', s: 3 },
                ATK,
                { t: 'tick', ms: 4000 },
                ATK,
              ],
            })
          }
        }
      }
    }
  }
  return out
}

const pick = <T>(rng: () => number, xs: readonly T[]): T => xs[Math.floor(rng() * xs.length)]

/**
 * 状態を常に宣言したランダム合成 (#870)。効果は状態の付与・解除・反転の対象を中心に、能力値・HP・耐性・敵の台本・操作列をランダムに組む。
 * seed 固定で決定論的
 */
export function randomStatusScenarios(seed: number, count: number): Scenario[] {
  const out: Scenario[] = []
  const effects = statusEffects(STATUS_IDS)
  const HPS = [1, 5, 100, 9999, 50_000]
  const ATKS = [0, 1, 10, 100, 9999]
  const AGIS = [0, 1, 5, 50, 1000]
  for (let n = 0; n < count; n++) {
    const sseed = (seed * 6151 + n * 77_711) >>> 0
    const rng = lcg(sseed)
    const side = (id: string, enemy: boolean): BattleEntity => {
      const hp = pick(rng, HPS)
      const aff = pick(rng, STATUS_AFFINITIES).over(pick(rng, STATUS_IDS))
      const status: Record<string, number> = {}
      // 最初から状態を持って始まる者もいる（行動不能・混乱で始まる戦闘、倒れていない者だけ）
      if (rng() < 0.4) status[pick(rng, STATUS_IDS)] = 1 + Math.floor(rng() * 5)
      const over: Partial<BattleEntity> = {
        hp,
        maxHp: hp,
        atk: pick(rng, ATKS),
        def: 0,
        agi: pick(rng, AGIS),
        ...(Object.keys(status).length > 0 ? { status } : {}),
        ...(rng() < 0.3 ? { statusChanceBonus: Math.floor(rng() * 200) - 50 } : {}),
        ...aff,
      }
      return enemy ? foe(id, over) : entity(id, over)
    }
    const skillIds = ['k0', 'k1', 'k2']
    const skills: Record<string, SkillExecution> = {}
    for (const id of skillIds) {
      skills[id] = { name: id, target: pick(rng, SKILL_SCOPES), effect: pick(rng, effects) }
    }
    const enemies = [side('s', true), side('t', true)]
    enemies.forEach((e) => {
      if (rng() < 0.6) e.actions = [`候補=${pick(rng, skillIds)}`]
      if (rng() < 0.3) e.counters = [`候補=${pick(rng, skillIds)}`]
      if (rng() < 0.2) e.onDeath = `候補=${pick(rng, skillIds)}`
    })
    const spells = Array.from({ length: 4 }, (_, i) => ({
      name: `m${i}`,
      mp: 0,
      target: pick(rng, SPELL_SCOPES) as string,
      effect: pick(rng, effects),
    }))
    const items = [{ name: 'i0', effect: pick(rng, effects) }]
    const ops: Op[] = []
    const opCount = 20 + Math.floor(rng() * 30)
    for (let k = 0; k < opCount; k++) {
      const r = rng()
      if (r < 0.3) ops.push({ t: 'attack' })
      else if (r < 0.65) ops.push({ t: 'spell', s: Math.floor(rng() * spells.length) })
      else if (r < 0.75) ops.push({ t: 'item', i: 0 })
      else if (r < 0.8) ops.push({ t: 'escape' })
      else ops.push({ t: 'tick', ms: Math.floor(rng() * 4000) + 1 })
    }
    const atbMode = rng()
    out.push({
      id: `random-status/${seed}-${n}`,
      seed: sseed,
      party: [side('a', false), side('b', false)],
      enemies,
      atb: atbMode < 0.33 ? { mode: 'wait' } : atbMode < 0.66 ? { mode: 'active' } : undefined,
      statuses: { ...STATUS_SET },
      skills,
      spells,
      items,
      ops,
    })
  }
  return out
}

/** seed 固定のランダム合成。能力値・HP は境界値の集合から選び、呪文・敵の台本・操作列をランダムに組む */
export function randomScenarios(seed: number, count: number): Scenario[] {
  const out: Scenario[] = []
  const HPS = [1, 5, 100, 9999, 10_000, 50_000, 1_000_000]
  const ATKS = [0, 1, 10, 100, 9999, 100_000]
  const DEFS = [0, 5, 100, 100_000]
  const AGIS = [0, 1, 5, 50, 1000]
  for (let n = 0; n < count; n++) {
    const sseed = (seed * 7919 + n * 104_729) >>> 0
    const rng = lcg(sseed)
    const side = (id: string, enemy: boolean): BattleEntity => {
      const hp = pick(rng, HPS)
      const dv = pick(rng, DEFENDER_VARIANTS)
      const over: Partial<BattleEntity> = {
        hp,
        maxHp: hp,
        atk: pick(rng, ATKS),
        def: pick(rng, DEFS),
        agi: pick(rng, AGIS),
        ...dv.over,
      }
      return enemy ? foe(id, over) : entity(id, over)
    }
    const skillIds = ['k0', 'k1', 'k2']
    const skills: Record<string, SkillExecution> = {}
    for (const id of skillIds) {
      skills[id] = { name: id, target: pick(rng, SKILL_SCOPES), effect: pick(rng, EFFECTS) }
    }
    const enemies = [side('s', true), side('t', true)]
    enemies.forEach((e) => {
      if (rng() < 0.5) e.actions = [`候補=${pick(rng, skillIds)}`]
      if (rng() < 0.4) e.counters = [`候補=${pick(rng, skillIds)}`]
      if (rng() < 0.3) e.onDeath = `候補=${pick(rng, skillIds)}`
    })
    const spells = Array.from({ length: 4 }, (_, i) => ({
      name: `m${i}`,
      mp: Math.floor(rng() * 3),
      target: pick(rng, SPELL_SCOPES) as string,
      effect: pick(rng, EFFECTS),
    }))
    const items = [{ name: 'i0', effect: pick(rng, EFFECTS) }]
    const ops: Op[] = []
    const opCount = 30 + Math.floor(rng() * 40)
    for (let k = 0; k < opCount; k++) {
      const r = rng()
      if (r < 0.3) ops.push({ t: 'attack' })
      else if (r < 0.6) ops.push({ t: 'spell', s: Math.floor(rng() * spells.length) })
      else if (r < 0.7) ops.push({ t: 'item', i: 0 })
      else if (r < 0.75) ops.push({ t: 'escape' })
      else ops.push({ t: 'tick', ms: Math.floor(rng() * 4000) + 1 })
    }
    const atbMode = rng()
    out.push({
      id: `random/${seed}-${n}`,
      seed: sseed,
      party: [side('a', false), side('b', false)],
      enemies,
      atb: atbMode < 0.33 ? { mode: 'wait' } : atbMode < 0.66 ? { mode: 'active' } : undefined,
      skills,
      spells,
      items,
      ops,
    })
  }
  return out
}
