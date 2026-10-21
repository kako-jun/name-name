/**
 * 検証ハーネスのシナリオ生成 (#877 段階 3)。総当たり（規則の組み合わせの直積）と、seed 固定のランダム合成。
 * 生成は決定論的: 同じ引数なら同じシナリオ列になる。
 *
 * 対象は**現状エンジンに実装があるものだけ**: 効果 DSL の全動詞 × 耐性・属性相性 × HP × 範囲 × 複数ヒット `回数=N`、
 * 状態/バフの重ね順、反撃・死亡時・敵の行動、ATB、宣言した状態異常 (#870。継続ダメージ・行動不能・混乱・満了・回復の反転 × 付与の確率・持続・耐性)。
 */
import type { SkillExecution, SummonExecution } from '../battleEngine'
import type { BattleEntity } from '../spellDsl'
import type { ItemDef, JobDef, MagiciteDef, MonsterLoot, StatusDef, SummonCue } from '../../types'
import { applyMemberMagicite, resolveMemberMagicite } from '../magicite'
import { resolveMemberEquipment } from '../equipment'
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
  | 'damage-condition'
  | 'magicite'
  | 'loot'
  | 'equipment'
  | 'summon'
  | 'job'

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

/** ダメージ条件 (#871) の式。値の境界・不正な書式（警告して無視されるだけで壊れてはならない）を含む */
export const DAMAGE_CONDITIONS: readonly string[] = [
  'ダメージ=奇数',
  'ダメージ=偶数',
  'ダメージ=3の倍数',
  'ダメージ>=100',
  'ダメージ<10',
  'ダメージ=0',
  'ダメージ桁数>=4',
  'ダメージ=奇数, 受けた=魔法',
  'ダメージ=奇数, ダメージ>=5',
  'ダメージ=abc',
  'ダメージ桁数=奇数',
  'ダメージ=0の倍数',
]

/** 条件を書く場所（`行動:` `反撃:` `死亡時:`） */
const DAMAGE_CONDITION_PLACES = ['actions', 'counters', 'onDeath'] as const

/** 受けるダメージの元。固定（奇数・偶数）・乱数幅・複数ヒット・極大・即死・回復・相性が絡むもの */
const DAMAGE_SOURCES: readonly string[] = [
  'damage 0..0',
  'damage 7..7',
  'damage 8..8',
  'damage 5..9',
  'damage 7..7 回数=3',
  'damage 100000..100000',
  'damage 50..50 type=fire',
  'damage_full',
  'heal 10..10',
]

/**
 * 敵の条件 `ダメージ…` (#871): 条件 × 書く場所 × 受けるダメージの元 × 相手の相性 × 敵の HP（小さい=倒れる）× ターン制/ATB。
 * 味方が呪文を 3 回撃ってから攻撃し、決着まで進める。反撃・死亡時・行動の特技は固定ダメージ
 */
export function damageConditions(): Scenario[] {
  const out: Scenario[] = []
  const variants = DEFENDER_VARIANTS.filter((v) =>
    ['plain', 'resist0', 'absorb', 'nullify', 'weak'].includes(v.name)
  )
  for (const atb of [false, true]) {
    DAMAGE_CONDITIONS.forEach((cond, ci) => {
      for (const place of DAMAGE_CONDITION_PLACES) {
        DAMAGE_SOURCES.forEach((src, si) => {
          for (const dv of variants) {
            for (const [hv, after8] of [
              [30, false],
              [900, false],
              [900, true],
            ] as const) {
              const script =
                place === 'onDeath'
                  ? { onDeath: `条件=${cond} 候補=ctr` }
                  : { [place]: [`条件=${cond} 候補=ctr`, '候補=こうげき'] }
              out.push({
                id: `damage-condition/${atb ? 'atb' : 'turn'}/c${ci}/${place}/s${si}/${dv.name}/hp${hv}${after8 ? '/after8' : ''}`,
                seed: 60_000 + out.length,
                party: [entity('a', { hp: 800, maxHp: 800 }), entity('b', { hp: 800, maxHp: 800 })],
                enemies: [
                  foe('s', { ...dv.over, hp: hv, maxHp: hv, ...script }),
                  foe('t', { hp: 500, maxHp: 500 }),
                ],
                atb: atb ? { mode: 'active' } : undefined,
                skills: { ctr: { name: 'はんげき', target: '相手単体', effect: 'damage 3..3' } },
                spells: [
                  { name: 'テスト', mp: 0, target: '敵単体', effect: src },
                  { name: 'やっつ', mp: 0, target: '敵単体', effect: 'damage 8..8' },
                ],
                items: [],
                // after8: 先に 8（偶数）を当ててから src を受ける。MISS・無効・吸収・表示 0・即死のあとに前回の 8 が残らないことを検出器が見る
                ops: after8
                  ? [
                      { t: 'spell', s: 1 },
                      { t: 'tick', ms: 3000 },
                      { t: 'spell', s: 0 },
                      { t: 'tick', ms: 3000 },
                      { t: 'spell', s: 1 },
                      { t: 'tick', ms: 3000 },
                      { t: 'spell', s: 0 },
                      ATK,
                    ]
                  : [
                      { t: 'spell', s: 0 },
                      { t: 'tick', ms: 3000 },
                      { t: 'spell', s: 0 },
                      { t: 'tick', ms: 3000 },
                      { t: 'spell', s: 0 },
                      ATK,
                    ],
              })
            }
          }
        })
      }
    })
  }
  return out
}

/** ぬすむ (#831) の効果 DSL。確率・レア率・枠・回数・ぶんどるの通常値と境界値・不正値 */
export const STEAL_EFFECTS: readonly string[] = [
  'steal',
  'steal 確率=0',
  'steal 確率=60',
  'steal 確率=100',
  'steal 確率=999',
  'steal 確率=-5',
  'steal 確率=abc',
  'steal 枠=レア',
  'steal 枠=通常',
  'steal 枠=ふしぎ',
  'steal 枠=レア レア率=40',
  'steal レア率=100',
  'steal レア率=0',
  'steal 回数=3',
  'steal 回数=99',
  'steal 回数=100',
  'steal 回数=0',
  'steal ぶんどる=8..14',
  'steal ぶんどる=100000..100000 type=fire',
  'steal ぶんどる=abc',
  'steal 確率=60 レア率=30 枠=両方 回数=2 ぶんどる=1..2',
]

/** 敵の戦利品の宣言の変種 (#831)。通常/レア枠の構成・確率・個数・盗める回数・不正な行 */
const LOOT_VARIANTS: ReadonlyArray<{ name: string; loot?: MonsterLoot }> = [
  { name: 'none' },
  { name: 'normal', loot: { steal: ['potion'] } },
  { name: 'rare', loot: { stealRare: ['elixir'] } },
  { name: 'both', loot: { steal: ['potion'], stealRare: ['elixir'], drops: ['ether'] } },
  {
    name: 'chances',
    loot: {
      steal: ['a 確率=50', 'b 確率=0', 'c 個数=3'],
      stealRare: ['r 確率=30'],
      drops: ['d1 確率=50', 'd2 個数=5', 'd3 確率=0'],
    },
  },
  { name: 'limit3', loot: { steal: ['potion'], stealRare: ['elixir'], stealLimit: '3' } },
  { name: 'unlimited', loot: { steal: ['potion'], stealRare: ['elixir'], stealLimit: '無限' } },
  {
    name: 'invalid',
    loot: {
      steal: ['確率=50', 'p 確率=abc', 'q 個数=1000', 'ok 確率=150'],
      stealRare: ['r 個数=0'],
      drops: ['d 確率=zz', 'e 確率=100'],
      stealLimit: 'abc',
    },
  },
]

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

/** 魔石 (#889) の宣言の集合。属性なし・1 属性・2 属性・装備時/成長のボーナス（負の極端な値を含む）・不正なボーナスの書式を含む */
export const MAGICITE_SET: Readonly<Record<string, MagiciteDef>> = {
  water: {
    id: 'water',
    name: 'みず',
    elements: ['water'],
    target: '相手単体',
    equipBonus: 'hp+20, atk+3',
  },
  water2: { id: 'water2', name: 'みず2', elements: ['water'], target: '相手単体', growth: 'hp+2' },
  fire: { id: 'fire', name: 'ひ', elements: ['fire'], target: '相手単体', equipBonus: 'agi+2' },
  ice: { id: 'ice', name: 'こおり', elements: ['ice'], target: '相手単体' },
  twin: { id: 'twin', name: 'ふたつ', elements: ['fire', 'ice'], target: '相手単体' },
  plain: { id: 'plain', name: 'ただの石', target: '相手単体' },
  heavy: {
    id: 'heavy',
    name: 'おもい石',
    target: '相手単体',
    equipBonus: 'hp-1000000, atk-1000000, def+99999999, mp+5',
  },
  broken: {
    id: 'broken',
    name: 'こわれた石',
    elements: ['water'],
    target: '相手単体',
    equipBonus: 'xx+3, atk+, hp+1.5, def+2',
  },
}

/** 魔石の組み合わせ（装備する魔石 id・枠の数・防具など他の出どころの属性）。層は合計 2 まで・同属性 2 層で吸収 */
const MAGICITE_LOADOUTS: ReadonlyArray<{
  name: string
  ids: string[]
  slots: number
  extra?: string[]
}> = [
  { name: 'none', ids: [], slots: 1 },
  { name: 'water', ids: ['water'], slots: 1 },
  { name: 'water+water', ids: ['water', 'water2'], slots: 2 },
  { name: 'water+fire', ids: ['water', 'fire'], slots: 2 },
  { name: 'three-over', ids: ['water', 'fire', 'ice'], slots: 3 },
  { name: 'twin+extra', ids: ['twin'], slots: 1, extra: ['wind'] },
  { name: 'plain+armor-water', ids: ['plain'], slots: 1, extra: ['water'] },
  { name: 'over-slots', ids: ['water', 'fire'], slots: 1 },
  { name: 'heavy', ids: ['heavy'], slots: 1 },
  { name: 'broken', ids: ['broken'], slots: 1 },
  { name: 'zero-slot', ids: ['water'], slots: 0 },
]

/** 召喚の中身。効果の種類・複数ヒット・即死・状態・極大・不正な書式・効果なし・消費 MP（足りる・足りない） */
export const MAGICITE_SUMMONS: readonly SummonExecution[] = [
  { name: 'ダメージ', target: '相手全体', effect: 'damage 60..60 type=water', mp: 0 },
  { name: '単体', target: '相手単体', effect: 'damage 40..60 type=fire', mp: 0 },
  { name: '回復', target: '仲間全体', effect: 'heal 80..80', mp: 0 },
  { name: '連続', target: '相手全体', effect: 'damage 20..30 type=water 回数=3', mp: 0 },
  { name: '即死', target: '相手単体', effect: 'damage_full', mp: 0 },
  { name: '状態', target: '相手全体', effect: 'status poison duration=3', mp: 0 },
  { name: '極大', target: '相手全体', effect: 'damage 100000..100000', mp: 0 },
  { name: '不正', target: '相手単体', effect: 'foo bar', mp: 0 },
  { name: '演出のみ', target: '自分', mp: 0 },
  { name: '有料', target: '相手全体', effect: 'damage 30..30', mp: 5 },
  { name: '高額', target: '相手全体', effect: 'damage 30..30', mp: 99_999 },
]

/** 魔石の攻撃属性を受ける敵の相性（水・火の単独と複数属性。通常攻撃は複数属性をまとめて判定する） */
const MAGICITE_ENEMY_AFFINITIES: ReadonlyArray<{ name: string; over: Partial<BattleEntity> }> = [
  { name: 'plain', over: {} },
  { name: 'absorb-water', over: { affinity: { absorb: ['water'] } } },
  { name: 'nullify-water', over: { affinity: { nullify: ['water'] } } },
  { name: 'halve-water', over: { affinity: { halve: ['water'] } } },
  { name: 'weak-water', over: { affinity: { weak: ['water'] } } },
  { name: 'absorb-fire-weak-water', over: { affinity: { absorb: ['fire'], weak: ['water'] } } },
  { name: 'weak-fire-halve-water', over: { affinity: { weak: ['fire'], halve: ['water'] } } },
]

/**
 * 魔石 (#889): 魔石の組み合わせ（`MAGICITE_LOADOUTS`。実際の `resolveMemberMagicite` で味方 a を組み立てる）× 召喚の中身 × 敵の相性 ×
 * 敵の HP（小さい=倒れる）× 操作の並び（召喚 2 連打 = 1 バトル 1 回の制限 / 通常攻撃のあとに召喚）× ターン制/ATB。
 * 敵 s は味方全員へ水属性の特技を使い、味方の耐性（半減・吸収）も動かす。決着まで進める
 */
export function magiciteScenarios(): Scenario[] {
  const out: Scenario[] = []
  const tick: Op = { t: 'tick', ms: 3000 }
  for (const atb of [false, true]) {
    for (const lo of MAGICITE_LOADOUTS) {
      const member = entity('a', { hp: 300, maxHp: 300, mp: 50, maxMp: 50 })
      applyMemberMagicite(
        member,
        resolveMemberMagicite(
          { id: 'a', magicites: lo.ids, magiciteSlots: lo.slots },
          {
            magicites: { ...MAGICITE_SET },
            ...(lo.extra ? { extraElements: { a: lo.extra } } : {}),
          }
        )
      )
      MAGICITE_SUMMONS.forEach((summon, si) => {
        for (const ev of MAGICITE_ENEMY_AFFINITIES) {
          for (const hv of [30, 900]) {
            for (const [opName, ops] of [
              [
                'twice',
                [{ t: 'summon', m: si }, tick, { t: 'summon', m: si }, tick, ATK, tick, ATK],
              ],
              [
                'attack-first',
                [ATK, tick, { t: 'summon', m: si }, tick, ATK, tick, { t: 'summon', m: si }],
              ],
            ] as const) {
              out.push({
                id: `magicite/${atb ? 'atb' : 'turn'}/${lo.name}/s${si}/${ev.name}/hp${hv}/${opName}`,
                seed: 70_000 + out.length,
                party: [{ ...member }, entity('b', { hp: 300, maxHp: 300, mp: 50, maxMp: 50 })],
                enemies: [
                  foe('s', { ...ev.over, hp: hv, maxHp: hv, actions: ['候補=wave'], agi: 9 }),
                  foe('t', { hp: 500, maxHp: 500 }),
                ],
                atb: atb ? { mode: 'active' } : undefined,
                skills: {
                  wave: { name: 'なみ', target: '相手全体', effect: 'damage 40..40 type=water' },
                },
                spells: [],
                items: [],
                summons: [summon],
                ops: [...ops],
              })
            }
          }
        }
      })
    }
  }
  return out
}

/**
 * ぬすむ・ドロップ (#831)。効果 DSL `steal`（確率・レア率・枠・回数・ぶんどるの境界値と不正値）× 対象の範囲 × 敵の戦利品の宣言
 * （通常/レア枠・確率・個数・盗める回数・不正な行）× 使い手の加算（なし・+50・極大・極小）× 敵の HP（倒れる・倒れない）× ターン制/ATB。
 * 味方が 4 回ぬすんでから攻撃し、決着までの間のドロップも見る。不変条件は `loot-invariant`（`detect.ts`）。
 */
export function lootMatrix(): Scenario[] {
  const out: Scenario[] = []
  const bonuses = [
    { name: 'bonus0', over: {} },
    { name: 'bonus50', over: { stealChanceBonus: 50, stealRareBonus: 50 } },
    { name: 'bonus1e9', over: { stealChanceBonus: 1e9, stealRareBonus: 1e9 } },
    { name: 'bonus-1e9', over: { stealChanceBonus: -1e9, stealRareBonus: -1e9 } },
  ]
  for (const atb of [false, true]) {
    STEAL_EFFECTS.forEach((effect, ei) => {
      for (const scope of SPELL_SCOPES) {
        for (const lv of LOOT_VARIANTS) {
          for (const bv of bonuses) {
            // 範囲外の対象（味方・自分）は戦利品の宣言を 1 種類だけに絞って数を抑える（盗めないことの確認で十分）
            if (
              (scope === '味方単体' || scope === '味方全体' || scope === '自分') &&
              lv.name !== 'both'
            ) {
              continue
            }
            for (const hp of [20, 500]) {
              const ops: Op[] = []
              for (let i = 0; i < 4; i++) {
                ops.push({ t: 'spell', s: 0 })
                if (atb) ops.push({ t: 'tick', ms: 4000 })
              }
              ops.push(ATK)
              out.push({
                id: `loot/${atb ? 'atb' : 'turn'}/e${ei}/${scope}/${lv.name}/${bv.name}/hp${hp}`,
                seed: 80_000 + out.length,
                party: [
                  entity('a', { hp: 900, maxHp: 900, ...bv.over }),
                  entity('b', { hp: 900, maxHp: 900 }),
                ],
                enemies: [
                  foe('s', { hp, maxHp: hp, ...(lv.loot ? { loot: lv.loot } : {}) }),
                  foe('t', {
                    hp: 500,
                    maxHp: 500,
                    loot: { steal: ['potion'], stealRare: ['elixir'], drops: ['ether'] },
                  }),
                ],
                atb: atb ? { mode: 'active' } : undefined,
                spells: [{ name: 'ぬすむ', mp: 0, target: scope, effect }],
                items: [],
                ops,
              })
            }
          }
        }
      }
    })
  }
  return out
}

/** 装備品 (#207) の宣言の集合。武器・防具・盾・兜、属性防御（同属性 2 つで吸収）、極端なボーナス・不正なボーナスの書式、装備できない種別・`装備可` の制限・宣言の無いわざを含む */
export const EQUIPMENT_SET: Readonly<Record<string, ItemDef>> = {
  sword: { id: 'sword', name: 'かたな', kind: '武器', equipBonus: 'atk+8', abilities: ['slash'] },
  axe: { id: 'axe', name: 'おの', kind: '武器', equipBonus: 'atk+3', abilities: ['sweep'] },
  twinblade: {
    id: 'twinblade',
    name: 'にとうりゅう',
    kind: '武器',
    abilities: ['slash', 'guard', 'sweep'],
  },
  plate: {
    id: 'plate',
    name: 'ひのよろい',
    kind: '鎧',
    equipBonus: 'def+5, hp+20',
    elements: ['fire'],
  },
  robe: { id: 'robe', name: 'みずのふく', kind: '防具', equipBonus: 'def+1', elements: ['water'] },
  robe2: { id: 'robe2', name: 'みずのふく2', kind: '防具', elements: ['water'] },
  shield: { id: 'shield', name: 'たて', kind: '盾', equipBonus: 'def+3' },
  helm: { id: 'helm', name: 'かぶと', kind: '兜', equipBonus: 'def+2, agi-1' },
  cursed: {
    id: 'cursed',
    name: 'のろいの刀',
    kind: '武器',
    equipBonus: 'hp-1000000, atk-1000000, def+99999999, mp+5',
    abilities: ['big'],
  },
  cracked: {
    id: 'cracked',
    name: 'こわれた刀',
    kind: '武器',
    equipBonus: 'xx+3, atk+, hp+1.5, def+2',
    abilities: ['broken', 'ghost'],
  },
  potion: { id: 'potion', name: 'くすり', kind: '回復', equipBonus: 'atk+100' },
  restricted: {
    id: 'restricted',
    name: 'せんようの刀',
    kind: '武器',
    equipBonus: 'atk+50',
    equippableBy: ['zzz'],
    abilities: ['slash'],
  },
}

/** 装備品のわざの中身（特技 id → 実行内容）。単体・全体・自分・味方・連続・極大・不正な書式・演出のみ。`ghost` は宣言しない（出ない） */
export const EQUIPMENT_ABILITIES: Readonly<Record<string, SkillExecution>> = {
  slash: { name: 'きりさく', target: '相手単体', effect: 'damage 20..30' },
  sweep: {
    name: 'なぎはらい',
    target: '相手全体',
    effect: 'damage 10..15 type=fire 回数=2',
  },
  guard: { name: 'みがまえ', target: '自分', effect: 'buff def=+5 duration=3' },
  heal: { name: 'いやし', target: '仲間単体', effect: 'heal 30..40' },
  big: { name: 'おおぶり', target: '相手全体', effect: 'damage 100000..100000' },
  broken: { name: 'こわれた技', target: '相手単体', effect: 'foo bar' },
}

/**
 * 装備の組み合わせ（装備する id・枠の種類・魔石）。枠超過・種別違い・`装備可` 違反・宣言なし・重複・層の超過・枠なしを含む。
 * `layers` は魔石と防具の属性の層（合計 2 まで）、わざは武器の宣言から導く
 */
const EQUIPMENT_LOADOUTS: ReadonlyArray<{
  name: string
  ids: string[]
  slots?: string[]
  stones?: string[]
}> = [
  { name: 'none', ids: [] },
  { name: 'sword', ids: ['sword'] },
  { name: 'sword+plate', ids: ['sword', 'plate'] },
  { name: 'full', ids: ['sword', 'plate', 'shield', 'helm'] },
  { name: 'two-weapons-one-slot', ids: ['sword', 'axe'] },
  { name: 'two-weapons-two-slots', ids: ['sword', 'axe'], slots: ['武器', '武器'] },
  { name: 'many-abilities', ids: ['twinblade'] },
  { name: 'armor-absorb', ids: ['robe', 'robe2'], slots: ['防具', '防具'] },
  { name: 'armor-layers-over', ids: ['plate', 'robe', 'robe2'], slots: ['防具', '防具', '防具'] },
  { name: 'stone+armor', ids: ['robe'], stones: ['fire'] },
  { name: 'stone-twin+armor', ids: ['robe'], stones: ['twin'] },
  { name: 'cursed', ids: ['cursed'] },
  { name: 'broken', ids: ['cracked'] },
  { name: 'not-equippable', ids: ['potion'] },
  { name: 'restricted', ids: ['restricted'] },
  { name: 'unknown', ids: ['nothing'] },
  { name: 'duplicate', ids: ['sword', 'sword'] },
  { name: 'no-weapon-slot', ids: ['sword', 'plate'], slots: ['防具'] },
  { name: 'no-slots', ids: ['sword', 'plate'], slots: [] },
  { name: 'stone-only', ids: [], stones: ['water'] },
]

/**
 * 装備 (#207): 装備の組み合わせ（`EQUIPMENT_LOADOUTS`。実際の `resolveMemberEquipment` で味方 a を組み立て、武器のわざを導く）×
 * 敵の相性（水属性の特技を使う敵に対する防具の耐性）× 敵の HP × 操作の並び（わざの連打・攻撃のあとにわざ）× ターン制/ATB。決着まで進める。
 * 魔石は `MAGICITE_SET` を使う（属性の層の合計 2 まで・装備品と魔石で共通の枠の検査）
 */
export function equipmentScenarios(): Scenario[] {
  const out: Scenario[] = []
  const tick: Op = { t: 'tick', ms: 3000 }
  const affinities: ReadonlyArray<{ name: string; over: Partial<BattleEntity> }> = [
    { name: 'plain', over: {} },
    { name: 'weak-fire', over: { affinity: { weak: ['fire'] } } },
    { name: 'absorb-fire', over: { affinity: { absorb: ['fire'] } } },
  ]
  for (const atb of [false, true]) {
    for (const lo of EQUIPMENT_LOADOUTS) {
      const member = entity('a', { hp: 300, maxHp: 300, mp: 50, maxMp: 50 })
      const eq = resolveMemberEquipment(
        {
          id: 'a',
          magicites: lo.stones,
          equipment: lo.ids,
          ...(lo.slots ? { equipmentSlots: lo.slots } : {}),
        },
        { magicites: { ...MAGICITE_SET }, items: { ...EQUIPMENT_SET } }
      )
      applyMemberMagicite(member, eq)
      const abilities = eq.abilities.flatMap((id) =>
        Object.prototype.hasOwnProperty.call(EQUIPMENT_ABILITIES, id)
          ? [EQUIPMENT_ABILITIES[id]]
          : []
      )
      for (const ev of affinities) {
        for (const hv of [30, 900]) {
          for (const [opName, ops] of [
            [
              'ability-spam',
              [
                { t: 'ability', k: 0 },
                tick,
                { t: 'ability', k: 1 },
                tick,
                { t: 'ability', k: 0 },
                tick,
                ATK,
              ],
            ],
            ['attack-first', [ATK, tick, { t: 'ability', k: 0 }, tick, { t: 'ability', k: 2 }]],
          ] as const) {
            out.push({
              id: `equipment/${atb ? 'atb' : 'turn'}/${lo.name}/${ev.name}/hp${hv}/${opName}`,
              seed: 90_000 + out.length,
              party: [{ ...member }, entity('b', { hp: 300, maxHp: 300, mp: 50, maxMp: 50 })],
              enemies: [
                foe('s', { ...ev.over, hp: hv, maxHp: hv, actions: ['候補=wave'], agi: 9 }),
                foe('t', { hp: 500, maxHp: 500 }),
              ],
              atb: atb ? { mode: 'active' } : undefined,
              skills: {
                wave: { name: 'なみ', target: '相手全体', effect: 'damage 40..40 type=water' },
              },
              spells: [],
              items: [],
              abilities: abilities.map((a) => ({ ...a })),
              ops: [...ops],
            })
          }
        }
      }
    }
  }
  return out
}

/** 召喚獣の演出 (#750) の変種。演出なし（対照）・名前だけ・絵と効果音と想像の層・左向きの絵 */
const SUMMON_CUES: ReadonlyArray<{ name: string; cue?: SummonCue }> = [
  { name: 'no-cue' },
  { name: 'name-only', cue: { id: 'b1', name: '名札だけ' } },
  {
    name: 'full',
    cue: { id: 'b2', name: 'みなも', image: 'summons/b2.webp', se: 'se/b2.ogg', imaginary: true },
  },
  {
    name: 'faces-left',
    cue: { id: 'b3', name: 'ひだり', image: 'summons/b3.webp', faces: 'left' },
  },
]

/** 召喚獣を呼んだときの効果。ダメージ・回復・演出だけ（効果なし）・不正な書式 */
const SUMMON_BODIES: ReadonlyArray<{ name: string; target: string; effect?: string }> = [
  { name: 'damage', target: '相手全体', effect: 'damage 60..60 type=water' },
  { name: 'heal', target: '仲間全体', effect: 'heal 80..80' },
  { name: 'cue-only', target: '自分' },
  { name: 'broken', target: '相手単体', effect: 'foo bar' },
]

/**
 * 召喚獣の演出 (#750): 演出（なし・名前だけ・絵つき・左向き）× 呼び方（味方の召喚 / 味方のわざ。敵は召喚獣を呼ばない）× 効果 × 敵の HP × ターン制/ATB。
 * 演出つきの行動の記録に `summon` が付くこと（宣言した id だけ・`skill` のイベントだけ）、演出を宣言しないシナリオ（対照）と、
 * 他の全ての族のイベントに `summon` が付かないこと（旧挙動不変）を `summon-invariant` で見る。召喚は 1 バトル 1 回の制限も従来どおり（`magicite-invariant`）
 */
export function summonScenarios(): Scenario[] {
  const out: Scenario[] = []
  const tick: Op = { t: 'tick', ms: 3000 }
  for (const atb of [false, true]) {
    for (const cv of SUMMON_CUES) {
      for (const how of ['summon', 'ability'] as const) {
        for (const body of SUMMON_BODIES) {
          for (const hv of [30, 900]) {
            const exec = {
              name: cv.cue?.name ?? 'こうか',
              target: body.target,
              ...(body.effect !== undefined ? { effect: body.effect } : {}),
              ...(cv.cue ? { cue: cv.cue } : {}),
            }
            const ops: Op[] =
              how === 'summon'
                ? [{ t: 'summon', m: 0 }, tick, { t: 'summon', m: 0 }, tick, ATK]
                : [{ t: 'ability', k: 0 }, tick, { t: 'ability', k: 0 }, tick, ATK]
            out.push({
              id: `summon/${atb ? 'atb' : 'turn'}/${cv.name}/${how}/${body.name}/hp${hv}`,
              seed: 110_000 + out.length,
              party: [
                entity('a', { hp: 300, maxHp: 300, mp: 50, maxMp: 50 }),
                entity('b', { hp: 300, maxHp: 300, mp: 50, maxMp: 50 }),
              ],
              enemies: [foe('s', { hp: hv, maxHp: hv, agi: 9 }), foe('t', { hp: 500, maxHp: 500 })],
              atb: atb ? { mode: 'active' } : undefined,
              spells: [],
              items: [],
              ...(how === 'summon' ? { summons: [{ ...exec, mp: 0 }] } : {}),
              ...(how === 'ability' ? { abilities: [{ ...exec }] } : {}),
              ops,
            })
          }
        }
      }
    }
  }
  return out
}

/** ジョブ (#740) の宣言の集合。能力値のボーナス・属性防御（1 つ・2 つ）・極端なボーナス・不正なボーナスの書式・何もしないジョブを含む */
export const JOB_SET: Readonly<Record<string, JobDef>> = {
  nurse: { id: 'nurse', name: '看護師', equipBonus: 'def+3, hp+20' },
  diver: { id: 'diver', name: '海女', equipBonus: 'agi+2', elements: ['water'] },
  twin: { id: 'twin', name: '氷炎使い', elements: ['fire', 'ice'] },
  plain: { id: 'plain', name: '無職' },
  cursed: {
    id: 'cursed',
    name: 'のろわれ',
    equipBonus: 'hp-1000000, atk-1000000, def+99999999, mp+5',
  },
  cracked: { id: 'cracked', name: 'こわれた', equipBonus: 'xx+3, atk+, hp+1.5, def+2' },
}

/**
 * ジョブの組み合わせ（就けるジョブ・現在のジョブ・装備・魔石）。ジョブ無し・先頭が既定・転職後・`''`（ジョブ無し）・宣言なし・就けないジョブ・
 * 層の超過（ジョブの層が先に捨てられる）・同属性で吸収を含む。`current` を省くと先頭のジョブ
 */
const JOB_LOADOUTS: ReadonlyArray<{
  name: string
  jobs?: string[]
  current?: string
  ids?: string[]
  stones?: string[]
}> = [
  { name: 'none' },
  { name: 'first', jobs: ['nurse', 'diver', 'twin'] },
  { name: 'changed', jobs: ['nurse', 'diver', 'twin'], current: 'diver' },
  { name: 'no-job', jobs: ['nurse', 'diver'], current: '' },
  { name: 'plain', jobs: ['plain'] },
  { name: 'unknown', jobs: ['nothing'] },
  { name: 'not-candidate', jobs: ['nurse'], current: 'diver' },
  { name: 'no-candidates', current: 'nurse' },
  { name: 'cursed', jobs: ['cursed'] },
  { name: 'broken', jobs: ['cracked'] },
  { name: 'twin', jobs: ['twin'] },
  { name: 'job+armor-absorb', jobs: ['diver'], ids: ['robe'] },
  { name: 'job+armor-over', jobs: ['twin'], ids: ['plate'] },
  { name: 'job+stone-over', jobs: ['twin'], stones: ['twin'] },
  { name: 'job+stone+armor', jobs: ['diver'], ids: ['robe'], stones: ['fire'] },
]

/**
 * ジョブ (#740): ジョブの組み合わせ（`JOB_LOADOUTS`。実際の `resolveMemberEquipment` で味方 a を組み立てる。装備品は `EQUIPMENT_SET`、魔石は `MAGICITE_SET`）×
 * 敵の相性（水属性の特技を使う敵に対するジョブの耐性）× 敵の HP × 操作の並び（攻撃の連打・攻撃のあとに逃走）× ターン制/ATB。決着まで進める。
 * ジョブはコマンドを増やさないので、`abilities` は持たない
 */
export function jobScenarios(): Scenario[] {
  const out: Scenario[] = []
  const tick: Op = { t: 'tick', ms: 3000 }
  const affinities: ReadonlyArray<{ name: string; over: Partial<BattleEntity> }> = [
    { name: 'plain', over: {} },
    { name: 'weak-fire', over: { affinity: { weak: ['fire'] } } },
    { name: 'absorb-fire', over: { affinity: { absorb: ['fire'] } } },
  ]
  for (const atb of [false, true]) {
    for (const lo of JOB_LOADOUTS) {
      const member = entity('a', { hp: 300, maxHp: 300, mp: 50, maxMp: 50 })
      const eq = resolveMemberEquipment(
        {
          id: 'a',
          ...(lo.stones ? { magicites: lo.stones } : {}),
          ...(lo.ids ? { equipment: lo.ids } : {}),
          ...(lo.jobs ? { jobs: lo.jobs } : {}),
        },
        {
          magicites: { ...MAGICITE_SET },
          items: { ...EQUIPMENT_SET },
          jobs: { ...JOB_SET },
          ...(lo.current !== undefined ? { currentJobs: { a: lo.current } } : {}),
        }
      )
      applyMemberMagicite(member, eq)
      for (const ev of affinities) {
        for (const hv of [30, 900]) {
          for (const [opName, ops] of [
            ['attack-spam', [ATK, tick, ATK, tick, ATK]],
            ['attack-then-escape', [ATK, tick, { t: 'escape' }, tick, ATK]],
          ] as const) {
            out.push({
              id: `job/${atb ? 'atb' : 'turn'}/${lo.name}/${ev.name}/hp${hv}/${opName}`,
              seed: 95_000 + out.length,
              party: [{ ...member }, entity('b', { hp: 300, maxHp: 300, mp: 50, maxMp: 50 })],
              enemies: [
                foe('s', { ...ev.over, hp: hv, maxHp: hv, actions: ['候補=wave'], agi: 9 }),
                foe('t', { hp: 500, maxHp: 500 }),
              ],
              atb: atb ? { mode: 'active' } : undefined,
              skills: {
                wave: { name: 'なみ', target: '相手全体', effect: 'damage 40..40 type=water' },
              },
              spells: [],
              items: [],
              ops: [...ops],
            })
          }
        }
      }
    }
  }
  return out
}
