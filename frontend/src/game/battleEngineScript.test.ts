/** 戦闘エンジンの脚本制御: 勝敗固定・戦闘中の台詞・参戦・復活・逃走・中断・結果の受け渡し (#741 / #863) */
import { describe, expect, it, vi } from 'vitest'
import {
  ATB_GAUGE_MAX,
  BattleEngine,
  type BattleEngineOptions,
  type SkillExecution,
} from './battleEngine'
import type { BattleEntity } from './spellDsl'
import { applyDamageToHp, knockOutHp } from './battleLimits'

function ent(over: Partial<BattleEntity> = {}): BattleEntity {
  return {
    id: 'e',
    name: 'E',
    hp: 100,
    maxHp: 100,
    mp: 9,
    maxMp: 9,
    atk: 5,
    def: 1,
    agi: 2,
    exp: 5,
    gold: 3,
    ...over,
  }
}
const hero = (over: Partial<BattleEntity> = {}): BattleEntity =>
  ent({
    id: 'hero',
    name: 'ゆうしゃ',
    hp: 20,
    maxHp: 20,
    atk: 10,
    exp: undefined,
    gold: undefined,
    ...over,
  })
const boss = (over: Partial<BattleEntity> = {}): BattleEntity =>
  ent({ id: 'boss', name: 'ボス', hp: 100, maxHp: 100, atk: 12, ...over })

/** 乱数を固定（呼ばれた回数も数える） */
function counted(value = 0.5) {
  let n = 0
  return { rng: () => (n++, value), calls: () => n }
}

function make(
  party: BattleEntity[],
  enemies: BattleEntity[],
  rules: string[],
  opts: Partial<BattleEngineOptions> = {},
  joiners?: Record<string, BattleEntity>
) {
  return new BattleEngine(party, enemies, {
    rng: () => 0.5,
    ...opts,
    script: { id: 'test', rules, ...(joiners ? { joiners } : {}) },
  })
}

const last = <T>(a: readonly T[]): T | undefined => a[a.length - 1]

/** 終わるまで攻撃し続ける（上限つき）。終わらなければ null */
function playOut(e: BattleEngine, limit = 300): number | null {
  for (let i = 0; i < limit; i++) {
    if (e.isOver()) return i
    e.selectAttack()
  }
  return e.isOver() ? limit : null
}

describe('script を渡さない戦闘は従来どおり', () => {
  it('state.script・hpFloor が無く、結果にも script が付かない', () => {
    const e = new BattleEngine([hero()], [boss({ hp: 1 })], { rng: () => 0.5 })
    e.selectAttack()
    expect(e.getState().script).toBeUndefined()
    expect(e.getResult()?.script).toBeUndefined()
    expect('script' in (e.getResult() ?? {})).toBe(false)
    expect(Object.keys(e.getState().party[0])).not.toContain('hpFloor')
  })

  it('ルールが空の script でも、ログ・HP・乱数の消費は script なしと同じ（state.script だけが増える）', () => {
    const run = (withScript: boolean) => {
      const c = counted(0.37)
      const party = [hero({ atk: 8 })]
      const enemies = [boss({ hp: 60, atk: 9 })]
      const e = withScript
        ? make(party, enemies, [], { rng: c.rng })
        : new BattleEngine(party, enemies, { rng: c.rng })
      for (let i = 0; i < 6 && !e.isOver(); i++) e.selectAttack()
      const { script, ...rest } = e.getState() as Record<string, unknown>
      return { rest, script, calls: c.calls() }
    }
    const a = run(false)
    const b = run(true)
    expect(b.rest).toEqual(a.rest)
    expect(b.calls).toBe(a.calls)
    expect(a.script).toBeUndefined()
    expect(b.script).toBeDefined()
  })
})

describe('勝敗の固定 (固定:)', () => {
  it('勝利: 味方は倒れず、上限ターンで勝利になり、報酬は通常の勝利と同じ', () => {
    // 敵が強く、味方は 1 撃で倒れるはずの HP
    const e = make(
      [hero({ hp: 3, maxHp: 3 })],
      [boss({ atk: 999 })],
      ['固定: 結果=勝利 上限ターン=4']
    )
    expect(playOut(e)).not.toBeNull()
    const st = e.getState()
    expect(st.phase).toBe('victory')
    expect(st.party[0].hp).toBe(1)
    expect(st.script?.turn).toBe(4)
    const r = e.getResult()
    expect(r?.outcome).toBe('victory')
    expect(r?.exp).toBe(5)
    expect(r?.gold).toBe(3)
  })

  it('勝利固定でも、敵を先に倒せば普通に勝利', () => {
    const e = make([hero({ atk: 999 })], [boss({ hp: 5 })], ['固定: 結果=勝利 上限ターン=50'])
    expect(playOut(e)).toBe(1)
    expect(e.getState().phase).toBe('victory')
    expect(e.getState().script?.turn).toBe(0) // 1 ターン目の途中で決着（敵の手番まで進まない）
  })

  it('敗北: 敵は倒れず、上限ターンで敗北になる。報酬は 0', () => {
    const e = make(
      [hero({ atk: 999, hp: 999, maxHp: 999 })],
      [boss({ hp: 5, maxHp: 5, atk: 0 })],
      ['固定: 結果=敗北 上限ターン=3']
    )
    expect(playOut(e)).not.toBeNull()
    const st = e.getState()
    expect(st.phase).toBe('defeat')
    expect(st.enemies[0].hp).toBe(1)
    expect(st.script?.turn).toBe(3)
    expect(e.getResult()).toMatchObject({ outcome: 'defeat', exp: 0, gold: 0 })
  })

  it('敗北固定でも、味方が先に全滅すれば普通に敗北（上限ターン前）', () => {
    const e = make(
      [hero({ hp: 1, maxHp: 1 })],
      [boss({ atk: 999 })],
      ['固定: 結果=敗北 上限ターン=50']
    )
    playOut(e)
    expect(e.getState().phase).toBe('defeat')
    expect(e.getState().script?.turn).toBeLessThan(50)
  })

  it('中断: 両陣営とも倒れず、上限ターンで interrupted。経験値・ゴールドは 0', () => {
    const e = make(
      [hero({ atk: 999 })],
      [boss({ hp: 10, maxHp: 10, atk: 999 })],
      ['固定: 結果=中断 上限ターン=2']
    )
    expect(playOut(e)).not.toBeNull()
    const st = e.getState()
    expect(st.phase).toBe('interrupted')
    expect(e.isOver()).toBe(true)
    expect(st.party[0].hp).toBe(1)
    expect(st.enemies[0].hp).toBe(1)
    expect(e.getResult()).toMatchObject({ outcome: 'interrupted', exp: 0, gold: 0 })
  })

  it('上限ターンの境界: 1 ならちょうど 1 ターンで終わる', () => {
    const e = make([hero()], [boss()], ['固定: 結果=中断 上限ターン=1'])
    e.selectAttack()
    expect(e.getState().phase).toBe('interrupted')
    expect(e.getState().script?.turn).toBe(1)
  })

  it('上限ターンを省略しても有限（既定 99）で必ず終わる', () => {
    const e = make(
      [hero({ atk: 0, hp: 9999, maxHp: 9999 })],
      [boss({ atk: 0 })],
      ['固定: 結果=中断']
    )
    expect(playOut(e, 200)).toBe(99)
    expect(e.getState().phase).toBe('interrupted')
  })

  it('強制終了（勝利）では後始末として終了後の入力は無効', () => {
    const e = make([hero()], [boss()], ['固定: 結果=勝利 上限ターン=1'])
    e.selectAttack()
    expect(e.getState().phase).toBe('victory')
    const logs = e.getState().logTotal
    e.selectAttack()
    e.selectEscape()
    expect(e.getState().logTotal).toBe(logs)
  })
})

describe('戦闘中の台詞', () => {
  it('開始の台詞は「あらわれた」のあとにログと notice(line) で出て、1 回だけ', () => {
    const e = make([hero()], [boss()], ['台詞: 条件=開始 話者=ボス 文=かかってこい'])
    const st = e.getState()
    expect(st.log[0]).toBe('ボス が あらわれた！')
    expect(st.log[1]).toBe('ボス「かかってこい」')
    expect(st.events).toHaveLength(1)
    expect(st.events[0]).toMatchObject({
      kind: 'notice',
      label: 'ボス「かかってこい」',
      line: true,
      hits: [],
    })
    e.selectAttack()
    expect(e.getState().log.filter((l) => l === 'ボス「かかってこい」')).toHaveLength(1)
  })

  it('ターン経過の台詞は、そのターンが進んだあとに 1 回だけ。話者なしは地の文', () => {
    const e = make([hero()], [boss()], ['台詞: 条件=ターン>=2 文=地面が ゆれはじめた'])
    e.selectAttack()
    expect(e.getState().log).not.toContain('地面が ゆれはじめた')
    e.selectAttack()
    expect(e.getState().log).toContain('地面が ゆれはじめた')
    const n = e.getState().log.filter((l) => l === '地面が ゆれはじめた').length
    e.selectAttack()
    expect(e.getState().log.filter((l) => l === '地面が ゆれはじめた')).toHaveLength(n)
  })

  it('HP の条件の台詞（敵の HP が半分以下）', () => {
    const e = make(
      [hero({ atk: 30 })],
      [boss({ hp: 100, maxHp: 100, def: 0 })],
      ['台詞: 条件=HP[boss]<=50% 話者=ボス 文=ぐ……']
    )
    const hasLine = () => e.getState().log.includes('ボス「ぐ……」')
    e.selectAttack()
    expect(e.getState().enemies[0].hp).toBeGreaterThan(50)
    expect(hasLine()).toBe(false)
    e.selectAttack()
    expect(e.getState().enemies[0].hp).toBeLessThanOrEqual(50)
    expect(hasLine()).toBe(true)
  })

  it('同じ条件で複数の台詞は宣言順に出る', () => {
    const e = make([hero()], [boss()], ['台詞: 文=一', '台詞: 文=二', '台詞: 文=三'])
    expect(e.getState().log.slice(1)).toEqual(['一', '二', '三'])
  })
})

describe('途中参戦', () => {
  const ally = () =>
    ent({
      id: 'ally',
      name: 'おさななじみ',
      hp: 30,
      maxHp: 30,
      atk: 9,
      agi: 10,
      exp: undefined,
      gold: undefined,
    })

  it('主人公の HP が 1 になった時点で、味方が末尾に加わる（下限 1 で倒れない）', () => {
    const e = make(
      [hero({ hp: 5, maxHp: 5 })],
      [boss({ atk: 50 })],
      [
        '下限: 対象=hero HP=1 条件=!参戦[ally]',
        '参戦: 条件=HP[hero]<=1 対象=ally 文=おさななじみが とびこんできた！',
      ],
      {},
      { ally: ally() }
    )
    e.selectAttack()
    const st = e.getState()
    expect(st.party.map((p) => p.id)).toEqual(['hero', 'ally'])
    expect(st.script?.joined).toEqual(['ally'])
    expect(st.log).toContain('おさななじみが とびこんできた！')
    expect(st.party[0].hp).toBe(1)
    expect(st.phase).toBe('party-input')
  })

  it('参戦後は下限が外れ、主人公は倒れうる（味方が残っていれば戦闘は続く）', () => {
    const e = make(
      [hero({ hp: 5, maxHp: 5 })],
      [boss({ atk: 50 })],
      ['下限: 対象=hero HP=1 条件=!参戦[ally]', '参戦: 条件=HP[hero]<=1 対象=ally'],
      {},
      { ally: ally() }
    )
    e.selectAttack()
    expect(e.getState().party[0].hpFloor).toBeUndefined()
    e.selectAttack()
    expect(e.getState().party[0].hp).toBe(0)
    expect(e.isOver()).toBe(false) // ally が残っている
  })

  it('渡した joiners は複製して使い、渡した側の値を書き換えない。加わった味方も戦闘ごとに別', () => {
    const src = ally()
    const mk = () =>
      make(
        [hero({ hp: 5, maxHp: 5 })],
        [boss({ atk: 50 })],
        ['参戦: 条件=HP[hero]<=1 対象=ally'],
        {},
        { ally: src }
      )
    const a = mk()
    const b = mk()
    a.selectAttack()
    a.selectAttack()
    const allyA = a.getState().party[1]
    expect(allyA).not.toBe(src)
    expect(src.hp).toBe(30)
    b.selectAttack()
    expect(b.getState().party[1]).not.toBe(allyA)
  })

  it('すでに味方にいる id・渡されていない id は何もしない（後者は警告を 1 度だけ）', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const e = make([hero()], [boss({ atk: 0 })], ['参戦: 対象=hero', '参戦: 対象=ghost'])
    expect(e.getState().party).toHaveLength(1)
    e.selectAttack()
    e.selectAttack()
    expect(e.getState().party).toHaveLength(1)
    expect(e.getState().script?.fired).toEqual([0, 1])
    expect(warn.mock.calls.filter((c) => String(c[0]).includes('ghost'))).toHaveLength(1)
    warn.mockRestore()
  })

  it('ATB: ゲージが増え、参戦した味方は自分のゲージが溜まるとコマンド待ちに並ぶ', () => {
    const e = make(
      [hero({ hp: 5, maxHp: 5, agi: 10 })],
      [boss({ atk: 6, agi: 10 })],
      ['下限: 対象=hero HP=1', '参戦: 条件=HP[hero]<=1 対象=ally'],
      { atb: { mode: 'active' } },
      { ally: ally() }
    )
    let guard = 0
    while (e.getState().script?.joined.length === 0 && guard++ < 400) {
      if (e.getState().phase === 'party-input') e.selectAttack()
      else e.tick(200)
    }
    expect(e.getState().script?.joined).toEqual(['ally'])
    const atb = e.getState().atb
    expect(atb?.partyGauge).toHaveLength(2)
    // 参戦した直後のゲージは満タンでなく（0 から溜まり始める）、時間が経てば満タンになってコマンド待ちに並ぶ
    expect(atb?.partyGauge[1]).toBeLessThan(ATB_GAUGE_MAX)
    expect(atb?.queue).not.toContain(1)
    for (let i = 0; i < 400 && !e.getState().atb?.queue.includes(1); i++) {
      if (e.getState().phase === 'party-input') {
        // hero のコマンド待ちは攻撃で消化する（active は時間が止まらないので ally のゲージも進む）
        if (e.getCurrentActorIndex() === 0) e.selectAttack()
        else break
      } else e.tick(200)
    }
    expect(e.getState().atb?.queue.includes(1)).toBe(true)
  })
})

describe('HP0 からの復活', () => {
  const rules = ['復活: 条件=倒れた[hero] 対象=hero HP=50% 文=ほのおが よみがえらせた']

  it('唯一の味方が HP0 になっても全滅にならず、指定の HP で復活する。一度きり', () => {
    const e = make([hero({ hp: 4, maxHp: 20 })], [boss({ atk: 50 })], rules)
    e.selectAttack()
    const st = e.getState()
    expect(st.phase).toBe('party-input')
    expect(st.party[0].hp).toBe(10)
    expect(st.log).toContain('ほのおが よみがえらせた')
    expect(st.log).not.toContain('ぜんめつ してしまった……')
    // 復活は heal のヒット付きの notice
    const ev = st.events.find((x) => x.line && x.hits.length > 0)
    expect(ev?.hits[0]).toMatchObject({ kind: 'heal', amount: 10, hpBefore: 0, hpAfter: 10 })
    // 2 度目に倒れたら今度こそ敗北
    playOut(e)
    expect(e.getState().phase).toBe('defeat')
  })

  it('既定は全回復。HP 指定の下限は 1', () => {
    const e = make([hero({ hp: 1, maxHp: 20 })], [boss({ atk: 50 })], ['復活: 対象=hero'])
    e.selectAttack()
    expect(e.getState().party[0].hp).toBe(20)
    const e2 = make([hero({ hp: 1, maxHp: 20 })], [boss({ atk: 50 })], ['復活: 対象=hero HP=0%'])
    e2.selectAttack()
    expect(e2.getState().party[0].hp).toBe(1)
  })

  it('MP の回復と、宣言した状態の付与（持続は宣言のとおり）', () => {
    const e = make(
      [hero({ hp: 1, maxHp: 20, mp: 0, maxMp: 10 })],
      [boss({ atk: 50 })],
      ['復活: 対象=hero MP=100% 付与=blessing'],
      { statuses: { blessing: { id: 'blessing', name: 'かご', duration: '3' } } }
    )
    e.selectAttack()
    const m = e.getState().party[0]
    expect(m.mp).toBe(10)
    expect(m.status).toEqual({ blessing: 3 })
  })

  it('味方が複数いて 1 人が倒れた場合も、その人だけが復活する（ほかは触らない）', () => {
    const e = make(
      [hero({ hp: 1, maxHp: 20 }), ent({ id: 'b', name: 'B', hp: 9, maxHp: 9, exp: undefined })],
      [boss({ atk: 50 })],
      ['復活: 対象=hero HP=50%']
    )
    e.selectAttack()
    const st = e.getState()
    expect(st.party[0].hp).toBe(10)
    expect(st.party[1].hp).toBeLessThanOrEqual(9)
  })

  it('復活後の ATB: ゲージは 0 から溜まり直し、全滅判定は走らない', () => {
    const e = make(
      [hero({ hp: 1, maxHp: 20, agi: 10 })],
      [boss({ atk: 50, agi: 10 })],
      ['復活: 対象=hero'],
      {
        atb: { mode: 'active' },
      }
    )
    for (let i = 0; i < 400 && !e.getState().script?.fired.includes(0); i++) {
      if (e.getState().phase === 'party-input') e.selectAttack()
      else e.tick(200)
    }
    // 倒れて復活した（全滅していない）。復活した本人のゲージは 0 から溜まり直す
    const st = e.getState()
    expect(st.script?.fired).toContain(0)
    expect(st.phase).not.toBe('defeat')
    expect(st.party[0].hp).toBe(20)
    expect(st.atb?.partyGauge[0]).toBeLessThan(ATB_GAUGE_MAX)
    expect(st.atb?.queue).not.toContain(0)
  })
})

describe('逃げるイベントバトル (逃走: + 下限:)', () => {
  const rules = [
    '下限: 対象=cell HP=1',
    '逃走: 条件=倒れた[guard] 対象=cell 文=エラーさいぼうは にげだした！',
  ]
  const cell = () =>
    ent({ id: 'cell', name: 'エラー細胞', hp: 3, maxHp: 3, atk: 0, exp: 100, gold: 100 })
  const guard = () =>
    ent({ id: 'guard', name: '中ボス', hp: 10, maxHp: 10, atk: 1, exp: 20, gold: 8 })

  it('倒せない敵は盾役が倒れるまで残り、そのあと逃げて、勝利になる（逃げた敵の経験値・ゴールドは入らない）', () => {
    const e = make([hero({ atk: 50, hp: 999, maxHp: 999 })], [guard(), cell()], rules)
    // 先に cell を殴っても倒れない
    for (let i = 0; i < 3; i++) e.selectAttack('cell')
    expect(e.getState().enemies[1].hp).toBe(1)
    expect(e.isOver()).toBe(false)
    e.selectAttack('guard')
    const st = e.getState()
    expect(st.phase).toBe('victory')
    expect(st.log).toContain('エラーさいぼうは にげだした！')
    expect(st.script?.fled).toEqual([1])
    expect(st.earnedExp).toBe(20)
    expect(st.earnedGold).toBe(8)
  })

  it('逃げた敵はドロップしない', () => {
    const c = cell()
    c.loot = { drops: ['rare-thing'] }
    const e = make([hero({ atk: 50, hp: 999, maxHp: 999 })], [guard(), c], rules)
    e.selectAttack('guard')
    expect(e.getState().phase).toBe('victory')
    expect(e.getState().loot).toBeUndefined()
  })

  it('開始時に成立した逃走で敵が全員いなくなれば、その場で勝利になる（進行不能にならない）', () => {
    const e = make([hero({ atk: 999 })], [boss({ hp: 1, maxHp: 1 })], ['逃走: 対象=boss'])
    expect(e.getState().enemies[0].hp).toBe(0)
    expect(e.getState().script?.fled).toEqual([0])
    expect(e.getState().phase).toBe('victory')
    // 逃げた敵の経験値・ゴールドは入らない
    expect(e.getResult()).toMatchObject({ outcome: 'victory', exp: 0, gold: 0 })
  })

  it('逃走の対象がすでに倒れていれば発動しない（保留のまま）', () => {
    const e = make(
      [hero({ atk: 999 })],
      [boss({ hp: 5, maxHp: 5 }), boss({ id: 'cell', hp: 5, maxHp: 5 })],
      ['逃走: 条件=ターン>=1 対象=boss']
    )
    e.selectAttack('boss') // boss を倒す
    expect(e.getState().enemies[0].hp).toBe(0)
    e.selectAttack('cell')
    expect(e.getState().script?.fled).toEqual([])
    expect(e.getState().phase).toBe('victory')
  })
})

describe('ターンの終わりの逃走で敵が全員いなくなる（進行不能にしない）', () => {
  it('従来ターン制: 敵の手番のあとの脚本ステップで全員逃げたら、そのまま勝利になる', () => {
    const e = make(
      [hero({ atk: 0 })],
      [boss({ hp: 99999, maxHp: 99999, atk: 0 })],
      ['逃走: 条件=ターン>=1 対象=boss']
    )
    e.selectAttack()
    expect(e.getState().phase).toBe('victory')
    expect(e.getState().script?.fled).toEqual([0])
  })
})

describe('にげる: 不可', () => {
  it('にげても何も起きない（ターンも乱数も使わない・連打しても進行しない）', () => {
    const c = counted()
    const e = make([hero()], [boss()], ['にげる: 不可'], { rng: c.rng })
    const before = JSON.stringify(e.getState().script)
    for (let i = 0; i < 5; i++) e.selectEscape()
    expect(c.calls()).toBe(0)
    expect(JSON.stringify(e.getState().script)).toBe(before)
    expect(e.getState().phase).toBe('party-input')
    expect(e.getState().log.filter((l) => l === 'にげられない！')).toHaveLength(5)
    expect(last(e.getState().events)).toMatchObject({ kind: 'notice', label: 'にげられない！' })
  })

  it('可（既定）は従来どおり逃げられる。逃走時の結果が返る', () => {
    const e = make([hero()], [boss()], ['逃走時: フラグ=ran=true 次=after_run'], { rng: () => 0 })
    e.selectEscape()
    expect(e.getResult()).toMatchObject({
      outcome: 'escaped',
      script: { id: 'test', flags: { ran: true }, next: 'after_run' },
    })
  })
})

describe('結果の受け渡し (BattleResult.script)', () => {
  it('勝利・敗北・中断それぞれの結果フラグと次のイベントを返す。宣言が無い終わり方は空のフラグで脚本の戦闘だと伝える', () => {
    const rules = [
      '勝利時: フラグ=won=true, hits=3 次=after_win',
      '敗北時: フラグ=lost=true 次=after_lose',
      '中断時: フラグ=cut="quake"',
    ]
    const win = make([hero({ atk: 999 })], [boss({ hp: 1 })], rules)
    win.selectAttack()
    expect(win.getResult()).toMatchObject({
      outcome: 'victory',
      script: { id: 'test', flags: { won: true, hits: 3 }, next: 'after_win' },
    })

    const lose = make([hero({ hp: 1, maxHp: 1 })], [boss({ atk: 999 })], rules)
    lose.selectAttack()
    expect(lose.getResult()?.script).toEqual({
      id: 'test',
      flags: { lost: true },
      next: 'after_lose',
    })

    const cut = make([hero()], [boss()], [...rules, '終了: 条件=ターン>=1 結果=中断'])
    cut.selectAttack()
    expect(cut.getResult()?.script).toEqual({ id: 'test', flags: { cut: 'quake' } })

    const bare = make([hero({ atk: 999 })], [boss({ hp: 1 })], [])
    bare.selectAttack()
    expect(bare.getResult()?.script).toEqual({ id: 'test', flags: {} })
  })

  it('結果は終わるまで null。返したフラグを書き換えても次の呼び出しに影響しない', () => {
    const e = make([hero({ atk: 999 })], [boss({ hp: 1 })], ['勝利時: フラグ=a=1'])
    expect(e.getResult()).toBeNull()
    e.selectAttack()
    const r1 = e.getResult()
    ;(r1?.script?.flags as Record<string, unknown>).a = 99
    expect(e.getResult()?.script?.flags).toEqual({ a: 1 })
  })
})

describe('終了: ルール（任意の条件での強制終了）', () => {
  it('条件が成立した瞬間に、指定の結果で終わる（敗北・勝利も）。文は終了の前に出る', () => {
    const e = make([hero()], [boss()], ['終了: 条件=HP[boss]<=100 結果=敗北 文=がくり'])
    expect(e.getState().phase).toBe('defeat')
    expect(e.getState().log.slice(-2)).toEqual(['がくり', 'ぜんめつ してしまった……'])
    const v = make([hero()], [boss()], ['終了: 条件=開始 結果=勝利'])
    expect(v.getState().phase).toBe('victory')
    expect(v.getResult()?.exp).toBe(5)
  })

  it('ATB: tick の中でも強制終了する', () => {
    const e = make(
      [hero({ agi: 10 })],
      [boss({ agi: 10, atk: 0 })],
      ['終了: 条件=ターン>=2 結果=中断'],
      {
        atb: { mode: 'active' },
      }
    )
    for (let i = 0; i < 400 && !e.isOver(); i++) {
      if (e.getState().phase === 'party-input') e.selectAttack()
      else e.tick(200)
    }
    expect(e.getState().phase).toBe('interrupted')
    expect(e.getState().script?.turn).toBe(2)
  })
})

describe('HP の下限 (hpFloor)', () => {
  it('applyDamageToHp / knockOutHp は下限を尊重する。下限未満の者は上げも下げもしない。下限が無ければ従来どおり', () => {
    const a = { hp: 10, hpFloor: 3 }
    expect(applyDamageToHp(a, 100)).toBe(100)
    expect(a.hp).toBe(3)
    const b = { hp: 0, hpFloor: 3 }
    applyDamageToHp(b, 5)
    expect(b.hp).toBe(0)
    const c = { hp: 10 }
    applyDamageToHp(c, 100)
    expect(c.hp).toBe(0)
    const d = { hp: 10, hpFloor: 3 }
    expect(knockOutHp(d)).toBe(false)
    expect(d.hp).toBe(3)
    const f = { hp: 2, hpFloor: 3 }
    knockOutHp(f)
    expect(f.hp).toBe(2)
    const g = { hp: 10 }
    expect(knockOutHp(g)).toBe(true)
    expect(g.hp).toBe(0)
    const h = { hp: 10, hpFloor: 0 }
    expect(knockOutHp(h)).toBe(true)
  })

  it('呪文のダメージ・即死・状態の満了でも下限で止まる', () => {
    const e = make(
      [hero({ hp: 30, maxHp: 30, atk: 0 })],
      [boss({ atk: 0, hp: 50, maxHp: 50 })],
      ['下限: 対象=boss HP=7', '終了: 条件=ターン>=99 結果=中断']
    )
    e.selectSpell({ name: 'メテオ', mp: 0, target: '敵単体', effect: 'damage 999..999' })
    expect(e.getState().enemies[0].hp).toBe(7)
    e.selectSpell({ name: 'デス', mp: 0, target: '敵単体', effect: 'damage_full' })
    expect(e.getState().enemies[0].hp).toBe(7)
    expect(e.getState().log).toContain('ボス は もちこたえた！')
    // damage_full の hit は即死ではなく数字つきのダメージ（hp は下限で止まる。即死の印は付かない）
    const ev = last(e.getState().events.filter((x) => x.kind === 'spell'))
    expect(ev?.hits[0].instantDeath).toBeUndefined()
    expect(ev?.hits[0].hpAfter).toBe(7)
  })

  it('状態の満了（戦闘不能）も下限で止まる', () => {
    const e = make(
      [hero({ hp: 30, maxHp: 30, atk: 0 })],
      [boss({ atk: 0, hp: 50, maxHp: 50 })],
      ['下限: 対象=boss HP=2', '終了: 条件=ターン>=99 結果=中断'],
      { statuses: { doom: { id: 'doom', name: '死の宣告', duration: '1', expire: '戦闘不能' } } }
    )
    e.selectSpell({ name: '宣告', mp: 0, target: '敵単体', effect: 'status doom duration=1' })
    e.selectAttack()
    e.selectAttack()
    expect(e.getState().enemies[0].hp).toBeGreaterThanOrEqual(2)
    expect(e.getState().log.join('\n')).toContain('もちこたえた')
  })

  it('敵の特技・反撃・死亡時の行動の攻撃にも効く（味方の下限）', () => {
    const skill: SkillExecution = {
      name: 'ぜんたいこうげき',
      target: '相手全体',
      effect: 'damage 999..999',
    }
    const e = make(
      [hero({ hp: 5, maxHp: 5 })],
      [boss({ atk: 0, actions: ['候補=big'] })],
      ['固定: 結果=勝利 上限ターン=3'],
      { skills: { big: skill } }
    )
    expect(playOut(e)).not.toBeNull()
    expect(e.getState().party[0].hp).toBe(1)
    expect(e.getState().phase).toBe('victory')
  })

  it('条件が偽になると下限が外れる（付け外し）。条件が真の間だけ効く', () => {
    const e = make(
      [hero({ hp: 9, maxHp: 9 })],
      [boss({ atk: 5 })],
      ['下限: 対象=hero HP=1 条件=ターン<2', '終了: 条件=ターン>=50 結果=中断']
    )
    e.selectAttack() // turn 0 → 1。下限あり
    expect(e.getState().party[0].hp).toBeGreaterThan(0)
    expect(e.getState().party[0].hpFloor).toBe(1)
    e.selectAttack() // turn 1 → 2。ここから下限なし
    expect(e.getState().party[0].hpFloor).toBeUndefined()
    e.selectAttack()
    e.selectAttack()
    expect(e.getState().party[0].hp).toBe(0)
  })
})

describe('下限をすり抜けない経路（ハーネスで見つけた穴）', () => {
  it('負値の回復（heal -N）も HP の下限で止まる。下限が無ければ従来どおり 0 まで減る', () => {
    const e = make(
      [hero({ atk: 0 })],
      [boss({ atk: 0, hp: 50, maxHp: 50 })],
      ['下限: 対象=boss HP=7', '終了: 条件=ターン>=99 結果=中断']
    )
    e.selectSpell({ name: 'くさった薬', mp: 0, target: '敵単体', effect: 'heal -999..-999' })
    expect(e.getState().enemies[0].hp).toBe(7)
    // 下限の無い者（味方）は従来どおり 0 まで減る
    const plain = new BattleEngine([hero({ atk: 0 })], [boss({ atk: 0 })], { rng: () => 0.5 })
    plain.selectSpell({ name: 'くさった薬', mp: 0, target: '味方単体', effect: 'heal -999..-999' })
    expect(plain.getState().party[0].hp).toBe(0)
  })

  it('下限未満の者の負値の回復は、引き上げも引き下げもしない（ダメージと同じ扱い）', () => {
    const e = make(
      [hero({ atk: 0 })],
      [boss({ atk: 0, hp: 3, maxHp: 50 })],
      ['下限: 対象=boss HP=7', '終了: 条件=ターン>=99 結果=中断']
    )
    e.selectSpell({ name: 'くさった薬', mp: 0, target: '敵単体', effect: 'heal -1..-1' })
    expect(e.getState().enemies[0].hp).toBe(3)
  })

  it('ATB: 同じ時刻に満タンになった味方が先に敵に倒されて復活しても、ゲージ 0 のままコマンド待ちに並ばない', () => {
    // 味方 2 人・敵 1 人がまったく同じ AGI で、同時に満タンになる。敵が主人公を倒し、脚本が復活させる
    const e = make(
      [
        hero({ hp: 1, maxHp: 20, agi: 10 }),
        ent({ id: 'b', name: 'B', hp: 99, maxHp: 99, agi: 10, exp: undefined }),
      ],
      [boss({ atk: 99, agi: 10 })],
      ['復活: 条件=倒れた[hero] 対象=hero', '終了: 条件=ターン>=40 結果=中断'],
      { atb: { mode: 'active' }, rng: () => 0 }
    )
    for (let i = 0; i < 60 && !e.isOver(); i++) {
      if (e.getState().phase === 'party-input') e.selectAttack()
      else e.tick(500)
      const atb = e.getState().atb
      for (const q of atb?.queue ?? []) {
        expect(atb?.partyGauge[q]).toBe(ATB_GAUGE_MAX)
        expect(e.getState().party[q].hp).toBeGreaterThan(0)
      }
    }
  })
})

describe('決定論と保存', () => {
  const scenario = () => {
    const rules = [
      '台詞: 条件=開始 話者=ボス 文=ふ',
      '下限: 対象=hero HP=1 条件=!参戦[ally]',
      '参戦: 条件=HP[hero]<=1 対象=ally',
      '復活: 条件=倒れた[ally] 対象=ally',
      '終了: 条件=ターン>=12 結果=中断',
      '勝利時: フラグ=w=true',
    ]
    return make(
      [hero({ hp: 12, maxHp: 12 })],
      [boss({ atk: 9 })],
      rules,
      { rng: lcgRng(7) },
      { ally: ent({ id: 'ally', name: 'A', hp: 15, maxHp: 15, exp: undefined }) }
    )
  }
  function lcgRng(seed: number): () => number {
    let s = seed >>> 0
    return () => {
      s = (s * 1664525 + 1013904223) % 4294967296
      return s / 4294967296
    }
  }

  it('同じ脚本・同じ乱数列・同じ操作なら、状態も結果も同じ', () => {
    const run = () => {
      const e = scenario()
      playOut(e)
      return JSON.stringify({ s: e.getState(), r: e.getResult() })
    }
    expect(run()).toBe(run())
  })

  it('state は JSON で往復できる（script の進行は数値・文字列・配列だけ）', () => {
    const e = scenario()
    e.selectAttack()
    const copy = JSON.parse(JSON.stringify(e.getState()))
    expect(copy.script).toEqual(e.getState().script)
    expect(Array.isArray(copy.script.fired)).toBe(true)
  })

  it('この規模の脚本でも必ず終わる（ルールは 1 回発動で、ステップは有限）', () => {
    const e = scenario()
    expect(playOut(e, 500)).not.toBeNull()
  })

  it('戦利品（#831）と脚本の結果は同じ BattleResult に両方載る', () => {
    const e = make(
      [hero({ atk: 999 })],
      [boss({ hp: 1, maxHp: 1, loot: { drops: ['potion'] } })],
      ['勝利時: フラグ=won=true 次=after']
    )
    e.selectAttack()
    const r = e.getResult()
    expect(r?.outcome).toBe('victory')
    expect(r?.loot.map((l) => l.itemId)).toEqual(['potion'])
    expect(r?.items).toEqual([{ itemId: 'potion', count: 1 }])
    expect(r?.script).toEqual({ id: 'test', flags: { won: true }, next: 'after' })
  })
})
