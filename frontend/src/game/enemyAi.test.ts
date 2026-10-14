/** 敵の行動パターン P1 (#835): `行動:` の解釈と chooseEnemyAction（純粋関数・rng 注入の決定論テスト） */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BattleState } from './battleEngine'
import type { BattleEntity } from './spellDsl'
import {
  chooseEnemyAction,
  createEnemyMemory,
  parseActionRule,
  parseActionRules,
  recordEnemyAction,
  toSkillExecutions,
} from './enemyAi'

function ent(over: Partial<BattleEntity> = {}): BattleEntity {
  return {
    id: 'e',
    name: 'E',
    hp: 100,
    maxHp: 100,
    mp: 0,
    maxMp: 0,
    atk: 8,
    def: 0,
    agi: 2,
    ...over,
  }
}

/** 呼ばれた回数を数える rng（固定値の列。尽きたら最後の値） */
function countingRng(...vals: number[]): { rng: () => number; calls: () => number } {
  let i = 0
  return {
    rng: () => vals[Math.min(i++, vals.length - 1)] ?? 0,
    calls: () => i,
  }
}

function stateOf(
  enemies: BattleEntity[],
  party: BattleEntity[] = [ent({ id: 'hero' })],
  acted: number[] = enemies.map(() => 0)
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
    enemyMemory: enemies.map((_, i) => ({ acted: acted[i] ?? 0 })),
  }
}

afterEach(() => vi.restoreAllMocks())

describe('parseActionRule: 書式の解釈', () => {
  it('条件・候補・重み・対象を読む。候補の重みを省くと 1。条件の区切りは , のあとにスペースがあってよい', () => {
    const r = parseActionRule('条件=仲間<=0, HP<50% 候補=火の息:3 | こうげき 対象=ランダム')
    expect(r).toEqual({
      conditions: [
        { kind: 'allies', op: '<=', n: 0 },
        { kind: 'hp', op: '<', percent: 50 },
      ],
      candidates: [
        { skillId: '火の息', weight: 3 },
        { skillId: null, weight: 1 },
      ],
      target: 'random',
    })
  })

  it('条件の省略 / 常に は常に成立。attack も通常攻撃。キーの順序は問わない', () => {
    expect(parseActionRule('候補=attack')).toEqual({
      conditions: [],
      candidates: [{ skillId: null, weight: 1 }],
    })
    expect(parseActionRule('候補=墨 条件=常に')).toEqual({
      conditions: [{ kind: 'always' }],
      candidates: [{ skillId: '墨', weight: 1 }],
    })
  })

  it.each([
    ['', 'キーが無い'],
    ['でたらめ', 'キーが無い'],
    ['余計 候補=墨', 'キーの前の文字'],
    ['条件=初手', '候補が無い'],
    ['候補=', '候補が空'],
    ['候補=墨 | ', '空の候補'],
    ['候補=墨:abc', '重みが数でない'],
    ['候補=墨:-1', '重みが負'],
    ['候補=墨:0', '重みの合計が 0'],
    ['候補=墨:0 | 触手:0', '重みの合計が 0'],
    ['条件=雨 候補=墨', '未知の条件'],
    ['候補=墨 ほげ=1', '未知のキーが候補に連結された'],
    ['条件=HP<abc% 候補=墨', 'HP の値が不正'],
    ['条件=HP<50 候補=墨', 'HP に % が無い'],
    ['条件=初手 条件=初手 候補=墨', 'キー重複'],
    ['候補=墨 対象=最後に攻撃した者', 'P3 の対象'],
    ['候補=墨 対象=誰か', '未知の対象'],
    ['候補=墨 予兆=', '予兆が空'],
    ['候補=墨 上限=0', '上限が 0'],
    ['候補=墨 上限=x', '上限が数でない'],
    ['候補=墨 順番=墨 > 触手', '候補と順番の併記'],
    ['順番=墨 > ', '順番に空の要素'],
    ['順番=墨:2 > 触手', '順番に重み'],
    ['条件=周期=0 候補=墨', '周期 N=0'],
    ['条件=周期=3/3 候補=墨', '周期の余りが N 以上'],
    ['条件=状態= 候補=墨', '状態名が空'],
  ])('不正な行 %j（%s）は理由の文字列を返す', (line) => {
    expect(typeof parseActionRule(line)).toBe('string')
  })

  it('parseActionRules は不正な行を warning つきで除き、残りの順序を保つ。同じ配列には 1 度しか警告しない', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const lines = ['条件=初手 候補=墨', 'でたらめ', '候補=こうげき:2 | 墨:1']
    const rules = parseActionRules(lines)
    expect(rules).toHaveLength(2)
    expect(rules[0].candidates[0].skillId).toBe('墨')
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0][0])).toContain('でたらめ')
    parseActionRules(lines)
    expect(warn).toHaveBeenCalledTimes(1)
  })
})

describe('chooseEnemyAction: 行動を書かない敵は不変', () => {
  it('actions が無い敵 / 空配列の敵は rng を消費せず通常攻撃', () => {
    const { rng, calls } = countingRng(0.5)
    const s = stateOf([ent(), ent({ actions: [] })])
    expect(chooseEnemyAction(s, 0, rng)).toEqual({ kind: 'attack' })
    expect(chooseEnemyAction(s, 1, rng)).toEqual({ kind: 'attack' })
    expect(calls()).toBe(0)
  })

  it('enemyMemory が無い戦闘では actions があっても通常攻撃（rng 不使用）', () => {
    const { rng, calls } = countingRng(0.5)
    const s = stateOf([ent({ actions: ['候補=墨'] })])
    delete s.enemyMemory
    expect(chooseEnemyAction(s, 0, rng)).toEqual({ kind: 'attack' })
    expect(calls()).toBe(0)
  })

  it('createEnemyMemory は actions を持つ敵がいるときだけ作る', () => {
    expect(createEnemyMemory([ent(), ent({ actions: [] })])).toBeUndefined()
    expect(createEnemyMemory([ent(), ent({ actions: ['候補=墨'] })])).toEqual([
      { acted: 0 },
      { acted: 0 },
    ])
  })

  it('どの行も成立しなければ通常攻撃（rng 不使用）', () => {
    const { rng, calls } = countingRng(0.5)
    const s = stateOf([ent({ actions: ['条件=初手 候補=墨'] })], undefined, [1])
    expect(chooseEnemyAction(s, 0, rng)).toEqual({ kind: 'attack' })
    expect(calls()).toBe(0)
  })

  it('chooseEnemyAction は state を変えない（acted も増やさない）', () => {
    const s = stateOf([ent({ actions: ['条件=初手 候補=墨'] })])
    const before = JSON.stringify(s)
    chooseEnemyAction(s, 0, () => 0)
    expect(JSON.stringify(s)).toBe(before)
  })
})

describe('chooseEnemyAction: 評価順と重み付き抽選', () => {
  it('上の行から評価し、最初に成立した行だけを使う（下の行は見ない）', () => {
    const s = stateOf([ent({ actions: ['条件=初手 候補=墨', '候補=触手', '候補=火'] })])
    expect(chooseEnemyAction(s, 0, () => 0)).toEqual({ kind: 'skill', skillId: '墨' })
    s.enemyMemory![0].acted = 1
    expect(chooseEnemyAction(s, 0, () => 0)).toEqual({ kind: 'skill', skillId: '触手' })
  })

  it('不正な行は飛ばして次の行が使われる', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const s = stateOf([ent({ actions: ['でたらめ ??', '候補=触手'] })])
    expect(chooseEnemyAction(s, 0, () => 0)).toEqual({ kind: 'skill', skillId: '触手' })
  })

  it('候補が 1 つなら rng を消費しない', () => {
    const { rng, calls } = countingRng(0.9)
    const s = stateOf([ent({ actions: ['候補=墨'] })])
    chooseEnemyAction(s, 0, rng)
    expect(calls()).toBe(0)
  })

  it('候補が 2 つ以上ならちょうど 1 回消費し、重みの境界で選ぶ（こうげき:1 | 墨:3 | 触手:1 → 境界 0.2 / 0.8）', () => {
    const s = stateOf([ent({ actions: ['候補=こうげき:1 | 墨:3 | 触手:1'] })])
    const pick = (v: number) => {
      const { rng, calls } = countingRng(v)
      const a = chooseEnemyAction(s, 0, rng)
      expect(calls()).toBe(1)
      return a.kind === 'skill' ? a.skillId : 'attack'
    }
    expect(pick(0)).toBe('attack')
    expect(pick(0.1999)).toBe('attack')
    expect(pick(0.2)).toBe('墨')
    expect(pick(0.7999)).toBe('墨')
    expect(pick(0.8)).toBe('触手')
    expect(pick(0.9999)).toBe('触手')
  })

  it('重み 0 の候補は選ばれない。重みを省くと 1。小数の重みも使える', () => {
    const s = stateOf([ent({ actions: ['候補=墨:0 | 触手:0.5 | 火'] })])
    const ids = [0, 0.3, 0.34, 0.99].map((v) => {
      const a = chooseEnemyAction(s, 0, () => v)
      return a.kind === 'skill' ? a.skillId : 'attack'
    })
    // 合計 1.5。触手 [0, 0.5) → 乱数 0〜0.333、火 [0.5, 1.5) → 0.333〜
    expect(ids).toEqual(['触手', '触手', '火', '火'])
  })
})

describe('chooseEnemyAction: 条件の境界', () => {
  const hpLine = (cond: string) => [`条件=${cond} 候補=墨`, '候補=触手']
  const withHp = (hp: number, maxHp: number, cond: string) =>
    chooseEnemyAction(stateOf([ent({ hp, maxHp, actions: hpLine(cond) })]), 0, () => 0)
  const isInk = (a: ReturnType<typeof chooseEnemyAction>) =>
    a.kind === 'skill' && a.skillId === '墨'

  it('HP<50%: 50/100 は不成立、49/100 は成立（境界は割合ちょうどで丸めない）', () => {
    expect(isInk(withHp(50, 100, 'HP<50%'))).toBe(false)
    expect(isInk(withHp(49, 100, 'HP<50%'))).toBe(true)
  })

  it('HP<=50% と HP>=50% と HP>50%', () => {
    expect(isInk(withHp(50, 100, 'HP<=50%'))).toBe(true)
    expect(isInk(withHp(51, 100, 'HP<=50%'))).toBe(false)
    expect(isInk(withHp(50, 100, 'HP>=50%'))).toBe(true)
    expect(isInk(withHp(49, 100, 'HP>=50%'))).toBe(false)
    expect(isInk(withHp(50, 100, 'HP>50%'))).toBe(false)
    expect(isInk(withHp(51, 100, 'HP>50%'))).toBe(true)
  })

  it('割り切れない最大 HP でも整数で比較する（1/3 は 33.3% なので HP<34% は成立・HP<33% は不成立）', () => {
    expect(isInk(withHp(1, 3, 'HP<34%'))).toBe(true)
    expect(isInk(withHp(1, 3, 'HP<33%'))).toBe(false)
    expect(isInk(withHp(1, 3, 'HP=33.3%'))).toBe(false)
  })

  it('初手は acted === 0 のときだけ', () => {
    const s = stateOf([ent({ actions: hpLine('初手') })])
    expect(isInk(chooseEnemyAction(s, 0, () => 0))).toBe(true)
    s.enemyMemory![0].acted = 1
    expect(isInk(chooseEnemyAction(s, 0, () => 0))).toBe(false)
  })

  it('仲間 = 自分以外の生存している敵の数（倒れた仲間は数えない）', () => {
    const actions = hpLine('仲間<=1')
    const mk = (hps: number[]) =>
      stateOf(hps.map((hp, i) => ent({ id: `e${i}`, hp, ...(i === 0 ? { actions } : {}) })))
    expect(isInk(chooseEnemyAction(mk([100, 100, 100]), 0, () => 0))).toBe(false) // 仲間 2
    expect(isInk(chooseEnemyAction(mk([100, 100, 0]), 0, () => 0))).toBe(true) // 仲間 1
    expect(isInk(chooseEnemyAction(mk([100]), 0, () => 0))).toBe(true) // 仲間 0
    const s0 = stateOf([ent({ actions: hpLine('仲間=0') })])
    expect(isInk(chooseEnemyAction(s0, 0, () => 0))).toBe(true)
  })

  it('味方 = 生存しているプレイヤー側の数', () => {
    const e = ent({ actions: hpLine('味方<=1') })
    const party = [ent({ id: 'a' }), ent({ id: 'b' }), ent({ id: 'c' })]
    expect(isInk(chooseEnemyAction(stateOf([e], party), 0, () => 0))).toBe(false)
    party[1].hp = 0
    party[2].hp = 0
    expect(isInk(chooseEnemyAction(stateOf([e], party), 0, () => 0))).toBe(true)
  })

  it('条件は , 区切りの AND（全部成立したときだけ）', () => {
    const e = ent({ hp: 40, actions: hpLine('仲間<=0, HP<50%') })
    const alone = stateOf([e])
    expect(isInk(chooseEnemyAction(alone, 0, () => 0))).toBe(true)
    const withMate = stateOf([e, ent({ id: 'mate' })])
    expect(isInk(chooseEnemyAction(withMate, 0, () => 0))).toBe(false)
  })
})

describe('chooseEnemyAction: 対象=', () => {
  const party = () => [ent({ id: 'a', hp: 30 }), ent({ id: 'b', hp: 10 }), ent({ id: 'c', hp: 20 })]

  it('HP最小は生存者の最小 HP（rng 不使用）。同値は先頭', () => {
    const p = party()
    const { rng, calls } = countingRng(0.9)
    const s = stateOf([ent({ actions: ['候補=墨 対象=HP最小'] })], p)
    expect(chooseEnemyAction(s, 0, rng)).toEqual({
      kind: 'skill',
      skillId: '墨',
      targetOverride: '相手単体',
      target: { side: 'party', index: 1 },
    })
    expect(calls()).toBe(0)
    p[1].hp = 0
    p[0].hp = 20
    expect(chooseEnemyAction(s, 0, rng)).toMatchObject({ target: { side: 'party', index: 0 } })
    p[0].hp = 0
    p[2].hp = 0
    expect(chooseEnemyAction(s, 0, rng)).toEqual({
      kind: 'skill',
      skillId: '墨',
      targetOverride: '相手単体',
    })
  })

  it('ランダムは生存者から rng で選ぶ（抽選のあとに 1 回）。1 人なら消費しない', () => {
    const p = party()
    const s = stateOf([ent({ actions: ['候補=墨 | 触手 対象=ランダム'] })], p)
    // 1 回目 0.0 → 墨、2 回目 0.7 → 3 人中 index 2
    const r1 = countingRng(0, 0.7)
    expect(chooseEnemyAction(s, 0, r1.rng)).toMatchObject({
      skillId: '墨',
      target: { side: 'party', index: 2 },
    })
    expect(r1.calls()).toBe(2)
    p[0].hp = 0
    p[1].hp = 0
    const r2 = countingRng(0, 0.7)
    expect(chooseEnemyAction(s, 0, r2.rng)).toMatchObject({ target: { side: 'party', index: 2 } })
    expect(r2.calls()).toBe(1) // 候補抽選の 1 回だけ（生存者 1 人なら対象の抽選はしない）
  })

  it('全体 / 仲間 / 自分は特技の対象を相対表現で上書きする', () => {
    const run = (t: string) =>
      chooseEnemyAction(stateOf([ent({ actions: [`候補=墨 対象=${t}`] })]), 0, () => 0)
    expect(run('全体')).toEqual({ kind: 'skill', skillId: '墨', targetOverride: '相手全体' })
    expect(run('仲間')).toEqual({ kind: 'skill', skillId: '墨', targetOverride: '仲間単体' })
    expect(run('自分')).toEqual({ kind: 'skill', skillId: '墨', targetOverride: '自分' })
  })

  it('通常攻撃にも ランダム / HP最小 は効き、全体 / 仲間 / 自分 は無視する', () => {
    const p = party()
    const a = chooseEnemyAction(
      stateOf([ent({ actions: ['候補=こうげき 対象=HP最小'] })], p),
      0,
      () => 0
    )
    expect(a).toEqual({ kind: 'attack', target: { side: 'party', index: 1 } })
    const b = chooseEnemyAction(
      stateOf([ent({ actions: ['候補=こうげき 対象=全体'] })], p),
      0,
      () => 0
    )
    expect(b).toEqual({ kind: 'attack' })
  })
})

describe('toSkillExecutions', () => {
  it('SkillDef を id キーのまま SkillExecution にする（予兆 telegraph も渡す。P2 #836）', () => {
    expect(
      toSkillExecutions({
        墨: {
          id: '墨',
          name: '墨',
          target: '相手全体',
          effect: 'damage 6..10',
          message: '{user}は墨',
          telegraph: 'ゴゴゴ',
        },
      })
    ).toEqual({
      墨: {
        name: '墨',
        target: '相手全体',
        effect: 'damage 6..10',
        message: '{user}は墨',
        telegraph: 'ゴゴゴ',
      },
    })
  })
})

// ===== P2 (#836): 順番・予兆・上限・回数・周期・使用・状態 =====

describe('P2 の書式', () => {
  it('順番・予兆・上限・P2 の条件を読む', () => {
    const r = parseActionRule(
      '条件=回数>=2, 周期=3/1, 使用<ink>>=1, 状態=毒, 味方状態=眠り 順番=ink > こうげき > tent 予兆=ゴゴゴ… 上限=4'
    )
    expect(typeof r).not.toBe('string')
    if (typeof r === 'string') return
    expect(r.conditions.map((c) => c.kind)).toEqual(['acted', 'cycle', 'used', 'status', 'status'])
    expect(r.sequence?.map((c) => c.skillId)).toEqual(['ink', null, 'tent'])
    expect(r.candidates).toEqual([])
    expect(r.omen).toBe('ゴゴゴ…')
    expect(r.cap).toBe(4)
  })

  it('周期=N は N/0 と同じ。使用<attack> は通常攻撃の回数', () => {
    const a = parseActionRule('条件=周期=3 候補=ink')
    const b = parseActionRule('条件=周期=3/0 候補=ink')
    expect(a).toEqual(b)
    const u = parseActionRule('条件=使用<attack><2 候補=ink')
    expect(typeof u).not.toBe('string')
    if (typeof u !== 'string')
      expect(u.conditions[0]).toMatchObject({ kind: 'used', key: 'こうげき' })
  })
})

/** chooseEnemyAction の結果で記憶を進める（エンジンの行動後処理と同じ） */
function step(s: BattleState, i: number, rng: () => number) {
  const c = chooseEnemyAction(s, i, rng)
  recordEnemyAction(s.enemyMemory![i], c)
  return c
}

const skillIds = (cs: ReturnType<typeof chooseEnemyAction>[]) =>
  cs.map((c) => (c.kind === 'skill' ? c.skillId : 'attack'))

describe('順番=: 巡回・リセット（決定論）', () => {
  it('順番どおりに巡回し、終端で先頭に戻る。rng は消費しない', () => {
    const s = stateOf([ent({ actions: ['順番=ink > こうげき > tent'] })])
    const r = countingRng(0.9)
    const out = Array.from({ length: 7 }, () => step(s, 0, r.rng))
    expect(skillIds(out)).toEqual(['ink', 'attack', 'tent', 'ink', 'attack', 'tent', 'ink'])
    expect(r.calls()).toBe(0)
    expect(s.enemyMemory![0].acted).toBe(7)
  })

  it('選ばれる行が切り替わると位置は新しい行の先頭に戻る（行 A を 2 回進め、行 B に移り、A に戻ると先頭から）', () => {
    const s = stateOf([ent({ actions: ['条件=HP>=50% 順番=ink > tent > sub', '順番=tent > ink'] })])
    const r = () => 0
    const a1 = step(s, 0, r)
    const a2 = step(s, 0, r)
    s.enemies[0].hp = 10
    const b1 = step(s, 0, r)
    const b2 = step(s, 0, r)
    s.enemies[0].hp = 100
    const a3 = step(s, 0, r) // A に戻る: 位置 2（sub）ではなく先頭 ink
    expect(skillIds([a1, a2, b1, b2, a3])).toEqual(['ink', 'tent', 'tent', 'ink', 'ink'])
    expect(s.enemyMemory![0].rule).toBe(0)
    expect(s.enemyMemory![0].pos).toBe(1)
  })

  it('chooseEnemyAction は純粋: 同じ state から何度呼んでも同じ結果で、記憶を変えない', () => {
    const s = stateOf([ent({ actions: ['順番=ink > tent'] })])
    const before = JSON.stringify(s.enemyMemory)
    const a = chooseEnemyAction(s, 0, () => 0)
    const b = chooseEnemyAction(s, 0, () => 0)
    expect(a).toEqual(b)
    expect(JSON.stringify(s.enemyMemory)).toBe(before)
  })

  it('順番の敵の記憶は JSON で往復できる（スナップショット）', () => {
    const s = stateOf([ent({ actions: ['順番=ink > tent > sub'] })])
    step(s, 0, () => 0)
    step(s, 0, () => 0)
    const restored = JSON.parse(JSON.stringify(s)) as BattleState
    expect(chooseEnemyAction(restored, 0, () => 0)).toMatchObject({ skillId: 'sub' })
  })
})

describe('上限=・回数>=・周期・使用<>・状態', () => {
  it('上限=N: 使い切った行は成立しない扱いで次の行へ落ちる', () => {
    const s = stateOf([ent({ actions: ['候補=ink 上限=2', '候補=tent'] })])
    const out = Array.from({ length: 4 }, () => step(s, 0, () => 0))
    expect(skillIds(out)).toEqual(['ink', 'ink', 'tent', 'tent'])
    expect(s.enemyMemory![0].ruleUses).toEqual({ '0': 2, '1': 2 })
  })

  it('回数>=N は行動回数（acted）で判定する', () => {
    const s = stateOf([ent({ actions: ['条件=回数>=2 候補=ink'] })])
    expect(chooseEnemyAction(s, 0, () => 0).kind).toBe('attack')
    s.enemyMemory![0].acted = 2
    expect(chooseEnemyAction(s, 0, () => 0)).toMatchObject({ skillId: 'ink' })
  })

  it('周期=3: acted が 0,3,6 のとき成立。周期=3/2 は 2,5,8', () => {
    const a = stateOf([ent({ actions: ['条件=周期=3 候補=ink'] })])
    const b = stateOf([ent({ actions: ['条件=周期=3/2 候補=ink'] })])
    const hits = (s: BattleState) =>
      Array.from({ length: 9 }, (_, n) => {
        s.enemyMemory![0].acted = n
        return chooseEnemyAction(s, 0, () => 0).kind === 'skill'
      })
        .map((v, n) => (v ? n : -1))
        .filter((n) => n >= 0)
    expect(hits(a)).toEqual([0, 3, 6])
    expect(hits(b)).toEqual([2, 5, 8])
  })

  it('使用<ink>>=1: 使ったあとだけ成立（1 度きり技のあとの行動）', () => {
    const s = stateOf([ent({ actions: ['条件=使用<ink>>=1 候補=tent', '候補=ink'] })])
    expect(skillIds([step(s, 0, () => 0), step(s, 0, () => 0), step(s, 0, () => 0)])).toEqual([
      'ink',
      'tent',
      'tent',
    ])
  })

  it('状態=（自分）と 味方状態=（生存している味方のいずれか）。日本語名と英語名のどちらでも一致', () => {
    const party = [ent({ id: 'a' }), ent({ id: 'b', status: { sleep: 2 } })]
    const s = stateOf(
      [ent({ actions: ['条件=味方状態=眠り 候補=ink', '条件=状態=毒 候補=tent'] })],
      party
    )
    expect(chooseEnemyAction(s, 0, () => 0)).toMatchObject({ skillId: 'ink' })
    party[1].hp = 0 // 倒れた味方は数えない
    expect(chooseEnemyAction(s, 0, () => 0).kind).toBe('attack')
    s.enemies[0].status = { 毒: 1 }
    expect(chooseEnemyAction(s, 0, () => 0)).toMatchObject({ skillId: 'tent' })
    s.enemies[0].status = { poison: 0 } // 残り 0 は無し
    expect(chooseEnemyAction(s, 0, () => 0).kind).toBe('attack')
  })

  it('行の 予兆= は選択結果に載る', () => {
    const s = stateOf([ent({ actions: ['順番=ink > tent 予兆=ふるえている'] })])
    expect(chooseEnemyAction(s, 0, () => 0)).toMatchObject({ omen: 'ふるえている' })
  })
})

describe('P1 までの敵は記憶の形も rng も不変', () => {
  it('P2 の語彙を使わない敵は track を付けず、記憶は { acted } のまま', () => {
    const s = stateOf([ent({ actions: ['条件=初手 候補=ink', '候補=tent:1 | ink:1'] })])
    const r = countingRng(0.1)
    const c = step(s, 0, r.rng)
    expect(c).toEqual({ kind: 'skill', skillId: 'ink' })
    expect(s.enemyMemory).toEqual([{ acted: 1 }])
    step(s, 0, r.rng)
    expect(s.enemyMemory).toEqual([{ acted: 2 }])
    expect(r.calls()).toBe(1) // 2 行目の重み抽選 1 回だけ
  })
})
