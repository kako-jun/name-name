/**
 * 検証ハーネスの脚本制御の戦闘の族 (#741 / #863)。勝敗固定・途中参戦・復活・逃走・「にげる」禁止を、
 * 戦闘方式（ターン制 / ATB）・強さ・敵や味方が撃つ効果の総当たり・ランダム合成で動かし、
 * **必ず決着すること・固定した結果で終わること・ターン上限を守ること・脚本の状態が整合していること**を見る。
 * 壊れの判定は `run.ts` の `scriptExpect` と `detect.ts` の `script-*`。
 */
import type { StatusDef } from '../../types'
import type { BattleEntity } from '../spellDsl'
import { entity } from './generate'
import { lcg } from './rng'
import type { Op, Scenario } from './scenario'

type Mode = 'turn' | 'atb-wait' | 'atb-active'
const MODES: readonly Mode[] = ['turn', 'atb-wait', 'atb-active']
const atbOf = (m: Mode): Scenario['atb'] =>
  m === 'turn' ? undefined : { mode: m === 'atb-wait' ? 'wait' : 'active' }

const foe = (id: string, over: Partial<BattleEntity> = {}): BattleEntity =>
  entity(id, { mp: 0, maxMp: 0, exp: 7, gold: 3, ...over })

/** 強さの組（味方・敵の HP と攻撃）。0 攻撃の組は「どちらも相手を倒せない」膠着の素 */
const STRENGTHS: ReadonlyArray<{
  name: string
  party: Partial<BattleEntity>
  enemy: Partial<BattleEntity>
}> = [
  {
    name: 'party-weak',
    party: { hp: 1, maxHp: 1, atk: 0 },
    enemy: { hp: 1_000_000_000, maxHp: 1_000_000_000, atk: 99_999 },
  },
  {
    name: 'party-strong',
    party: { hp: 5000, maxHp: 5000, atk: 99_999 },
    enemy: { hp: 1, maxHp: 1, atk: 0 },
  },
  { name: 'even', party: { hp: 30, maxHp: 30, atk: 8 }, enemy: { hp: 40, maxHp: 40, atk: 8 } },
  {
    name: 'zero-atk',
    party: { hp: 100, maxHp: 100, atk: 0 },
    enemy: { hp: 100, maxHp: 100, atk: 0 },
  },
]

const FIXED: ReadonlyArray<{ word: string; ends: string[] }> = [
  { word: '勝利', ends: ['victory'] },
  { word: '敗北', ends: ['defeat'] },
  { word: '中断', ends: ['interrupted'] },
]
const CAPS: ReadonlyArray<number | undefined> = [1, 3, undefined]
/** `固定` の上限ターンの既定（`battleScript.ts` の SCRIPT_DEFAULT_MAX_TURNS と同じ） */
const DEFAULT_CAP = 99

const DOOM: Record<string, StatusDef> = {
  doom: { id: 'doom', name: '死の宣告', duration: '1', expire: '戦闘不能' },
}

/** 固定した結果を壊そうとする効果（床をすり抜ける経路の洗い出し）。動詞ごとに「HP を 0 にする」向きのもの */
export const BREAKING_EFFECTS: readonly string[] = [
  'damage 9999..9999',
  'damage_full',
  'heal -9999..-9999',
  'status doom duration=1',
  'damage 3 回数=9',
]

/** 勝敗固定 × 上限ターン × 戦闘方式 × 強さ。決着し、固定した結果で、上限ターン以内に終わる */
function fixedMatrix(): Scenario[] {
  const out: Scenario[] = []
  for (const fx of FIXED) {
    for (const cap of CAPS) {
      for (const mode of MODES) {
        for (const st of STRENGTHS) {
          const rule = `固定: 結果=${fx.word}${cap !== undefined ? ` 上限ターン=${cap}` : ''}`
          out.push({
            id: `script/fixed/${fx.word}/cap${cap ?? 'default'}/${mode}/${st.name}`,
            seed: 91_000 + out.length,
            party: [entity('hero', st.party)],
            enemies: [foe('boss', st.enemy)],
            atb: atbOf(mode),
            spells: [],
            items: [],
            ops: [],
            script: { id: 'fx', rules: [rule] },
            scriptExpect: {
              // 自然に決着する組み合わせでも、固定した結果の側にしか終われない（固定が相手側の勝利を封じる）。
              // ただし「勝利固定で味方が全滅」「敗北固定で敵が全滅」は床が封じる。中断固定は両方封じる。
              ends: fx.ends,
              maxTurn: cap ?? DEFAULT_CAP,
            },
          })
        }
      }
    }
  }
  return out
}

/** 固定した結果を壊そうとする効果 × 撃つ側 × 固定 × 戦闘方式。床をすり抜けて期待外の終わり方にならない */
function breakingMatrix(): Scenario[] {
  const out: Scenario[] = []
  const casters = ['party->enemy', 'party->party', 'enemy->party'] as const
  for (const [ei, effect] of BREAKING_EFFECTS.entries()) {
    for (const caster of casters) {
      for (const fx of FIXED) {
        for (const mode of ['turn', 'atb-active'] as const) {
          const spell =
            caster === 'party->party'
              ? { name: 'x', mp: 0, target: '味方全体', effect }
              : { name: 'x', mp: 0, target: '敵全体', effect }
          const ops: Op[] = []
          for (let i = 0; i < 3; i++) {
            if (caster !== 'enemy->party') ops.push({ t: 'spell', s: 0 })
            if (mode !== 'turn') ops.push({ t: 'tick', ms: 4000 })
          }
          out.push({
            id: `script/breaking/e${ei}/${caster}/${fx.word}/${mode}`,
            seed: 92_000 + out.length,
            party: [
              entity('hero', { hp: 400, maxHp: 400, atk: 20 }),
              entity('ally', { hp: 400, maxHp: 400, atk: 20 }),
            ],
            enemies: [
              foe('boss', {
                hp: 400,
                maxHp: 400,
                atk: 20,
                ...(caster === 'enemy->party' ? { actions: ['候補=x'] } : {}),
              }),
              foe('imp', { hp: 400, maxHp: 400, atk: 20 }),
            ],
            atb: atbOf(mode),
            skills:
              caster === 'enemy->party'
                ? { x: { name: 'x', target: '相手全体', effect } }
                : undefined,
            statuses: DOOM,
            spells: [spell],
            items: [],
            ops,
            script: { id: 'br', rules: [`固定: 結果=${fx.word} 上限ターン=8`] },
            scriptExpect: { ends: fx.ends, maxTurn: 8 },
          })
        }
      }
    }
  }
  return out
}

const END_CAP = '終了: 条件=ターン>=30 結果=中断'
const ANY_END = ['victory', 'defeat', 'interrupted']

/** 途中参戦: 参戦できる味方・いない id・すでにいる id × 戦闘方式 × 主人公の下限の有無 */
function joinMatrix(): Scenario[] {
  const out: Scenario[] = []
  const targets = [
    { name: 'joiner', target: 'ally' },
    { name: 'unknown', target: 'ghost' },
    { name: 'already', target: 'hero' },
  ]
  for (const t of targets) {
    for (const mode of MODES) {
      for (const floor of [true, false]) {
        out.push({
          id: `script/join/${t.name}/${mode}/${floor ? 'floor' : 'nofloor'}`,
          seed: 93_000 + out.length,
          party: [entity('hero', { hp: 12, maxHp: 12, atk: 5, agi: 10 })],
          enemies: [foe('boss', { hp: 500, maxHp: 500, atk: 9, agi: 10 })],
          atb: atbOf(mode),
          spells: [],
          items: [],
          ops: [],
          script: {
            id: 'jn',
            rules: [
              ...(floor ? ['下限: 対象=hero HP=1 条件=!参戦[ally]'] : []),
              `参戦: 条件=HP[hero]<=1 対象=${t.target} 文=とびこんできた`,
              '台詞: 条件=参戦[ally] 話者=ally 文=たすけにきた',
              END_CAP,
            ],
            joiners: { ally: entity('ally', { hp: 40, maxHp: 40, atk: 7, agi: 10 }) },
          },
          scriptExpect: { ends: ANY_END, maxTurn: 30 },
        })
      }
    }
  }
  return out
}

/** HP0 からの復活: 復活の HP 指定 × 戦闘方式 × 味方の人数（1 人 = 全滅の瞬間に復活） */
function reviveMatrix(): Scenario[] {
  const out: Scenario[] = []
  for (const hp of ['100%', '1', '0%', '50%', '999999']) {
    for (const mode of MODES) {
      for (const size of [1, 2]) {
        const party = [entity('hero', { hp: 1, maxHp: 20, atk: 5, agi: 10 })]
        if (size === 2) party.push(entity('ally', { hp: 1, maxHp: 20, atk: 5, agi: 10 }))
        out.push({
          id: `script/revive/hp${hp}/${mode}/party${size}`,
          seed: 94_000 + out.length,
          party,
          enemies: [foe('boss', { hp: 500, maxHp: 500, atk: 50, agi: 10 })],
          atb: atbOf(mode),
          spells: [],
          items: [],
          ops: [],
          script: {
            id: 'rv',
            rules: ['復活: 条件=倒れた[hero] 対象=hero HP=' + hp + ' 文=もえあがる', END_CAP],
          },
          scriptExpect: { ends: ANY_END, maxTurn: 30 },
        })
      }
    }
  }
  return out
}

/** 逃げるイベントバトル: 倒せない敵（下限）と盾役 × 戦闘方式 × 味方の強さ。盾役が倒れると逃げて勝利。倒せなければ上限で中断 */
function fleeMatrix(): Scenario[] {
  const out: Scenario[] = []
  for (const mode of MODES) {
    for (const strong of [true, false]) {
      out.push({
        id: `script/flee/${mode}/${strong ? 'strong' : 'weak'}`,
        seed: 95_000 + out.length,
        party: [entity('hero', { hp: 5000, maxHp: 5000, atk: strong ? 99_999 : 0, agi: 10 })],
        enemies: [
          // 弱い味方（攻撃 0 でも通常攻撃は最低 1 ダメージ）では上限ターンまでに倒せない HP にする
          foe(
            'guard',
            strong
              ? { hp: 30, maxHp: 30, atk: 1, agi: 5 }
              : { hp: 100_000, maxHp: 100_000, atk: 1, agi: 5 }
          ),
          foe('cell', { hp: 3, maxHp: 3, atk: 0, agi: 5, exp: 100, gold: 100 }),
        ],
        atb: atbOf(mode),
        spells: [],
        items: [],
        ops: [],
        script: {
          id: 'fl',
          rules: ['下限: 対象=cell HP=1', '逃走: 条件=倒れた[guard] 対象=cell', END_CAP],
        },
        scriptExpect: { ends: strong ? ['victory'] : ['interrupted'], maxTurn: 30 },
      })
    }
  }
  return out
}

/** 「にげる」禁止: 逃走を連打しても進行を止めず、上限ターンの終了で決着する */
function noEscapeMatrix(): Scenario[] {
  const out: Scenario[] = []
  for (const mode of MODES) {
    const ops: Op[] = []
    for (let i = 0; i < 6; i++) ops.push({ t: 'escape' })
    out.push({
      id: `script/no-escape/${mode}`,
      seed: 96_000 + out.length,
      party: [entity('hero', { hp: 9999, maxHp: 9999, atk: 0 })],
      enemies: [foe('boss', { hp: 9999, maxHp: 9999, atk: 0 })],
      atb: atbOf(mode),
      spells: [],
      items: [],
      ops,
      script: { id: 'ne', rules: ['にげる: 不可', END_CAP] },
      scriptExpect: { ends: ['interrupted'], maxTurn: 30 },
    })
  }
  return out
}

/** 脚本制御の戦闘の総当たり。ランダム合成 `randomScriptScenarios` は別（件数を変えられる） */
export function scriptMatrix(): Scenario[] {
  return [
    ...fixedMatrix(),
    ...breakingMatrix(),
    ...joinMatrix(),
    ...reviveMatrix(),
    ...fleeMatrix(),
    ...noEscapeMatrix(),
  ]
}

// ---------------------------------------------------------------------------
// ランダム合成
// ---------------------------------------------------------------------------

const RANDOM_RULE_POOL: readonly string[] = [
  '台詞: 条件=開始 話者=boss 文=ふふ',
  '台詞: 条件=ターン>=2 文=ゆれた',
  '台詞: 条件=HP[boss]<=50% 話者=boss 文=ぐ',
  '台詞: 条件=HP[hero]<=1 文=あぶない',
  '参戦: 条件=HP[hero]<=3 対象=ally',
  '参戦: 条件=ターン>=3 対象=ally2',
  '復活: 条件=倒れた[hero] 対象=hero HP=50%',
  '復活: 条件=倒れた[ally] 対象=ally HP=1',
  '下限: 対象=hero HP=1',
  '下限: 対象=味方全員 HP=2 条件=ターン<4',
  '下限: 対象=boss HP=1 条件=!倒れた[imp]',
  '下限: 対象=敵全員 HP=3',
  '逃走: 条件=倒れた[imp] 対象=boss',
  '逃走: 条件=ターン>=5 対象=imp',
  '終了: 条件=ターン>=6 結果=中断',
  '終了: 条件=HP[boss]<=10% 結果=勝利',
  '終了: 条件=味方数<=0 結果=敗北',
  'にげる: 不可',
  '固定: 結果=勝利 上限ターン=7',
  '固定: 結果=敗北 上限ターン=7',
  '固定: 結果=中断 上限ターン=4',
  '勝利時: フラグ=w=true 次=ev',
  '中断時: フラグ=c="x"',
  // 壊れた行（無視されて、ほかの行は生きる）
  '台詞: 条件=あやしい 文=x',
  '復活: 対象=hero HP=abc',
  '終了: 結果=ひきわけ',
  '未知: 文=x',
]

/**
 * seed 固定のランダム合成。ルールを 1〜5 個選び、**必ず終了条件（上限ターンの終了か固定）を 1 つ足す**ので、どの組み合わせでも決着する（壊れていなければ）。
 * 期待は「どれかで終わる」（個別の固定の食い合いは期待にしない）。脚本の状態の整合・床・ターン上限・ロックは検出器が見る
 */
export function randomScriptScenarios(seed: number, count: number): Scenario[] {
  const rnd = lcg(seed)
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)]
  const out: Scenario[] = []
  for (let i = 0; i < count; i++) {
    const n = 1 + Math.floor(rnd() * 5)
    const rules: string[] = []
    for (let k = 0; k < n; k++) rules.push(pick(RANDOM_RULE_POOL))
    rules.push('終了: 条件=ターン>=12 結果=中断')
    const mode = pick(MODES)
    const ops: Op[] = []
    const opCount = Math.floor(rnd() * 5)
    for (let k = 0; k < opCount; k++) {
      ops.push(pick<Op>([{ t: 'attack' }, { t: 'escape' }, { t: 'tick', ms: 3000 }]))
    }
    const effect = pick([...BREAKING_EFFECTS, 'heal 50..80', 'damage 5..9'])
    out.push({
      id: `random-script/${i}`,
      seed: seed * 1000 + i,
      party: [
        entity('hero', {
          hp: pick([1, 5, 30, 400]),
          maxHp: pick([30, 400]),
          atk: pick([0, 8, 99]),
        }),
      ].map((e) => ({ ...e, hp: Math.min(e.hp, e.maxHp) })),
      enemies: [
        foe('boss', {
          hp: pick([1, 40, 5000]),
          maxHp: 5000,
          atk: pick([0, 9, 999]),
          actions: rnd() < 0.3 ? ['候補=x'] : undefined,
        }),
        foe('imp', { hp: pick([1, 10]), maxHp: 10, atk: pick([0, 5]) }),
      ].map((e) => {
        const { actions, ...rest } = e
        return { ...rest, hp: Math.min(e.hp, e.maxHp), ...(actions ? { actions } : {}) }
      }),
      atb: atbOf(mode),
      skills: { x: { name: 'x', target: '相手全体', effect } },
      statuses: DOOM,
      spells: [{ name: 's', mp: 0, target: rnd() < 0.5 ? '敵全体' : '味方全体', effect }],
      items: [],
      ops,
      script: {
        id: `rs${i}`,
        rules,
        joiners: {
          ally: entity('ally', { hp: 30, maxHp: 30, atk: 6 }),
          ally2: entity('ally2', { hp: 1, maxHp: 30, atk: 6 }),
        },
      },
      scriptExpect: { ends: ['victory', 'defeat', 'interrupted', 'escaped'], maxTurn: 12 },
    })
  }
  return out
}
